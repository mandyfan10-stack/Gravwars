import { Peer, type DataConnection } from 'peerjs';
import type { NetPacket } from '../../shared/net/protocol';

export interface P2PEvents {
  onReady?: (id: string) => void;
  onPeerJoin?: (peerId: string) => void;
  onPeerLeave?: (peerId: string) => void;
  onMessage?: (peerId: string, packet: NetPacket) => void;
  onError?: (err: Error) => void;
}

/** Prefix for rooms to prevent collisions with other PeerJS applications. */
export const ROOM_PREFIX = 'gw-room-';

/** Generate a short 5-character readable room code. */
export function generateRoomCode(): string {
  const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/** Formats user-facing room code to full peer ID. */
export function roomToPeerId(code: string): string {
  const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${ROOM_PREFIX}${clean}`;
}

/** Formats peer ID back to short user room code. */
export function peerIdToRoom(peerId: string): string {
  return peerId.replace(ROOM_PREFIX, '');
}

/**
 * P2P WebRTC transport layer wrapping PeerJS for Host and Client connections.
 */
export class P2PTransport {
  private peer: Peer | null = null;
  private connections = new Map<string, DataConnection>();
  private hostConn: DataConnection | null = null;
  private pingInterval: number | null = null;
  readonly isHost: boolean;
  myId = '';
  rttMs = 0;

  events: P2PEvents = {};

  constructor(isHost: boolean) {
    this.isHost = isHost;
  }

  /**
   * Host creates a new room with a short code (or specified code).
   */
  async host(customCode?: string): Promise<string> {
    const code = customCode || generateRoomCode();
    const fullId = roomToPeerId(code);

    return new Promise((resolve, reject) => {
      try {
        this.peer = new Peer(fullId, {
          debug: 1,
        });

        this.peer.on('open', (id) => {
          this.myId = id;
          this.events.onReady?.(code);
          resolve(code);
        });

        this.peer.on('connection', (conn) => {
          this.setupConnection(conn);
        });

        this.peer.on('error', (err) => {
          this.events.onError?.(err);
          reject(err);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Client joins an existing host room by room code.
   */
  async join(roomCode: string): Promise<void> {
    const targetPeerId = roomToPeerId(roomCode);

    return new Promise((resolve, reject) => {
      try {
        this.peer = new Peer({
          debug: 1,
        });

        this.peer.on('open', (id) => {
          this.myId = id;
          this.events.onReady?.(id);

          const conn = this.peer!.connect(targetPeerId, {
            reliable: true,
          });

          this.hostConn = conn;
          this.setupConnection(conn, () => {
            this.startPingLoop();
            resolve();
          });
        });

        this.peer.on('error', (err) => {
          this.events.onError?.(err);
          reject(err);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  private setupConnection(conn: DataConnection, onOpen?: () => void) {
    conn.on('open', () => {
      this.connections.set(conn.peer, conn);
      this.events.onPeerJoin?.(conn.peer);
      onOpen?.();
    });

    conn.on('data', (raw: unknown) => {
      const packet = raw as NetPacket;
      if (packet.kind === 'ping') {
        this.sendTo(conn.peer, { kind: 'pong', t: packet.t });
        return;
      }
      if (packet.kind === 'pong') {
        this.rttMs = Math.max(1, Date.now() - packet.t);
        return;
      }
      this.events.onMessage?.(conn.peer, packet);
    });

    conn.on('close', () => {
      this.connections.delete(conn.peer);
      this.events.onPeerLeave?.(conn.peer);
    });

    conn.on('error', (err) => {
      this.events.onError?.(err);
    });
  }

  private startPingLoop() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = window.setInterval(() => {
      if (this.hostConn?.open) {
        this.sendToHost({ kind: 'ping', t: Date.now() });
      }
    }, 2000);
  }

  /** Send a packet directly to the host (from client). */
  sendToHost(packet: NetPacket) {
    if (this.hostConn && this.hostConn.open) {
      this.hostConn.send(packet);
    }
  }

  /** Send a packet to a specific peer by ID (from host). */
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

  /** Number of active connections. */
  get peerCount(): number {
    return this.connections.size;
  }

  close() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    for (const conn of this.connections.values()) {
      try { conn.close(); } catch {}
    }
    this.connections.clear();
    this.hostConn = null;
    if (this.peer) {
      try { this.peer.destroy(); } catch {}
      this.peer = null;
    }
  }
}
