import { Peer, type DataConnection } from 'peerjs';
import {
  ROOM_PREFIX, generateRoomCode, peerIdToRoom, roomToPeerId, type NetPacket,
} from '../../shared/net/protocol';

export { ROOM_PREFIX, generateRoomCode, peerIdToRoom, roomToPeerId };

export interface P2PEvents {
  onReady?: (id: string) => void;
  onPeerJoin?: (peerId: string) => void;
  onPeerLeave?: (peerId: string) => void;
  onMessage?: (peerId: string, packet: NetPacket) => void;
  onPeerRtt?: (peerId: string, rttMs: number) => void;
  onError?: (err: Error) => void;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: [
      'turn:eu-0.turn.peerjs.com:3478',
      'turn:us-0.turn.peerjs.com:3478',
    ],
    username: 'peerjs',
    credential: 'peerjsp',
  },
];

const JOIN_TIMEOUT_MS = 12_000;
const PING_INTERVAL_MS = 2_000;
const MAX_HOST_RETRIES = 3;
const MAX_SIGNALING_RECONNECTS = 3;

/** Human-readable Russian description for common PeerJS / WebRTC errors. */
export function formatPeerError(err: unknown): string {
  const e = err as { type?: string; message?: string };
  switch (e?.type) {
    case 'peer-unavailable':
      return 'Комната с таким кодом не найдена или хост уже вышел';
    case 'unavailable-id':
      return 'Код комнаты уже занят, попробуйте другой';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed':
      return 'Не удалось связаться с сигнальным сервером PeerJS';
    case 'webrtc':
      return 'Ошибка WebRTC-соединения (проверьте NAT/файрвол)';
    case 'browser-incompatible':
      return 'Ваш браузер не поддерживает WebRTC';
    default:
      return e?.message || 'Неизвестная сетевая ошибка';
  }
}

/**
 * P2P WebRTC transport layer wrapping PeerJS for Host and Client connections.
 */
export class P2PTransport {
  private peer: Peer | null = null;
  private connections = new Map<string, DataConnection>();
  private peerRtts = new Map<string, number>();
  private lastSeen = new Map<string, number>();
  private hostConn: DataConnection | null = null;
  private pingInterval: number | null = null;
  private reconnectTimer: number | null = null;
  private closed = false;
  readonly isHost: boolean;
  myId = '';
  rttMs = 0;

  events: P2PEvents = {};

  constructor(isHost: boolean) {
    this.isHost = isHost;
  }

  /** Host creates a new room with a short code (retries collision automatically when code is generated). */
  async host(customCode?: string): Promise<string> {
    this.closed = false;
    let lastErr: unknown;
    const attempts = customCode ? 1 : MAX_HOST_RETRIES;
    for (let i = 0; i < attempts; i++) {
      if (this.closed) throw new Error('Транспорт закрыт');
      const code = customCode ? peerIdToRoom(roomToPeerId(customCode)) : generateRoomCode();
      try {
        return await this.tryHostOnce(code);
      } catch (err) {
        lastErr = err;
        const type = (err as { type?: string })?.type;
        if (type === 'unavailable-id' && i < attempts - 1) continue;
        throw err;
      }
    }
    throw lastErr ?? new Error('Не удалось создать комнату');
  }

  private tryHostOnce(code: string): Promise<string> {
    const fullId = roomToPeerId(code);
    this.destroyPeerOnly();

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        this.destroyPeerOnly();
        reject(err);
      };

      try {
        const peer = new Peer(fullId, {
          debug: 1,
          config: { iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 },
        });
        this.peer = peer;

        peer.on('open', (id) => {
          if (settled || this.closed || this.peer !== peer) return;
          settled = true;
          this.myId = id;
          this.attachSignalingReconnect(peer);
          this.startPingLoop();
          this.events.onReady?.(code);
          resolve(code);
        });

        peer.on('connection', (conn) => {
          if (this.closed || this.peer !== peer) {
            try { conn.close(); } catch {}
            return;
          }
          this.setupConnection(conn);
        });

        peer.on('error', (err) => {
          if (!settled) {
            fail(err);
          } else {
            this.events.onError?.(err);
          }
        });
      } catch (e) {
        fail(e);
      }
    });
  }

  /** Client joins an existing host room by room code. */
  async join(roomCode: string, timeoutMs = JOIN_TIMEOUT_MS): Promise<void> {
    const targetPeerId = roomToPeerId(roomCode);
    if (peerIdToRoom(targetPeerId).length < 2) {
      throw new Error('Введите корректный код комнаты');
    }
    this.closed = false;
    this.destroyPeerOnly();

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: number | null = window.setTimeout(() => {
        fail(new Error('Таймаут подключения к хосту. Проверьте код комнаты или сеть.'));
      }, timeoutMs);

      const clearTimer = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimer();
        this.close();
        reject(err);
      };

      try {
        const peer = new Peer({
          debug: 1,
          config: { iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 },
        });
        this.peer = peer;

        peer.on('open', (id) => {
          if (settled || this.closed || this.peer !== peer) return;
          this.myId = id;
          this.attachSignalingReconnect(peer);
          this.events.onReady?.(id);

          const conn = peer.connect(targetPeerId, { reliable: true });
          this.hostConn = conn;
          this.setupConnection(
            conn,
            () => {
              if (settled || this.closed) return;
              settled = true;
              clearTimer();
              this.startPingLoop();
              resolve();
            },
            () => {
              if (!settled) fail(new Error('Соединение с хостом закрыто до начала игры'));
            },
          );
        });

        peer.on('error', (err) => {
          if (!settled) {
            fail(err);
          } else {
            this.events.onError?.(err);
          }
        });
      } catch (e) {
        fail(e);
      }
    });
  }

  private attachSignalingReconnect(peer: Peer) {
    let attempts = 0;
    peer.on('disconnected', () => {
      if (this.closed || peer.destroyed || this.peer !== peer) return;
      if (attempts >= MAX_SIGNALING_RECONNECTS) return;
      attempts++;
      const delay = 1500 * attempts;
      if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.closed && !peer.destroyed && peer.disconnected && this.peer === peer) {
          try { peer.reconnect(); } catch {}
        }
      }, delay);
    });
    peer.on('open', () => {
      attempts = 0;
    });
  }

  private setupConnection(conn: DataConnection, onOpen?: () => void, onClosedBeforeOpen?: () => void) {
    let leftFired = false;
    const handleLeave = () => {
      if (leftFired) return;
      leftFired = true;
      const wasOpen = this.connections.get(conn.peer) === conn;
      if (wasOpen) this.connections.delete(conn.peer);
      if (this.hostConn === conn) this.hostConn = null;
      this.peerRtts.delete(conn.peer);
      this.lastSeen.delete(conn.peer);
      if (wasOpen) this.events.onPeerLeave?.(conn.peer);
      else onClosedBeforeOpen?.();
    };

    const watchIce = () => {
      const pc = conn.peerConnection;
      if (!pc) return;
      const onIceChange = () => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
          try { conn.close(); } catch {}
          handleLeave();
        }
      };
      pc.addEventListener('iceconnectionstatechange', onIceChange);
    };

    conn.on('open', () => {
      if (this.closed) {
        try { conn.close(); } catch {}
        return;
      }
      // Replace stale connection from same peer ID without dropping newer one
      const prev = this.connections.get(conn.peer);
      if (prev && prev !== conn) {
        try { prev.close(); } catch {}
      }
      this.connections.set(conn.peer, conn);
      this.lastSeen.set(conn.peer, Date.now());
      watchIce();
      this.events.onPeerJoin?.(conn.peer);
      onOpen?.();
    });

    conn.on('data', (raw: unknown) => {
      this.lastSeen.set(conn.peer, Date.now());
      if (!raw || typeof raw !== 'object' || !('kind' in raw)) return;
      const packet = raw as NetPacket;
      if (packet.kind === 'ping') {
        this.sendTo(conn.peer, { kind: 'pong', t: packet.t });
        return;
      }
      if (packet.kind === 'pong') {
        const rtt = Math.max(1, Date.now() - packet.t);
        this.peerRtts.set(conn.peer, rtt);
        if (!this.isHost && conn === this.hostConn) this.rttMs = rtt;
        this.events.onPeerRtt?.(conn.peer, rtt);
        return;
      }
      this.events.onMessage?.(conn.peer, packet);
    });

    conn.on('close', handleLeave);
    conn.on('iceStateChanged', (state) => {
      if (state === 'failed' || state === 'closed') handleLeave();
    });

    conn.on('error', (err) => {
      this.events.onError?.(err);
      if (!conn.open) handleLeave();
    });
  }

  private startPingLoop() {
    if (this.pingInterval !== null) clearInterval(this.pingInterval);
    this.pingInterval = window.setInterval(() => {
      const now = Date.now();
      for (const [id, conn] of [...this.connections]) {
        const ice = conn.peerConnection?.iceConnectionState;
        const last = this.lastSeen.get(id) ?? now;
        if (ice === 'disconnected' && now - last > 5000) {
          try { conn.close(); } catch {}
          this.connections.delete(id);
          if (this.hostConn === conn) this.hostConn = null;
          this.peerRtts.delete(id);
          this.lastSeen.delete(id);
          this.events.onPeerLeave?.(id);
        }
      }
      if (this.isHost) {
        this.broadcast({ kind: 'ping', t: now });
      } else if (this.hostConn?.open) {
        this.sendToHost({ kind: 'ping', t: now });
      }
    }, PING_INTERVAL_MS);
  }

  /** Send a packet directly to the host (from client). */
  sendToHost(packet: NetPacket) {
    if (this.hostConn && this.hostConn.open) {
      this.hostConn.send(packet);
    }
  }

  /** Send a packet to a specific peer by ID (from host or client). */
  sendTo(peerId: string, packet: NetPacket) {
    const conn = this.connections.get(peerId);
    if (conn && conn.open) {
      conn.send(packet);
    }
  }

  /** Broadcast a packet to all connected peers (from host). */
  broadcast(packet: NetPacket, exceptPeerId?: string) {
    for (const [id, conn] of this.connections) {
      if (id !== exceptPeerId && conn.open) {
        conn.send(packet);
      }
    }
  }

  getPeerRtt(peerId: string): number {
    return this.peerRtts.get(peerId) ?? 0;
  }

  /** Number of active connections. */
  get peerCount(): number {
    return this.connections.size;
  }

  private destroyPeerOnly() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch {}
      this.peer = null;
    }
  }

  close() {
    this.closed = true;
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const conn of this.connections.values()) {
      try { conn.close(); } catch {}
    }
    this.connections.clear();
    this.peerRtts.clear();
    this.lastSeen.clear();
    this.hostConn = null;
    this.destroyPeerOnly();
  }
}
