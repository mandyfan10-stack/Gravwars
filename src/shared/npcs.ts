import { Quaternion, Vector3 } from 'three';
import { Combat, Noise, Target } from './combat';
import { EYE_OFFSET } from './constants';
import type { Pickups } from './economy';
import type { IslandNav, MapData, XZ } from './map';
import { Rng, upOf } from './math';
import { emptyInput, MoveInput, moveBasis } from './movement';
import type { PhysicsWorld, Rapier } from './physics';
import { PlayerSim } from './sim';
import { TeamId } from './teams';
import { createWeaponState, giveWeapon, WeaponState, weaponTick, WEAPONS } from './weapons';

export type NpcKind = 'bum' | 'gang';

/** Tuning. Times in seconds, distances in metres, speeds as a share of the player's run speed. */
export const NPC = {
  bumsPerIsland: 5,
  gangSize: 3,
  bum: {
    hp: 60,
    walk: 0.4,
    run: 0.85,
    sight: 11,
    /** Full view cone, degrees. */
    fov: 140,
    /** Seconds between drinks (random in range) and the drink itself. */
    drinkEvery: [16, 32] as [number, number],
    drinkTime: 5,
    /** Chance to go for a noticed stranger within `picky` m; otherwise leaves them alone for `grudge` s. */
    temper: 0.55,
    picky: 5,
    /** Chance that two bums meeting within 3 m start a fight. */
    brawl: 0.12,
    grudge: 30,
    /** Gives up the fight beyond this distance / after this long. */
    chase: 14,
    giveUp: 14,
    respawn: 35,
    bottleDrop: 0.4,
  },
  gang: {
    hp: 70,
    walk: 0.38,
    run: 0.9,
    sight: 24,
    fov: 110,
    /** Delay between seeing the foe and the first shot. */
    reaction: 0.7,
    spread: 0.08,
    burst: 3,
    burstPause: 1.3,
    /** Will not follow further than this from home. */
    leash: 34,
    /** Without seeing the foe this long: search the last seen spot, then go home. */
    forget: 5,
    search: 6,
    respawn: 60,
    loot: [4, 9] as [number, number],
    /** Keep this distance in a fight (closer: stand and shoot, further: walk up). */
    range: 12,
  },
  notice: {
    /** Suspicion per second at point blank, in the cone, target running. Hostile at 1. */
    rate: 1.4,
    decay: 0.22,
    /** Felt within this distance regardless of the view cone. */
    close: 2.2,
    /** Running footsteps are heard within this distance. */
    steps: 7,
    /** Visibility by how the target moves: running / quiet walk / standing. */
    run: 1,
    walk: 0.5,
    still: 0.35,
    /** Above this planar speed footsteps are loud (a quiet walk is ~3.4 m/s). */
    loud: 4.5,
    /** A crouched figure is harder to make out. */
    crouch: 0.6,
  },
  /** NPCs nobody is near are simulated this many times slower (bums still drink, bottles still drop). */
  idleStep: 8,
  /** "Near": a player or bot within this many metres. */
  liveRange: 40,
};

export type NpcState = 'wander' | 'drink' | 'fight' | 'patrol' | 'search' | 'combat' | 'dead';

export interface Npc {
  id: number;
  kind: NpcKind;
  /** Island id: a team id or 'center'. */
  island: string;
  /** Gang index on its island (bums: -1). */
  slot: number;
  sim: PlayerSim;
  target: Target;
  weapons: WeaponState;
  state: NpcState;
  stateT: number;
  /** Route along the road graph (island-local XZ) and progress. */
  route: XZ[];
  wp: number;
  /** Who it is fighting. */
  foe: Target | null;
  /** Suspicion (0..1+) per target id. */
  suspicion: Map<number, number>;
  /** Do not pick on these targets until the given time. */
  grudge: Map<number, number>;
  lastSeen: Vector3 | null;
  /** Time since the foe was last seen. */
  lostT: number;
  /** Time the foe has been in view (reaction). */
  seenT: number;
  /** Where to look / go when searching. */
  searchAt: Vector3 | null;
  /** Point to turn the head to (heard something), until `lookUntil`. */
  lookAt: Vector3 | null;
  lookUntil: number;
  drinkAt: number;
  respawnT: number;
  scanT: number;
  shots: number;
  shotsTotal: number;
  pauseT: number;
  progressT: number;
  bestDist: number;
  /** Stuck events since the last reached waypoint. */
  stuckN: number;
  jumpT: number;
  patrol: number;
  prevPos: Vector3;
  status: string;
}

const _v = new Vector3();
const _w = new Vector3();
const _up = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _inv = new Quaternion();

/** Shortest path over the road graph between two nodes (Dijkstra; the graphs have ~30 nodes). */
export function navPath(nav: IslandNav, from: number, to: number): number[] {
  const n = nav.nodes.length;
  const d = (a: number, b: number) => Math.hypot(nav.nodes[a][0] - nav.nodes[b][0], nav.nodes[a][1] - nav.nodes[b][1]);
  const adj: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of nav.edges) { adj[a].push(b); adj[b].push(a); }
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0 || u === to) break;
    done[u] = true;
    for (const v of adj[u]) if (dist[u] + d(u, v) < dist[v]) { dist[v] = dist[u] + d(u, v); prev[v] = u; }
  }
  if (dist[to] === Infinity) return [to];
  const path: number[] = [];
  for (let u = to; u >= 0; u = prev[u]) path.unshift(u);
  return path;
}

interface Island {
  id: string;
  up: Vector3;
  q: Quaternion;
  /** Ground centre. */
  origin: Vector3;
  half: number;
  nav: IslandNav;
  /** Nodes where NPCs may stand (not at the bridge stub / central square). */
  street: number[];
  gangHome: number;
  gangPatrol: number[];
  /** Somebody (player / bot) is on the streets: full-rate simulation. */
  busy: boolean;
}

/**
 * City NPCs on every island: bums wander the streets, drink and leave empty bottles, pick fights with anyone
 * (each other too); an armed gang holds a corner of every island and shoots whoever it notices. The central city
 * has more of both.
 * Noticing is gradual: suspicion grows while a target is in view (faster when close, running, in the open) and
 * fades when it is not. Shots, explosions, punches and running footsteps can be heard.
 */
export class NpcManager {
  readonly npcs: Npc[] = [];
  readonly islands: Island[] = [];
  private readonly rng = new Rng(31337);
  time = 0;
  private tickN = 0;

  constructor(private R: Rapier, private world: PhysicsWorld, private map: MapData, private combat: Combat, private pickups: Pickups,
    opts: { bums?: number; gang?: number } = {}) {
    let id = 500;
    for (const def of map.islands) {
      const nav = map.nav[def.id];
      if (!nav) continue;
      const up = new Vector3(...def.up);
      const isl: Island = { id: def.id, up, q: new Quaternion(...def.quat), origin: new Vector3(...def.origin), half: def.half,
        nav, street: [], gangHome: 0, gangPatrol: [], busy: false };
      const dl = (i: number) => Math.hypot(nav.nodes[i][0] - nav.hub[0], nav.nodes[i][1] - nav.hub[1]);
      // not at the stub / square, not at the torn edges (road ends hang over the void)
      const inner = (i: number) => Math.max(Math.abs(nav.nodes[i][0]), Math.abs(nav.nodes[i][1])) < def.half - 10;
      isl.street = nav.nodes.map((_, i) => i).filter((i) => dl(i) > 10 && inner(i));
      // the gang holds the corner furthest from the hub (and so from the way to the bridge)
      isl.gangHome = isl.street.reduce((a, b) => (dl(b) > dl(a) ? b : a), isl.street[0]);
      const near = nav.edges.filter(([a, b]) => a === isl.gangHome || b === isl.gangHome).map(([a, b]) => (a === isl.gangHome ? b : a));
      isl.gangPatrol = [isl.gangHome, ...near.filter((i) => isl.street.includes(i))];
      this.islands.push(isl);
      const more = def.team ? 1 : 2; // the central city is bigger and rougher
      for (let k = 0; k < (opts.bums ?? NPC.bumsPerIsland) * more; k++) this.npcs.push(this.create(R, world, id++, 'bum', isl, -1));
      for (let k = 0; k < (opts.gang ?? NPC.gangSize) + (more - 1) * 2; k++) this.npcs.push(this.create(R, world, id++, 'gang', isl, k));
    }
    for (const n of this.npcs) this.spawn(n);
  }

  private create(R: Rapier, world: PhysicsWorld, id: number, kind: NpcKind, isl: Island, slot: number): Npc {
    const sim = new PlayerSim(R, world, this.map, (this.map.teams[0] ?? 'red') as TeamId);
    sim.surfaces = false;
    sim.events.length = 0;
    this.combat.addCharacter(sim.mover.collider);
    const target: Target = {
      id, team: kind === 'bum' ? `bum:${id}` : `gang:${isl.id}`, npc: kind, aggro: null, vel: sim.state.vel,
      center: sim.state.pos, up: upOf(sim.state.frame), hp: NPC[kind].hp, alive: true, respawnIn: -1,
      onImpulse: (v) => sim.applyImpulse(v),
    };
    const weapons = createWeaponState();
    if (kind === 'gang') giveWeapon(weapons, 'pistol');
    const npc: Npc = {
      id, kind, island: isl.id, slot, sim, target, weapons, state: kind === 'bum' ? 'wander' : 'patrol', stateT: 0,
      route: [], wp: 0, foe: null, suspicion: new Map(), grudge: new Map(), lastSeen: null, lostT: 0, seenT: 0, searchAt: null,
      lookAt: null, lookUntil: 0, drinkAt: this.rng.range(...NPC.bum.drinkEvery), respawnT: 0, scanT: this.rng.range(0, 0.2), shots: 0,
      shotsTotal: 0, pauseT: 0, progressT: 0, bestDist: Infinity, stuckN: 0, jumpT: 0, patrol: slot, prevPos: new Vector3(), status: '',
    };
    target.onHit = (owner) => this.onHit(npc, owner);
    this.combat.targets.push(target);
    return npc;
  }

  /** Colliders of all NPC bodies (building must not trap them). */
  get colliders() {
    return this.npcs.map((n) => n.sim.mover.collider);
  }

  island(id: string) {
    return this.islands.find((i) => i.id === id)!;
  }

  // --- coordinates --------------------------------------------------------------------------------

  /** Island-local XZ at street level → world (capsule centre height). */
  private toWorld(isl: Island, p: XZ, out = new Vector3()) {
    return out.set(p[0], 0.95, p[1]).applyQuaternion(isl.q).add(isl.origin);
  }

  /** World → island-local (x, height, z). */
  private toLocal(isl: Island, p: Vector3, out = new Vector3()) {
    return out.copy(p).sub(isl.origin).applyQuaternion(_inv.copy(isl.q).invert());
  }

  private nearestNode(isl: Island, p: Vector3) {
    const l = this.toLocal(isl, p, _w);
    let best = isl.street[0];
    let bd = Infinity;
    for (const i of isl.street) {
      const d = Math.hypot(isl.nav.nodes[i][0] - l.x, isl.nav.nodes[i][1] - l.z);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Somebody (player / bot) within NPC.liveRange of this NPC? */
  private watched(n: Npc) {
    const r2 = NPC.liveRange * NPC.liveRange;
    return this.combat.targets.some((t) => t.alive && !t.npc && t.center.distanceToSquared(n.sim.state.pos) < r2);
  }

  /** Is a world point on this island's street level (not the roof, not another island)? */
  private onStreets(isl: Island, p: Vector3) {
    const l = this.toLocal(isl, p, _w);
    return l.y > -3 && l.y < 20 && Math.max(Math.abs(l.x), Math.abs(l.z)) < isl.half + 4;
  }

  // --- life cycle ---------------------------------------------------------------------------------

  private spawn(n: Npc) {
    const isl = this.island(n.island);
    let node: number;
    if (n.kind === 'gang') node = isl.gangPatrol[n.slot % isl.gangPatrol.length];
    else {
      // somewhere nobody is looking: away from players and bots
      const others = this.combat.targets.filter((t) => t.alive && !t.npc);
      const far = isl.street.filter((i) => others.every((t) => t.center.distanceTo(this.toWorld(isl, isl.nav.nodes[i], _v)) > 25));
      node = this.rng.pick(far.length ? far : isl.street);
    }
    const s = n.sim.state;
    const p = isl.nav.nodes[node];
    // spread a little so that NPCs on the same node do not overlap (a corner node may sit at a torn edge: only
    // where there is ground)
    const off: XZ = [this.rng.range(-1.2, 1.2), this.rng.range(-1.2, 1.2)];
    this.toWorld(isl, [p[0] + off[0], p[1] + off[1]], s.pos);
    const down = isl.up.clone().negate();
    if (!this.world.castRay(new this.R.Ray(s.pos, down), 3, true)) this.toWorld(isl, p, s.pos);
    s.vel.set(0, 0, 0);
    s.frame.copy(isl.q);
    s.yaw = this.rng.range(0, Math.PI * 2);
    s.onGround = false;
    n.sim.mover.place(s);
    n.sim.events.length = 0;
    n.prevPos.copy(s.pos);
    n.target.hp = NPC[n.kind].hp;
    n.target.alive = true;
    n.target.aggro = null;
    n.foe = null;
    n.suspicion.clear();
    n.state = n.kind === 'bum' ? 'wander' : 'patrol';
    n.stateT = 0;
    n.route = [];
    n.stuckN = 0;
    n.searchAt = null;
    n.lookAt = null;
    n.drinkAt = this.time + this.rng.range(...NPC.bum.drinkEvery);
  }

  /** Dead NPCs wait far away (their capsule must not block anyone). */
  private park(n: Npc) {
    n.sim.state.pos.set(0, -6000 - n.id * 5, 0);
    n.sim.state.vel.set(0, 0, 0);
    n.sim.mover.place(n.sim.state);
    n.prevPos.copy(n.sim.state.pos);
  }

  private die(n: Npc) {
    const s = n.sim.state;
    const isl = this.island(n.island);
    if (n.kind === 'bum' && this.rng.chance(NPC.bum.bottleDrop)) this.pickups.drop('bottle', s.pos, isl.up);
    if (n.kind === 'gang') this.pickups.drop('cash', s.pos, isl.up, this.rng.int(...NPC.gang.loot));
    n.state = 'dead';
    n.respawnT = NPC[n.kind].respawn;
    n.target.aggro = null;
    n.foe = null;
    this.park(n);
  }

  private onHit(n: Npc, owner: number) {
    if (!n.target.alive || owner === n.id) return;
    const t = this.combat.target(owner);
    if (!t || !t.alive) return;
    // the gang does not care about bums slapping each other, but answers anyone who hurts one of its own
    this.engage(n, t);
    if (n.kind === 'gang') for (const m of this.npcs) if (m !== n && m.kind === 'gang' && m.island === n.island && m.state !== 'dead' && !m.foe) this.alarm(m, t.center);
  }

  /** Go for this target now. */
  private engage(n: Npc, t: Target) {
    n.suspicion.set(t.id, 1);
    n.foe = t;
    n.target.aggro = t.id;
    n.lastSeen = t.center.clone();
    n.lostT = 0;
    n.seenT = 0;
    this.setState(n, n.kind === 'bum' ? 'fight' : 'combat');
  }

  /** Heard / told about something at `pos`: a gang member goes to look, a bum turns its head. */
  private alarm(n: Npc, pos: Vector3) {
    if (n.kind === 'bum') { this.look(n, pos); return; }
    if (n.state === 'combat') return;
    n.searchAt = pos.clone();
    this.setState(n, 'search');
  }

  private setState(n: Npc, s: NpcState) {
    if (n.state !== s) { n.state = s; n.stateT = 0; n.route = []; }
  }

  /** How suspicious this NPC is of target `id` (0..1; UI). */
  awareness(n: Npc, id: number) {
    if (n.foe?.id === id) return 1;
    return Math.min(1, n.suspicion.get(id) ?? 0);
  }

  // --- simulation ---------------------------------------------------------------------------------

  tick(dt: number) {
    this.time += dt;
    this.tickN++;
    for (const isl of this.islands)
      isl.busy = this.combat.targets.some((t) => t.alive && !t.npc && this.onStreets(isl, t.center));
    const noises = this.combat.noises.splice(0);

    for (const n of this.npcs) {
      const isl = this.island(n.island);
      if (n.state !== 'dead' && !n.target.alive) this.die(n);
      if (n.state !== 'dead') for (const z of noises) this.hear(n, z);
      // quiet islands: a step every few ticks with a longer dt
      // full rate only near somebody who can see it (the central city is big: one bot crossing it does not wake
      // the far side)
      const live = isl.busy && this.watched(n);
      const step = live ? 1 : NPC.idleStep;
      if ((this.tickN + n.id) % step !== 0) continue;
      const h = dt * step;
      if (n.state === 'dead') {
        n.respawnT -= h;
        n.status = 'мёртв';
        if (n.respawnT <= 0) this.spawn(n);
        continue;
      }
      n.prevPos.copy(n.sim.state.pos);
      let { input, fire, aim } = this.think(n, isl, h);
      if (n.target.stun) {
        // hit by a bottle: dazed on the spot, the head lolling; then it remembers who threw it (onHit)
        input = emptyInput();
        input.yaw = n.sim.state.yaw + Math.sin(this.time * 7 + n.id) * 0.02;
        fire = false;
        aim = null;
        n.status = 'оглушён';
      }
      n.sim.tick(input, h);
      for (const e of n.sim.events.splice(0)) if (e.type === 'respawn') this.spawn(n); // fell off: back on the street
      upOf(n.sim.state.frame, n.target.up);
      const pull = fire && (WEAPONS[n.weapons.current].auto || !n.weapons.held);
      const fired = weaponTick(n.weapons, { fire: pull, reload: false, select: n.kind === 'gang' ? 'pistol' : null }, h);
      if (n.kind === 'gang') n.weapons.reserve.pistol = 999;
      if (fired && aim) {
        const eye = n.sim.state.pos.clone().addScaledVector(n.target.up, EYE_OFFSET);
        this.combat.use(fired, n.id, eye, aim, n.sim.state.vel, n.target.up.clone().negate());
        n.shotsTotal++;
        if (n.kind === 'gang' && ++n.shots >= NPC.gang.burst) { n.shots = 0; n.pauseT = NPC.gang.burstPause; }
      }
    }
  }

  private hear(n: Npc, z: Noise) {
    if (z.owner === n.id) return;
    const src = this.combat.target(z.owner);
    if (src?.npc === 'gang' && n.kind === 'gang') return; // own shots
    if (n.sim.state.pos.distanceTo(z.pos) > z.radius) return;
    // the shooter is now a suspect; a gang member walks over to look
    if (src && !src.npc) n.suspicion.set(src.id, Math.max(n.suspicion.get(src.id) ?? 0, 0.6));
    if (!n.foe) this.alarm(n, z.pos);
  }

  /** Who this NPC would fight: gangs fight teams (and whoever attacks them), bums anyone. */
  private hostile(n: Npc, t: Target) {
    if (!t.alive || t.id === n.id) return false;
    if (n.kind === 'gang') return !t.npc;
    return true;
  }

  /** Update suspicion of everybody around; returns the most suspicious visible target. */
  private perceive(n: Npc, eye: Vector3, dt: number) {
    const cfg = NPC[n.kind];
    const N = NPC.notice;
    const s = n.sim.state;
    moveBasis(s.frame, s.yaw, _fwd, _right);
    const up = upOf(s.frame, _up);
    const cosHalf = Math.cos((cfg.fov / 2) * Math.PI / 180);
    let best: Target | null = null;
    let bestS = 0;
    const seen = new Set<number>();
    for (const t of this.combat.targets) {
      if (!this.hostile(n, t)) continue;
      const d = eye.distanceTo(t.center);
      if (d > cfg.sight) continue;
      _v.copy(t.center).sub(eye);
      _v.addScaledVector(up, -_v.dot(up));
      const inCone = _v.lengthSq() < 1e-6 || _v.normalize().dot(_fwd) > cosHalf;
      const speed = t.vel ? Math.sqrt(Math.max(0, t.vel.lengthSq() - t.vel.dot(t.up) ** 2)) : 0;
      const loud = !t.quiet && speed > N.loud;
      const close = d < N.close;
      let gain = 0;
      if ((inCone || close) && this.combat.lineOfSight(eye, _w.copy(t.center).addScaledVector(t.up, 0.5))) {
        const motion = loud ? N.run : speed > 0.5 ? N.walk : N.still;
        gain = N.rate * motion * Math.max(0.15, 1 - d / cfg.sight) * (close ? 3 : 1) * (t.crouched ? N.crouch : 1);
        seen.add(t.id);
      } else if (loud && d < N.steps) {
        // footsteps: turn around, slowly get suspicious
        gain = N.rate * 0.35;
        this.look(n, t.center);
      }
      const v = Math.min(1.5, (n.suspicion.get(t.id) ?? 0) + gain * dt);
      if (gain > 0) n.suspicion.set(t.id, v);
      if (seen.has(t.id) && v > bestS) { best = t; bestS = v; }
    }
    // fade what is out of view
    for (const [id, v] of n.suspicion) {
      if (seen.has(id)) continue;
      const nv = v - N.decay * dt;
      if (nv <= 0) n.suspicion.delete(id); else n.suspicion.set(id, nv);
    }
    return { best, seen };
  }

  private think(n: Npc, isl: Island, dt: number): { input: MoveInput; fire: boolean; aim: Vector3 | null } {
    const s = n.sim.state;
    const input = emptyInput();
    input.yaw = s.yaw;
    const up = upOf(s.frame, new Vector3());
    const eye = s.pos.clone().addScaledVector(up, EYE_OFFSET);
    n.stateT += dt;
    n.pauseT = Math.max(0, n.pauseT - dt);

    n.scanT -= dt;
    let seen: Set<number> | null = null;
    if (n.scanT <= 0) {
      n.scanT = 0.2;
      const p = this.perceive(n, eye, 0.2);
      seen = p.seen;
      this.decide(n, isl, p.best, p.seen);
    }
    if (n.foe && !n.foe.alive) this.calm(n);

    let goal: Vector3 | null = null;
    let speed = NPC[n.kind].walk;
    let face: Vector3 | null = null;
    let fire = false;
    let aim: Vector3 | null = null;

    if (n.foe && (n.state === 'fight' || n.state === 'combat')) {
      const foe = n.foe;
      if (seen) {
        if (seen.has(foe.id)) { n.lastSeen = foe.center.clone(); n.lostT = 0; } else n.lostT += 0.2;
      }
      n.seenT = n.lostT === 0 ? n.seenT + dt : 0;
      const d = eye.distanceTo(foe.center);
      if (n.kind === 'bum') {
        speed = NPC.bum.run;
        if (d > WEAPONS.fists.reach - 0.5) goal = foe.center;
        face = foe.center;
        if (d < WEAPONS.fists.reach + 0.2 && n.lostT === 0) { fire = true; aim = foe.center.clone().addScaledVector(foe.up, 0.3); }
        n.status = 'драка';
      } else {
        speed = NPC.gang.run;
        if (n.lostT === 0) {
          face = foe.center;
          if (d > NPC.gang.range) goal = foe.center;
          if (n.seenT > NPC.gang.reaction && n.pauseT <= 0) {
            fire = true;
            aim = foe.center.clone().addScaledVector(foe.up, 0.25);
          }
          n.status = 'стреляет';
        } else {
          goal = n.lastSeen;
          n.status = 'преследует';
        }
      }
      if (aim) {
        aim.sub(eye).normalize();
        const spread = n.kind === 'gang' ? NPC.gang.spread : 0.02;
        aim.add(new Vector3(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1)).multiplyScalar(spread)).normalize();
      }
    } else if (n.state === 'drink') {
      n.status = 'пьёт';
      if (n.stateT > NPC.bum.drinkTime) {
        this.pickups.drop('bottle', s.pos, isl.up);
        n.drinkAt = this.time + this.rng.range(...NPC.bum.drinkEvery);
        this.setState(n, 'wander');
      }
    } else if (n.state === 'search' && n.searchAt) {
      n.status = 'ищет';
      speed = NPC.gang.walk * 1.4;
      if (s.pos.distanceTo(n.searchAt) > 2) goal = n.searchAt;
      else face = this.lookAround(n, s.pos);
      if (n.stateT > NPC.gang.search + 8) { n.searchAt = null; this.setState(n, 'patrol'); }
    } else {
      // routine: wander (bums) / patrol (gang) along the road graph
      if (n.kind === 'bum' && this.time > n.drinkAt && n.state === 'wander') this.setState(n, 'drink');
      else {
        if (!n.route.length) n.route = this.newRoute(n, isl);
        const p = n.route[Math.min(n.wp, n.route.length - 1)];
        const w = this.toWorld(isl, p, new Vector3());
        const last = n.wp >= n.route.length - 1;
        const dist = _v.copy(w).sub(s.pos).addScaledVector(up, -_v.dot(up)).length();
        if (dist < 1.2) {
          n.stuckN = 0;
          if (!last) n.wp++;
          else if (n.kind === 'gang') {
            // wait at the patrol point, looking around
            face = this.lookAround(n, s.pos);
            if (n.stateT > 5) { n.patrol++; n.route = []; n.stateT = 0; }
          } else n.route = [];
        } else goal = w;
        n.status = n.kind === 'bum' ? 'бродит' : 'патруль';
      }
    }
    if (n.lookAt && this.time > n.lookUntil) n.lookAt = null;
    if (!face && n.lookAt) face = n.lookAt;

    // steering: walk to `goal`, look at `face` (or where it walks)
    moveBasis(s.frame, s.yaw, _fwd, _right);
    const wish = new Vector3();
    if (goal) {
      wish.copy(goal).sub(s.pos);
      wish.addScaledVector(up, -wish.dot(up));
      const d = wish.length();
      if (d > 0.3) wish.divideScalar(d); else wish.set(0, 0, 0);
      // stuck (a parked car, a bench): hop, then take the road
      if (d < n.bestDist - 0.3) { n.bestDist = d; n.progressT = 0; } else n.progressT += dt;
      if (n.progressT > 1.5) {
        n.jumpT = 0.2; n.progressT = 0; n.bestDist = Infinity;
        if (n.state === 'wander' || n.state === 'patrol') {
          n.route = [];
          n.stuckN++;
          // the gang's patrol route is fixed: a blocked point would be retried forever, so skip it
          if (n.kind === 'gang' && n.stuckN >= 2) n.patrol++;
          // still wedged (nothing helped): back to the start, like bots do
          if (n.stuckN >= 6) this.spawn(n);
        }
      }
    } else { n.bestDist = Infinity; n.progressT = 0; }
    const lookDir = face ? face.clone().sub(eye) : wish.lengthSq() > 0 ? wish.clone() : null;
    if (lookDir && lookDir.lengthSq() > 1e-6) {
      const l = lookDir.normalize().applyQuaternion(_inv.copy(s.frame).invert());
      input.yaw = Math.atan2(-l.x, -l.z);
      input.pitch = Math.asin(Math.max(-1, Math.min(1, l.y)));
    }
    moveBasis(s.frame, input.yaw, _fwd, _right);
    if (s.onGround && wish.lengthSq() > 0) {
      input.forward = wish.dot(_fwd) * speed;
      input.right = wish.dot(_right) * speed;
    }
    if (n.jumpT > 0) { input.jump = true; n.jumpT -= dt; }
    return { input, fire, aim };
  }

  private look(n: Npc, pos: Vector3) {
    n.lookAt = pos.clone();
    n.lookUntil = this.time + 2.5;
  }

  /** Slow head sweep while standing. */
  private lookAround(n: Npc, pos: Vector3) {
    const isl = this.island(n.island);
    const a = this.time * 0.6 + n.id;
    return _w.set(Math.cos(a) * 5, 0, Math.sin(a) * 5).applyQuaternion(isl.q).add(pos).clone();
  }

  private newRoute(n: Npc, isl: Island): XZ[] {
    n.wp = 0;
    const from = this.nearestNode(isl, n.sim.state.pos);
    const to = n.kind === 'gang' ? isl.gangPatrol[n.patrol % isl.gangPatrol.length] : this.rng.pick(isl.street);
    return navPath(isl.nav, from, to).filter((i) => isl.street.includes(i) || i === to).map((i) => isl.nav.nodes[i]);
  }

  /** Back to the routine. */
  private calm(n: Npc) {
    if (n.foe) n.grudge.set(n.foe.id, this.time + NPC.bum.grudge);
    n.foe = null;
    n.target.aggro = null;
    if (n.kind === 'gang' && n.lastSeen) { n.searchAt = n.lastSeen; this.setState(n, 'search'); }
    else this.setState(n, n.kind === 'bum' ? 'wander' : 'patrol');
  }

  private decide(n: Npc, isl: Island, best: Target | null, seen: Set<number>) {
    const s = n.sim.state;
    if (n.foe) {
      const d = s.pos.distanceTo(n.foe.center);
      if (n.kind === 'bum' && (d > NPC.bum.chase || n.stateT > NPC.bum.giveUp)) this.calm(n);
      else if (n.kind === 'gang') {
        const home = this.toWorld(isl, isl.nav.nodes[isl.gangHome], _v);
        const gone = !this.onStreets(isl, n.foe.center) && !seen.has(n.foe.id);
        if (s.pos.distanceTo(home) > NPC.gang.leash || n.lostT > NPC.gang.forget || gone) this.calm(n);
      }
      return;
    }
    if (!best || (n.suspicion.get(best.id) ?? 0) < 1) return;
    if (n.kind === 'gang') {
      this.engage(n, best);
      // tell the others
      for (const m of this.npcs) if (m !== n && m.kind === 'gang' && m.island === n.island && m.state !== 'dead' && !m.foe) this.alarm(m, best.center);
      return;
    }
    // bums: only up close, and not always
    const d = s.pos.distanceTo(best.center);
    if (n.state === 'drink' || (n.grudge.get(best.id) ?? 0) > this.time) return;
    const limit = best.npc === 'bum' ? 3 : NPC.bum.picky;
    if (d > limit) return;
    if (this.rng.chance(best.npc === 'bum' ? NPC.bum.brawl : NPC.bum.temper)) this.engage(n, best);
    else n.grudge.set(best.id, this.time + NPC.bum.grudge);
  }
}

