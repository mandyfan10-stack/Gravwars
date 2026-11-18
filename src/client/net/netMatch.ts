import { CombatEvent } from '../../shared/combat';
import { MatchEvent } from '../../shared/match';
import { ClientMatchSession } from './netClient';
import { HostMatchSession } from './netHost';
import { HumanLobbySeat, NetMatchDeps, SpectatorTarget, hasLineOfSight, lobbyHumans } from './netTypes';

export type { NetMatchDeps, SpectatorTarget } from './netTypes';

/**
 * Authoritative Host + Client Prediction/Interpolation coordinator for active P2P matches.
 */
export class NetMatchController {
  private readonly isHost: boolean;
  private readonly myId: string;
  private readonly humansById = new Map<string, HumanLobbySeat>();
  private readonly host?: HostMatchSession;
  private readonly client?: ClientMatchSession;

  constructor(private readonly deps: NetMatchDeps) {
    this.isHost = deps.isHost;
    this.myId = deps.myId;
    const seats = lobbyHumans(deps.lobby, deps.isHost ? deps.myId : 'host');
    for (const s of seats) this.humansById.set(s.id, s);

    if (this.isHost) {
      this.host = new HostMatchSession(deps, this.myId, deps.match.team, this.humansById, seats);
    } else {
      const firstOther = seats.find((s) => s.id !== this.myId && !s.id.startsWith('local')) ?? seats.find((s) => s.id !== this.myId);
      const hostInfo = seats.find((s) => s.name.includes('(Хост)')) ?? firstOther;
      const hostId = hostInfo?.id ?? 'host';
      this.client = new ClientMatchSession(deps, this.myId, hostId, this.humansById);
    }
  }

  /** Living remote human fighters (for SpectatorController). */
  getHumanSpectatorTargets(): SpectatorTarget[] {
    return this.host?.getSpectatorTargets() ?? this.client?.getSpectatorTargets() ?? [];
  }

  /** Forward an authoritative CombatEvent from Host to connected peers. */
  onHostCombatEvent(e: CombatEvent) {
    this.host?.onCombatEvent(e);
  }

  /** Forward an authoritative MatchEvent (crystal hit / stage blast / broken) from Host to clients. */
  onHostMatchEvent(e: MatchEvent) {
    this.host?.onMatchEvent(e);
  }

  /** Step all remote client sims on the Host (called at fixed 64Hz rate from local.onTick). */
  tickHostClients(dt: number) {
    this.host?.tick(dt);
  }

  /** Stream predicted `UserCommand` (`usercmd_t`) to host at 64Hz on non-host client. */
  onLocalTick() {
    if (this.isHost) return;
    this.client?.onLocalTick();
  }

  /** Send a chat message from local player (host relays to everyone; client sends to host). */
  sendChat(text: string) {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!clean) return;
    if (this.isHost) {
      const team = this.deps.match.team;
      const meSeat = this.deps.lobby.seats[team]?.find((s) => s?.kind === 'player' && (!s.id || s.id === this.myId));
      const meName = meSeat?.kind === 'player' ? (meSeat.name ?? 'Хост') : 'Хост';
      this.deps.transport.broadcast({ kind: 'event', data: { type: 'chat', sender: meName, team, text: clean } });
      this.deps.onChat?.(meName, clean, team);
    } else {
      this.deps.transport.sendToHost({ kind: 'action', data: { type: 'chat', text: clean } });
    }
  }

  updateFrame(dt: number, _time: number) {
    const { R, world, combat, camera, match, remotePlayers, bots, npcs } = this.deps;

    if (this.host) {
      this.host.updateFrame(dt);
    } else {
      this.client?.updateFrame(dt, bots, npcs);
    }

    remotePlayers.update(dt, camera, match.team, (pos) => hasLineOfSight(R, world, camera.position, pos, combat.notCharacter));
  }
}
