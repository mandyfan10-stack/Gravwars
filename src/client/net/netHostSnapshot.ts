import { MAX_HP } from '../../shared/combat';
import { maxCrystalHp } from '../../shared/match';
import type {
  CrystalSnapshot, RemoteCarSnapshot, RemoteNpcSnapshot, RemotePlayerSnapshot, Vec3Tuple, WorldSnapshot,
} from '../../shared/net/protocol';
import { PICKUP_RESYNC_TICKS, SnapshotScheduler, q1, q3, qQuat, qVec3 } from '../../shared/net/snapshot';
import type { TeamId } from '../../shared/teams';
import type { HumanLobbySeat, NetMatchDeps, RemoteClientSim } from './netTypes';

export interface BuiltSnapshot {
  snap: WorldSnapshot;
  players: RemotePlayerSnapshot[];
  /** True when the snapshot carries one-shot deltas (props, newly changed pickups, or match end) that should use reliable delivery. */
  reliable: boolean;
}

/**
 * Builds quantized, relevancy-throttled authoritative world snapshots for the P2P Host.
 */
export class HostSnapshotBuilder {
  private snapTick = 0;
  private lastPickupsVersion = -1;
  private readonly scheduler = new SnapshotScheduler();

  private resolveWinnerTeam(deps: NetMatchDeps): TeamId | 'draw' | null {
    const { match, map } = deps;
    if (!match.result) return null;
    if (match.result === 'win') return match.team;
    const surviving = (map.teams as TeamId[]).filter((t) => !match.isOut(t));
    return surviving.length === 1 ? surviving[0] : 'draw';
  }

  build(
    deps: NetMatchDeps,
    myId: string,
    hostTeam: TeamId,
    hostOut: boolean,
    humansById: ReadonlyMap<string, HumanLobbySeat>,
    remoteClients: ReadonlyMap<string, RemoteClientSim>,
  ): BuiltSnapshot {
    const { sim, player, match, bots, npcs, pickups, props, combat } = deps;
    this.snapTick++;
    const tick = this.snapTick;

    const hostMaxHp = player.me.maxHp ?? MAX_HP;
    const players: RemotePlayerSnapshot[] = [
      {
        id: myId,
        name: humansById.get(myId)?.name ?? 'Хост',
        team: hostTeam,
        pos: qVec3(sim.state.pos.x, sim.state.pos.y, sim.state.pos.z),
        vel: qVec3(sim.state.vel.x, sim.state.vel.y, sim.state.vel.z),
        frame: qQuat(sim.state.frame.x, sim.state.frame.y, sim.state.frame.z, sim.state.frame.w),
        yaw: q3(sim.state.yaw),
        pitch: q3(sim.state.pitch),
        hp: q1(player.me.hp),
        maxHp: hostMaxHp,
        alive: player.me.alive,
        onGround: sim.state.onGround,
        activeWeapon: player.weapons.current,
        crouching: sim.state.crouched,
        isFiring: false,
        guard: !!player.me.guard,
        stun: q1(player.me.stun ?? 0),
        out: hostOut,
        hookPos: sim.hook ? qVec3(sim.hook.anchor.x, sim.hook.anchor.y, sim.hook.anchor.z) : null,
        hookPhase: sim.hook?.phase,
      },
    ];

    const observers: Vec3Tuple[] = [];
    for (const rc of remoteClients.values()) {
      if (rc.disconnected) continue;
      const p = qVec3(rc.sim.state.pos.x, rc.sim.state.pos.y, rc.sim.state.pos.z);
      observers.push(p);
      players.push({
        id: rc.peerId,
        name: rc.name,
        team: rc.team,
        pos: p,
        vel: qVec3(rc.sim.state.vel.x, rc.sim.state.vel.y, rc.sim.state.vel.z),
        frame: qQuat(rc.sim.state.frame.x, rc.sim.state.frame.y, rc.sim.state.frame.z, rc.sim.state.frame.w),
        yaw: q3(rc.yaw),
        pitch: q3(rc.pitch),
        hp: q1(rc.target.hp),
        maxHp: rc.target.maxHp ?? MAX_HP,
        alive: rc.target.alive,
        onGround: rc.sim.state.onGround,
        activeWeapon: rc.weapons.current,
        crouching: rc.sim.state.crouched,
        isFiring: rc.firing,
        guard: !!rc.target.guard,
        stun: q1(rc.target.stun ?? 0),
        out: rc.out,
        ackSeq: rc.lastSeq,
        ackTick: rc.lastTick,
        stamina: q3(rc.sim.state.stamina),
        exhausted: rc.sim.state.exhausted,
        restT: q3(rc.sim.state.restT),
        airT: q3(rc.sim.state.airT),
        jumpHold: q3(rc.sim.state.jumpHold),
        jumpReleased: rc.sim.state.jumpReleased,
        jetpackHeat: q3(rc.sim.jetpackHeat),
        jetpackOverheatCd: q3(rc.sim.jetpackOverheatCd),
        hookPos: rc.sim.hook ? qVec3(rc.sim.hook.anchor.x, rc.sim.hook.anchor.y, rc.sim.hook.anchor.z) : null,
        hookPhase: rc.sim.hook?.phase,
      });
      rc.firing = false;
    }

    const crystals = {} as Record<TeamId, CrystalSnapshot>;
    for (const b of match.beds) {
      crystals[b.team] = {
        team: b.team,
        stage: b.stage,
        hp: q1(b.hp),
        maxHp: maxCrystalHp(),
        invulnerable: b.invulnT > 0,
        invulnT: q1(b.invulnT),
        broken: !b.alive,
      };
    }

    const npcSnaps: RemoteNpcSnapshot[] = [];
    for (const n of npcs.npcs) {
      const pos = qVec3(n.sim.state.pos.x, n.sim.state.pos.y, n.sim.state.pos.z);
      const urgent = n.fire !== 'free' || n.state === 'combat';
      if (!this.scheduler.shouldSend('npc', n.id, n.target.alive, urgent, pos, observers, tick)) continue;
      npcSnaps.push({
        id: n.id,
        kind: n.kind,
        alive: n.target.alive,
        hp: q1(n.target.hp),
        pos,
        vel: qVec3(n.sim.state.vel.x, n.sim.state.vel.y, n.sim.state.vel.z),
        frame: qQuat(n.sim.state.frame.x, n.sim.state.frame.y, n.sim.state.frame.z, n.sim.state.frame.w),
        yaw: q3(n.sim.state.yaw),
        state: n.state,
        fire: n.fire !== 'free',
        stun: q1(n.target.stun ?? 0),
        weapon: n.weapons.current,
        shotsTotal: n.shotsTotal,
        throwsTotal: n.throwsTotal,
      });
    }

    const carSnaps: RemoteCarSnapshot[] = [];
    for (const c of npcs.cars) {
      const pos = qVec3(c.pos.x, c.pos.y, c.pos.z);
      const urgent = c.state === 'crashing';
      if (!this.scheduler.shouldSend('car', c.id, c.target.alive, urgent, pos, observers, tick)) continue;
      carSnaps.push({
        id: c.id,
        alive: c.target.alive,
        hp: q1(c.target.hp),
        pos,
        vel: qVec3(c.vel.x, c.vel.y, c.vel.z),
        quat: qQuat(c.quat.x, c.quat.y, c.quat.z, c.quat.w),
        up: qVec3(c.up.x, c.up.y, c.up.z),
        yaw: q3(c.yaw),
        scale: q3(c.scale),
        color: c.color,
        state: c.state,
        crashT: q1(c.crashT),
      });
    }

    const dirtyProps = props.consumeNetDirty();
    const pickupsChanged = pickups.version !== this.lastPickupsVersion;
    const includePickups = pickupsChanged || tick % PICKUP_RESYNC_TICKS === 0;
    if (includePickups) this.lastPickupsVersion = pickups.version;
    const winnerTeam = this.resolveWinnerTeam(deps);

    const snap: WorldSnapshot = {
      tick,
      serverTime: performance.now(),
      matchTime: q3(match.time),
      windTime: q3(combat.time),
      winnerTeam,
      generators: match.generators.map((g) => g.stored),
      players,
      crystals,
      bots: bots.bots.map((b) => ({
        id: b.id,
        team: b.team,
        pos: qVec3(b.sim.state.pos.x, b.sim.state.pos.y, b.sim.state.pos.z),
        vel: qVec3(b.sim.state.vel.x, b.sim.state.vel.y, b.sim.state.vel.z),
        frame: qQuat(b.sim.state.frame.x, b.sim.state.frame.y, b.sim.state.frame.z, b.sim.state.frame.w),
        yaw: q3(b.sim.state.yaw),
        pitch: q3(b.sim.state.pitch),
        hp: q1(b.target.hp),
        alive: b.target.alive,
        out: b.out,
        onGround: b.sim.state.onGround,
        weapon: b.weapons.current,
        shotsTotal: b.shotsTotal,
        kicksTotal: b.kicksTotal,
        fishing: b.fishing,
        status: b.status,
        guard: !!b.target.guard,
        stun: q1(b.target.stun ?? 0),
      })),
      npcs: npcSnaps.length ? npcSnaps : undefined,
      cars: carSnaps.length ? carSnaps : undefined,
      props: dirtyProps.length
        ? dirtyProps.map((p) => ({
          idx: p.idx,
          pos: qVec3(p.pos[0], p.pos[1], p.pos[2]),
          quat: qQuat(p.quat[0], p.quat[1], p.quat[2], p.quat[3]),
          hp: q1(p.hp),
          present: p.present,
        }))
        : undefined,
      pickupsVersion: pickups.version,
      pickups: includePickups
        ? pickups.items.filter((p) => p.alive).map((p) => ({
          id: p.id, kind: p.kind, amount: p.amount, once: p.once,
          pos: qVec3(p.pos.x, p.pos.y, p.pos.z), up: qVec3(p.up.x, p.up.y, p.up.z), alive: p.alive,
        }))
        : undefined,
    };

    const reliable = tick === 1 || pickupsChanged || dirtyProps.length > 0 || winnerTeam !== null;
    return { snap, players, reliable };
  }
}
