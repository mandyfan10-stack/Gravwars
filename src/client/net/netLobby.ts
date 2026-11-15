import type { Difficulty } from '../../shared/bots';
import { activeTeams, LobbyConfig, playerTeam, removePlayerSeat, seatPlayer } from '../../shared/lobby';
import type { LobbyMessage, NetworkPlayerInfo } from '../../shared/net/protocol';
import { TEAMS, type TeamId } from '../../shared/teams';
import type { Lobby } from '../lobby';
import type { P2PTransport } from './p2p';

export interface NetLobbyCallbacks {
  onStartMatch: (seed: number, config: LobbyConfig, activeTeams: TeamId[], myPlayerId: string, isHost: boolean, mapTeam: TeamId) => void;
  onPlayersChange?: (players: NetworkPlayerInfo[]) => void;
  onStatusMessage?: (text: string) => void;
}

/**
 * Handles multiplayer synchronization for the pre-match lobby.
 */
export class NetLobbyController {
  players: NetworkPlayerInfo[] = [];
  myPlayerId = '';
  myName = 'Игрок';
  isHost = false;

  constructor(
    readonly net: P2PTransport,
    readonly lobby: Lobby,
    readonly callbacks: NetLobbyCallbacks
  ) {
    this.isHost = net.isHost;
    this.setupNetwork();
  }

  private setupNetwork() {
    this.net.events.onMessage = (_peerId, packet) => {
      if (packet.kind !== 'lobby') return;
      this.handleLobbyMessage(_peerId, packet.data);
    };

    if (this.isHost) {
      this.myPlayerId = this.net.myId;
      // Clear any leftover single-player seat without an id from localStorage
      for (const t of TEAMS) {
        this.lobby.config.seats[t.id] = this.lobby.config.seats[t.id].map((s) =>
          s?.kind === 'player' && !s.id ? null : s
        );
      }
      this.players = [{
        id: this.myPlayerId,
        name: this.myName + ' (Хост)',
        team: 'red',
        seatIndex: 0,
        isHost: true,
        pingMs: 0,
      }];

      // Seed local host seat
      seatPlayer(this.lobby.config, 'red', 0, this.myPlayerId, this.myName + ' (Хост)');
      this.lobby.render();

      this.net.events.onPeerJoin = (peerId) => {
        this.callbacks.onStatusMessage?.(`Игрок ${peerId.slice(-4)} подключился`);
      };

      this.net.events.onPeerLeave = (peerId) => {
        this.players = this.players.filter((p) => p.id !== peerId);
        removePlayerSeat(this.lobby.config, peerId);
        this.lobby.render();
        this.broadcastLobbyUpdate();
        this.callbacks.onPlayersChange?.(this.players);
        this.callbacks.onStatusMessage?.(`Игрок отключился`);
      };
    } else {
      // Client announces themselves on connect
      this.myPlayerId = this.net.myId;
      this.net.sendToHost({
        kind: 'lobby',
        data: { type: 'lobby:join', name: this.myName },
      });
    }
  }

  private findJoinSeat(): { team: TeamId; seatIndex: number } {
    const order: TeamId[] = ['blue', 'green', 'yellow', 'red'];
    for (const t of order) {
      const idx = this.lobby.config.seats[t].findIndex((s) => s === null);
      if (idx !== -1) return { team: t, seatIndex: idx };
    }
    for (const t of order) {
      const idx = this.lobby.config.seats[t].findIndex((s) => s?.kind === 'bot');
      if (idx !== -1) return { team: t, seatIndex: idx };
    }
    return { team: 'blue', seatIndex: 0 };
  }

  private handleLobbyMessage(peerId: string, msg: LobbyMessage) {
    if (this.isHost) {
      if (msg.type === 'lobby:join') {
        const { team: assignedTeam, seatIndex: seatIdx } = this.findJoinSeat();

        const newPlayer: NetworkPlayerInfo = {
          id: peerId,
          name: msg.name || `Игрок ${peerId.slice(-4)}`,
          team: assignedTeam,
          seatIndex: seatIdx,
          isHost: false,
          pingMs: 0,
        };

        this.players = this.players.filter((p) => p.id !== peerId).concat(newPlayer);
        seatPlayer(this.lobby.config, assignedTeam, seatIdx, peerId, newPlayer.name);
        this.lobby.render();

        // Send welcome to this client with current full state
        this.net.sendTo(peerId, {
          kind: 'lobby',
          data: {
            type: 'lobby:welcome',
            yourId: peerId,
            players: this.players,
            config: this.lobby.config,
          },
        });

        // Broadcast updated state to all
        this.broadcastLobbyUpdate();
        this.callbacks.onPlayersChange?.(this.players);
      } else if (msg.type === 'lobby:seat') {
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
    } else {
      // Client handling
      if (msg.type === 'lobby:welcome') {
        this.myPlayerId = msg.yourId;
        this.players = msg.players;
        Object.assign(this.lobby.config, msg.config);
        this.lobby.render();
        this.callbacks.onPlayersChange?.(this.players);
      } else if (msg.type === 'lobby:update') {
        this.players = msg.players;
        Object.assign(this.lobby.config, msg.config);
        this.lobby.render();
        this.callbacks.onPlayersChange?.(this.players);
      } else if (msg.type === 'lobby:start') {
        const mapTeam = msg.mapTeam ?? msg.activeTeams[0] ?? 'red';
        this.callbacks.onStartMatch(msg.seed, msg.config, msg.activeTeams, this.myPlayerId, false, mapTeam);
      }
    }
  }

  /** Client requests to sit in a team seat */
  requestSeat(team: TeamId, seatIndex: number) {
    if (this.isHost) {
      seatPlayer(this.lobby.config, team, seatIndex, this.myPlayerId, this.myName + ' (Хост)');
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
    if (!this.isHost) return;
    this.net.broadcast({
      kind: 'lobby',
      data: {
        type: 'lobby:update',
        players: this.players,
        config: this.lobby.config,
      },
    });
  }

  /** Host initiates match start for everyone */
  startMatch() {
    if (!this.isHost) return;
    const seed = Math.floor(Math.random() * 1000000);
    const active = activeTeams(this.lobby.config);
    const mapTeam = playerTeam(this.lobby.config, this.myPlayerId) ?? active[0] ?? 'red';

    this.net.broadcast({
      kind: 'lobby',
      data: {
        type: 'lobby:start',
        seed,
        config: this.lobby.config,
        activeTeams: active,
        mapTeam,
      },
    });

    this.callbacks.onStartMatch(seed, this.lobby.config, active, this.myPlayerId, true, mapTeam);
  }
}
