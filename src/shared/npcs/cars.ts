import { Quaternion, Vector3 } from 'three';
import type { Combat, Target } from '../combat';
import type { Pickups } from '../economy';
import type { MapData } from '../map';
import { Rng } from '../math';
import { moveBasis } from '../movement';
import type { PhysicsWorld, Rapier } from '../physics';
import { Island, NpcCar, NpcEvent, onStreets, toWorld } from './types';

const CAR_COLORS = [0xc94a38, 0x3b6ea5, 0xd49b27, 0x488a5b, 0x7b5283, 0xb85d28];

const _v = new Vector3();
const _w = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _inv = new Quaternion();

function lerpAngle(curr: number, target: number, maxStep: number): number {
  let diff = ((target - curr + Math.PI) % (Math.PI * 2));
  if (diff < 0) diff += Math.PI * 2;
  diff -= Math.PI;
  if (Math.abs(diff) <= maxStep) return target;
  return curr + Math.sign(diff) * maxStep;
}

export interface CarTrafficDeps {
  R: Rapier;
  world: PhysicsWorld;
  map: MapData;
  combat: Combat;
  pickups: Pickups;
  events: NpcEvent[];
  rng: Rng;
  island: (id: string) => Island;
}

/** Ambient island road cars: cruising, obstacle avoidance, magical end-of-route vanishing, fleeing, and crash-explosions. */
export class CarTraffic {
  readonly cars: NpcCar[] = [];
  private readonly carRng = new Rng(77777);

  constructor(private deps: CarTrafficDeps) {}

  init(islands: Island[], perIsland: number) {
    let carId = 800;
    for (const isl of islands) {
      for (let k = 0; k < perIsland; k++) this.cars.push(this.createCar(carId++, isl));
    }
    for (const c of this.cars) this.spawnCar(c);
  }

  private createCar(id: number, isl: Island): NpcCar {
    const pos = new Vector3();
    const vel = new Vector3();
    const up = isl.up.clone();
    const scale = this.carRng.range(0.75, 1.35);
    const target: Target = {
      id, team: `car:${id}`, npc: 'car', aggro: null, vel,
      center: pos, up, hp: Math.round(315 * scale), alive: true, respawnIn: -1,
      radius: 1.6 * scale,
    };
    const car: NpcCar = {
      id, island: isl.id, pos, prevPos: new Vector3(), vel, up, quat: isl.q.clone(), yaw: 0,
      scale, color: this.carRng.pick(CAR_COLORS), target, state: 'drive',
      currNode: isl.borderNodes[0] ?? 0, nextNode: isl.borderNodes[0] ?? 0,
      crashGoal: null, crashT: 0, vanishT: 0, respawnT: 0,
      attackerId: null, fleeT: 0, stepsLeft: 6,
    };
    target.onHit = (owner) => this.onCarHit(car, owner);
    this.deps.combat.targets.push(target);
    return car;
  }

  private spawnCar(car: NpcCar) {
    const isl = this.deps.island(car.island);
    car.scale = this.carRng.range(0.75, 1.35);
    car.color = this.carRng.pick(CAR_COLORS);
    car.target.radius = 1.6 * car.scale;
    car.target.hp = Math.round(315 * car.scale);
    car.target.alive = true;
    car.state = 'drive';
    car.crashGoal = null;
    car.crashT = 0;
    car.vanishT = 0;
    car.attackerId = null;
    car.fleeT = 0;
    car.stepsLeft = this.carRng.int(4, 9);
    const start = this.carRng.pick(isl.borderNodes.length ? isl.borderNodes : isl.street);
    car.currNode = start;
    car.nextNode = this.pickNextCarNode(isl, start, -1);
    const p = isl.nav.nodes[start];
    toWorld(isl, p, car.pos);
    car.prevPos.copy(car.pos);
    car.vel.set(0, 0, 0);
    // Point car initially towards nextNode so it starts smoothly
    const nextXZ = isl.nav.nodes[car.nextNode] ?? p;
    car.yaw = Math.atan2(-(nextXZ[0] - p[0]), -(nextXZ[1] - p[1]));
  }

  /** Begin magical vanishing animation at the end of a road route. */
  private beginVanishCar(car: NpcCar) {
    if (car.state === 'vanishing' || car.state === 'dead') return;
    car.state = 'vanishing';
    car.vanishT = 1.1;
    car.target.alive = false;
    car.attackerId = null;
    car.fleeT = 0;
    car.vel.set(0, 0, 0);
    this.deps.events.push({ type: 'carVanish', id: car.id, pos: car.pos.clone() });
  }

  private despawnCar(car: NpcCar) {
    car.state = 'dead';
    car.target.alive = false;
    car.vanishT = 0;
    car.respawnT = 6;
    car.attackerId = null;
    car.fleeT = 0;
    car.pos.set(0, -6500 - car.id * 5, 0);
    car.prevPos.copy(car.pos);
    car.vel.set(0, 0, 0);
  }

  /** Find a random nearby living fighter (player/bot) on this island within `maxDist` m. */
  private pickRandomNearbyPlayer(car: NpcCar, isl: Island, maxDist = 28): Target | null {
    const candidates = this.deps.combat.targets.filter(
      (t) => t.alive && !t.npc && t.id !== car.id && onStreets(isl, t.center) && t.center.distanceTo(car.pos) <= maxDist,
    );
    return candidates.length ? this.carRng.pick(candidates) : null;
  }

  private onCarHit(car: NpcCar, owner: number) {
    if (car.state === 'dead' || car.state === 'vanishing' || owner === car.id) return;
    const isl = this.deps.island(car.island);
    this.deps.events.push({ type: 'carAlarm', id: car.id, pos: car.pos.clone() });
    const attacker = this.deps.combat.target(owner);
    const randomNearby = this.pickRandomNearbyPlayer(car, isl, 28);
    // Can choose either the attacker or a random nearby player/fighter as explosion target
    const chosenTarget = (randomNearby && this.carRng.chance(0.45)) ? randomNearby : (attacker && attacker.alive ? attacker : randomNearby);
    if (car.state === 'crashing') {
      if (chosenTarget && chosenTarget.alive) {
        car.attackerId = chosenTarget.id;
        car.crashGoal = chosenTarget.center.clone();
      }
      return;
    }
    const lowHp = !car.target.alive || car.target.hp <= 88 * car.scale;
    if (chosenTarget && chosenTarget.alive) car.attackerId = chosenTarget.id;
    if (lowHp || (chosenTarget && chosenTarget.alive && this.carRng.chance(0.5))) {
      car.state = 'crashing';
      car.crashT = 0;
      car.crashGoal = chosenTarget && chosenTarget.alive ? chosenTarget.center.clone() : this.findCrashObject(car, isl);
    } else {
      // Flee away from the attacker at high speed
      car.fleeT = 6.5;
      if (attacker) {
        car.nextNode = this.pickNextCarNode(isl, car.currNode, -1, attacker.center);
      }
    }
  }

  private pickNextCarNode(isl: Island, from: number, prev: number, awayFrom?: Vector3): number {
    const neighbors = isl.nav.edges
      .filter(([a, b]) => a === from || b === from)
      .map(([a, b]) => (a === from ? b : a));
    if (!neighbors.length) return this.carRng.pick(isl.street);
    const forward = neighbors.filter((n) => n !== prev);
    const pool = forward.length ? forward : neighbors;
    if (awayFrom) {
      let best = pool[0];
      let bestD = -Infinity;
      for (const n of pool) {
        const d = toWorld(isl, isl.nav.nodes[n], _v).distanceToSquared(awayFrom);
        if (d > bestD) { bestD = d; best = n; }
      }
      return best;
    }
    return this.carRng.pick(pool);
  }

  private findCrashObject(car: NpcCar, isl: Island): Vector3 {
    if (car.attackerId !== null) {
      const att = this.deps.combat.target(car.attackerId);
      if (att && att.alive && onStreets(isl, att.center)) return att.center.clone();
    }
    const rndPlayer = this.pickRandomNearbyPlayer(car, isl, 28);
    if (rndPlayer) {
      car.attackerId = rndPlayer.id;
      return rndPlayer.center.clone();
    }
    let best: Vector3 | null = null;
    let bestD = Infinity;
    for (const t of this.deps.combat.targets) {
      if (!t.alive || t.id === car.id || t.npc === 'car' || !onStreets(isl, t.center)) continue;
      const d = t.center.distanceTo(car.pos);
      if (d > 1.5 && d < bestD) { bestD = d; best = t.center.clone(); }
    }
    for (const c of this.deps.map.crates) {
      const w = _v.set(c.pos[0], c.pos[1], c.pos[2]);
      if (!onStreets(isl, w)) continue;
      const d = w.distanceTo(car.pos);
      if (d > 1.5 && d < bestD) { bestD = d; best = w.clone(); }
    }
    for (const h of this.deps.map.houses) {
      const w = _v.set(h.pos[0], h.pos[1], h.pos[2]);
      if (!onStreets(isl, w)) continue;
      const d = w.distanceTo(car.pos);
      if (d > 2 && d < bestD) { bestD = d; best = w.clone(); }
    }
    for (const b of this.deps.map.buildings) {
      const w = _v.set(b.pos[0], b.pos[1], b.pos[2]);
      if (!onStreets(isl, w)) continue;
      const d = w.distanceTo(car.pos);
      if (d > 2 && d < bestD) { bestD = d; best = w.clone(); }
    }
    if (best) return best;
    moveBasis(isl.q, car.yaw, _fwd, _right);
    return car.pos.clone().addScaledVector(_fwd, 6);
  }

  private explodeCar(car: NpcCar, isl: Island) {
    const pos = car.pos.clone();
    this.deps.events.push({ type: 'carExplode', id: car.id, pos: pos.clone() });
    this.deps.combat.triggerExplosion(pos, car.id, car.target.team, 12.5, 162.5, 24, 250, 0, false, 'car', pos);
    // Drop random resources (cash, ammo, metal, wood); 1.5x reward, size-scaled
    const s = car.scale * 1.5;
    const { rng, pickups } = this.deps;
    if (rng.chance(0.8)) pickups.dropSpread('cash', pos, isl.up, Math.max(3, Math.round(rng.int(4, 11) * s)));
    if (rng.chance(0.75)) pickups.dropSpread('ammo', pos, isl.up, Math.max(1, Math.round((car.scale > 1.1 && rng.chance(0.5) ? 2 : 1) * 1.5)));
    if (rng.chance(0.7)) pickups.dropSpread('metal', pos, isl.up, Math.max(2, Math.round(rng.int(1, 4) * s)));
    if (rng.chance(0.8)) pickups.dropSpread('wood', pos, isl.up, Math.max(3, Math.round(rng.int(4, 10) * s)));
    car.state = 'dead';
    car.target.alive = false;
    car.attackerId = null;
    car.fleeT = 0;
    car.respawnT = 25;
    car.pos.set(0, -6500 - car.id * 5, 0);
    car.prevPos.copy(car.pos);
    car.vel.set(0, 0, 0);
  }

  /** Cast whisker rays ahead of `car` to steer around obstacles whenever possible. */
  private steerCarAroundObstacles(car: NpcCar, isl: Island, dt: number): number {
    moveBasis(isl.q, car.yaw, _fwd, _right);
    const origin = car.pos.clone().addScaledVector(isl.up, 0.35);
    const probeLen = 5.2 * car.scale;
    const leftDir = _fwd.clone().addScaledVector(_right, -0.38).normalize();
    const rightDir = _fwd.clone().addScaledVector(_right, 0.38).normalize();
    const { R, world, combat } = this.deps;
    const hitL = world.castRay(new R.Ray(origin, leftDir), probeLen, true, undefined, undefined, undefined, undefined, combat.notCharacter);
    const hitR = world.castRay(new R.Ray(origin, rightDir), probeLen, true, undefined, undefined, undefined, undefined, combat.notCharacter);
    const hitC = world.castRay(new R.Ray(origin, _fwd), probeLen * 0.85, true, undefined, undefined, undefined, undefined, combat.notCharacter);
    let steer = 0;
    if (hitL && (!hitR || hitL.timeOfImpact < hitR.timeOfImpact)) {
      steer -= 4.2 * (1 - hitL.timeOfImpact / probeLen);
    } else if (hitR && (!hitL || hitR.timeOfImpact < hitL.timeOfImpact)) {
      steer += 4.2 * (1 - hitR.timeOfImpact / probeLen);
    } else if (hitC) {
      steer += (car.id % 2 === 0 ? 1 : -1) * 4.5 * (1 - hitC.timeOfImpact / probeLen);
    }
    if (steer !== 0) car.yaw += steer * dt;
    return hitC ? Math.max(0.35, hitC.timeOfImpact / probeLen) : 1;
  }

  tick(dt: number) {
    for (const car of this.cars) {
      const isl = this.deps.island(car.island);
      if (car.state === 'dead') {
        car.respawnT -= dt;
        if (car.respawnT <= 0) this.spawnCar(car);
        continue;
      }
      if (car.state === 'vanishing') {
        car.prevPos.copy(car.pos);
        car.vanishT -= dt;
        car.yaw += 3.2 * dt;
        car.pos.addScaledVector(isl.up, 1.1 * dt);
        if (car.vanishT <= 0) this.despawnCar(car);
        continue;
      }
      car.prevPos.copy(car.pos);
      car.fleeT = Math.max(0, car.fleeT - dt);
      if (car.state === 'drive' && !car.target.alive) {
        car.state = 'crashing';
        car.crashT = 0;
        car.crashGoal = this.findCrashObject(car, isl);
      }
      if (car.state === 'crashing') {
        car.crashT += dt;
        // Dynamically track the chosen target if alive on this island
        if (car.attackerId !== null) {
          const att = this.deps.combat.target(car.attackerId);
          if (att && att.alive && onStreets(isl, att.center)) {
            car.crashGoal = att.center.clone();
          }
        }
        const goal = car.crashGoal ?? car.pos;
        _v.copy(goal).sub(car.pos);
        _v.addScaledVector(isl.up, -_v.dot(isl.up));
        const dist = _v.length();
        if (dist < 2.4 * car.scale || car.crashT > 2.8) {
          this.explodeCar(car, isl);
          continue;
        }
        _v.divideScalar(dist || 1);
        const l = _w.copy(_v).applyQuaternion(_inv.copy(isl.q).invert());
        const desiredYaw = Math.atan2(-l.x, -l.z);
        car.yaw = lerpAngle(car.yaw, desiredYaw, 6.5 * dt);
        this.steerCarAroundObstacles(car, isl, dt * 0.65);
        moveBasis(isl.q, car.yaw, _fwd, _right);
        const speed = 17.5;
        car.vel.copy(_fwd).lerp(_v, 0.35).normalize().multiplyScalar(speed);
        car.pos.addScaledVector(car.vel, dt);
        continue;
      }
      // Normal or fleeing driving along road nodes
      const targetXZ = isl.nav.nodes[car.nextNode] ?? isl.nav.nodes[0];
      const goal = toWorld(isl, targetXZ, _v);
      _w.copy(goal).sub(car.pos);
      _w.addScaledVector(isl.up, -_w.dot(isl.up));
      const dist = _w.length();
      if (dist < 1.8) {
        car.stepsLeft--;
        const isEdge = isl.borderNodes.includes(car.nextNode)
          || Math.max(Math.abs(targetXZ[0]), Math.abs(targetXZ[1])) >= isl.half - 11;
        if (car.stepsLeft <= 0 && isEdge) {
          this.beginVanishCar(car);
          continue;
        }
        const next = this.pickNextCarNode(isl, car.nextNode, car.currNode);
        car.currNode = car.nextNode;
        car.nextNode = next;
      } else {
        _w.divideScalar(dist);
        const l = _v.copy(_w).applyQuaternion(_inv.copy(isl.q).invert());
        const desiredYaw = Math.atan2(-l.x, -l.z);
        const turnRate = car.fleeT > 0 ? 5.8 : 3.8;
        car.yaw = lerpAngle(car.yaw, desiredYaw, turnRate * dt);
        const clearMul = this.steerCarAroundObstacles(car, isl, dt);
        moveBasis(isl.q, car.yaw, _fwd, _right);
        let speed = (car.fleeT > 0 ? 14.5 : 7.5) * clearMul;
        const turnDiff = Math.abs(lerpAngle(car.yaw, desiredYaw, Math.PI) - car.yaw);
        if (turnDiff > 0.45 && car.fleeT <= 0) speed *= 0.72;
        if (car.fleeT <= 0) {
          for (const other of this.cars) {
            if (other === car || other.state === 'dead' || other.state === 'vanishing' || other.island !== car.island) continue;
            const od = other.pos.distanceTo(car.pos);
            if (od < 4.5 && _v.copy(other.pos).sub(car.pos).normalize().dot(_fwd) > 0.6) {
              speed *= 0.45;
              break;
            }
          }
        }
        car.vel.copy(_fwd).lerp(_w, 0.35).normalize().multiplyScalar(speed);
        car.pos.addScaledVector(car.vel, dt);
      }
    }
  }
}
