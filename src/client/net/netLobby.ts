import {
  activeTeams,
  canSeatPlayer,
  firstFreeSeat,
  humanTeams,
  LobbyConfig,
  playerTeam,
  removePlayerSeat,
  seatPlayer,
} from '../../shared/lobby';
import type { LobbyMessage, NetworkPlayerInfo } from '../../shared/net/protocol';
import { TEAMS, type TeamId } from '../../shared/teams';
import type { Lobby } from '../lobby';
import type { P2PTransport } from './p2p';

export interface NetLobbyCallbacks {
  onStartMatch: (
    seed: number,
    config: LobbyConfig,
    activeTeams: TeamId[],
    myPlayerId: string,
    isHost: boolean,
    mapTeam: TeamId,
    skipFortTeams: TeamId[],
  ) => void;
  onPlayersChange?: (players: NetworkPlayerInfo[]) => void;
  onStatusMessage?: (text: string, isError?: boolean) => void;
  onRejected?: (reason: string) => void;
  onHostLeave?: (reason: string) => void;
}

function cleanPlayerName(raw: string | undefined, fallback: string): string {
  const s = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || fallback;
}

/**
 * Handles multiplayer synchronization for the pre-match lobby.
 */
export class NetLobbyController {
  players: NetworkPlayerInfo[] = [];
  myPlayerId = '';
  myName: string;
  isHost = false;
  matchStarted = false;

  constructor(
    readonly net: P2PTransport,
    readonly lobby: Lobby,
    readonly callbacks: NetLobbyCallbacks,
    playerName = 'Игрок',
  ) {
    this.isHost = net.isHost;
    this.myName = cleanPlayerName(playerName, 'Игрок');
    this.setupNetwork();
  }

  private setupNetwork() {
    this.net.events.onMessage = (peerId, packet) => {
      if (packet.kind !== 'lobby') return;
      this.handleLobbyMessage(peerId, packet.data);
    };

    this.net.events.onPeerRtt = (peerId, rttMs) => {
      const p = this.players.find((pl) => pl.id === peerId);
      if (p) p.pingMs = rttMs;
    };

    if (this.isHost) {
      this.myPlayerId = this.net.myId;
      const hostTeam: TeamId = playerTeam(this.lobby.config, this.myPlayerId) ?? 'red';
      // Clear ALL previous player seats (stale local/remote seats from prior rooms or reloads)
      for (const t of TEAMS) {
        this.lobby.config.seats[t.id] = this.lobby.config.seats[t.id].map((s) =>
          s?.kind === 'player' ? null : s,
        );
      }
      const hostLabel = `${this.myName} (Хост)`;
      this.players = [{
        id: this.myPlayerId,
        name: hostLabel,
        team: hostTeam,
        seatIndex: 0,
        isHost: true,
        pingMs: 0,
      }];

      seatPlayer(this.lobby.config, hostTeam, 0, this.myPlayerId, hostLabel);
      this.lobby.render();
      this.callbacks.onPlayersChange?.(this.players);

      this.net.events.onPeerJoin = (peerId) => {
        if (!this.matchStarted) {
          this.callbacks.onStatusMessage?.(`Подключается игрок ${peerId.slice(-4)}...`);
        }
      };

      this.net.events.onPeerLeave = (peerId) => {
        const leaving = this.players.find((p) => p.id === peerId);
        this.players = this.players.filter((p) => p.id !== peerId);
        removePlayerSeat(this.lobby.config, peerId);
        this.lobby.render();
        this.broadcastLobbyUpdate();
        this.callbacks.onPlayersChange?.(this.players);
        if (leaving && !this.matchStarted) {
          this.callbacks.onStatusMessage?.(`Игрок ${leaving.name} отключился`);
        }
      };
    } else {
      this.myPlayerId = this.net.myId;
      this.net.events.onPeerLeave = () => {
        if (!this.matchStarted) {
          this.callbacks.onHostLeave?.('Хост закрыл комнату или потеряна связь');
        }
      };
      this.net.sendToHost({
        kind: 'lobby',
        data: { type: 'lobby:join', name: this.myName },
      });
    }
  }

  private findJoinSeat() {
    return firstFreeSeat(this.lobby.config, ['blue', 'green', 'yellow', 'red']);
  }

  private handleLobbyMessage(peerId: string, msg: LobbyMessage) {
    if (this.isHost) {
      if (msg.type === 'lobby:join') {
        if (this.matchStarted) {
          this.net.sendTo(peerId, {
            kind: 'lobby',
            data: { type: 'lobby:rejected', reason: 'Матч уже идёт, присоединиться нельзя' },
          });
          return;
        }
        const seat = this.findJoinSeat();
        if (!seat) {
          this.net.sendTo(peerId, {
            kind: 'lobby',
            data: { type: 'lobby:rejected', reason: 'Комната переполнена (нет свободных мест)' },
          });
          return;
        }

        const safeName = cleanPlayerName(msg.name, `Игрок ${peerId.slice(-4)}`);
        const newPlayer: NetworkPlayerInfo = {
          id: peerId,
          name: safeName,
          team: seat.team,
          seatIndex: seat.seatIndex,
          isHost: false,
          pingMs: this.net.getPeerRtt(peerId),
        };

        this.players = this.players.filter((p) => p.id !== peerId).concat(newPlayer);
        seatPlayer(this.lobby.config, seat.team, seat.seatIndex, peerId, safeName);
        this.lobby.render();

        this.net.sendTo(peerId, {
          kind: 'lobby',
          data: {
            type: 'lobby:welcome',
            yourId: peerId,
            players: this.players,
            config: this.lobby.config,
          },
        });

        this.broadcastLobbyUpdate();
        this.callbacks.onPlayersChange?.(this.players);
        this.callbacks.onStatusMessage?.(`Игрок ${safeName} вошёл в комнату (${this.players.length})`);
      } else if (msg.type === 'lobby:name') {
        if (this.matchStarted) return;
        const p = this.players.find((pl) => pl.id === peerId);
        if (!p) return;
        p.name = cleanPlayerName(msg.name, `Игрок ${peerId.slice(-4)}`);
        const s = this.lobby.config.seats[p.team]?.[p.seatIndex];
        if (s?.kind === 'player' && s.id === peerId) s.name = p.name;
        this.lobby.render();
        this.broadcastLobbyUpdate();
        this.callbacks.onPlayersChange?.(this.players);
      } else if (msg.type === 'lobby:seat') {
        if (this.matchStarted) return;
        if (!canSeatPlayer(this.lobby.config, msg.team, msg.seatIndex, peerId)) {
          this.net.sendTo(peerId, {
            kind: 'lobby',
            data: { type: 'lobby:update', players: this.players, config: this.lobby.config },
          });
          return;
        }
        const p = this.players.find((pl) => pl.id === peerId);
        seatPlayer(this.lobby.config, msg.team, msg.seatIndex, peerId, p?.name);
        if (p) {
          p.team = msg.team;
          p.seatIndex = msg.seatIndex;
        }
        this.lobby.render();
        this.broadcastLobbyUpdate();
        this.callbacks.onPlayersChange?.(this.players);
      }
      return;
    }

    // Client handling
    if (msg.type === 'lobby:rejected') {
      this.callbacks.onRejected?.(msg.reason);
    } else if (msg.type === 'lobby:welcome') {
      this.myPlayerId = msg.yourId;
      this.players = msg.players;
      Object.assign(this.lobby.config, msg.config);
      this.lobby.render();
      this.callbacks.onPlayersChange?.(this.players);
      this.callbacks.onStatusMessage?.(`Подключено к комнате (игроков: ${this.players.length})`);
    } else if (msg.type === 'lobby:update') {
      this.players = msg.players;
      Object.assign(this.lobby.config, msg.config);
      this.lobby.render();
      this.callbacks.onPlayersChange?.(this.players);
    } else if (msg.type === 'lobby:start') {
      this.matchStarted = true;
      const mapTeam = msg.mapTeam ?? msg.activeTeams[0] ?? 'red';
      const skipFortTeams = msg.skipFortTeams ?? humanTeams(msg.config);
      this.callbacks.onStartMatch(msg.seed, msg.config, msg.activeTeams, this.myPlayerId, false, mapTeam, skipFortTeams);
    }
  }

  /** Updates local player's nickname in the lobby before match starts. */
  setMyName(name: string) {
    this.myName = cleanPlayerName(name, 'Игрок');
    if (this.matchStarted) return;
    if (this.isHost) {
      const label = `${this.myName} (Хост)`;
      const p = this.players.find((pl) => pl.id === this.myPlayerId);
      if (p) {
        p.name = label;
        const s = this.lobby.config.seats[p.team]?.[p.seatIndex];
        if (s?.kind === 'player' && s.id === this.myPlayerId) s.name = label;
      }
      this.lobby.render();
      this.broadcastLobbyUpdate();
      this.callbacks.onPlayersChange?.(this.players);
    } else {
      this.net.sendToHost({
        kind: 'lobby',
        data: { type: 'lobby:name', name: this.myName },
      });
    }
  }

  /** Host or Client requests to sit in a team seat. */
  requestSeat(team: TeamId, seatIndex: number) {
    if (this.matchStarted) return;
    if (this.isHost) {
      if (!canSeatPlayer(this.lobby.config, team, seatIndex, this.myPlayerId)) return;
      seatPlayer(this.lobby.config, team, seatIndex, this.myPlayerId, `${this.myName} (Хост)`);
      const p = this.players.find((pl) => pl.id === this.myPlayerId);
      if (p) {
        p.team = team;
        p.seatIndex = seatIndex;
      }
      this.lobby.render();
      this.broadcastLobbyUpdate();
      this.callbacks.onPlayersChange?.(this.players);
    } else {
      this.net.sendToHost({
        kind: 'lobby',
        data: { type: 'lobby:seat', team, seatIndex },
      });
    }
  }

  broadcastLobbyUpdate() {
    if (!this.isHost || this.matchStarted) return;
    this.net.broadcast({
      kind: 'lobby',
      data: {
        type: 'lobby:update',
        players: this.players,
        config: this.lobby.config,
      },
    });
  }

  /** Host initiates match start for everyone. */
  startMatch() {
    if (!this.isHost || this.matchStarted) return;
    this.matchStarted = true;
    const seed = 1337;
    const active = activeTeams(this.lobby.config);
    const mapTeam = playerTeam(this.lobby.config, this.myPlayerId) ?? active[0] ?? 'red';
    const skipFortTeams = humanTeams(this.lobby.config);

    this.net.broadcast({
      kind: 'lobby',
      data: {
        type: 'lobby:start',
        seed,
        config: this.lobby.config,
        activeTeams: active,
        mapTeam,
        skipFortTeams,
      },
    });

    this.callbacks.onStartMatch(seed, this.lobby.config, active, this.myPlayerId, true, mapTeam, skipFortTeams);
  }
}
