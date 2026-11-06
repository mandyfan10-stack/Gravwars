import { Quaternion, Vector3 } from 'three';
import { DEFAULT_MOVEMENT, MovementConfig, PLAYER_HEIGHT } from './constants';
import { fieldFor, GravityField } from './gravity';
import type { MapData } from './map';
import { upOf } from './math';
import { createPlayerState, MoveInput, moveBasis, Mover, PlayerState } from './movement';
import type { PhysicsWorld, Rapier } from './physics';
import { getTeam, TeamDef, TeamId } from './teams';

export type RespawnReason = 'void' | 'manual' | 'spawn' | 'killed';

export type SimEvent =
  | { type: 'gravity' }
  | { type: 'respawn'; reason: RespawnReason }
  | { type: 'launch' };

const _up = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _q = new Quaternion();
const _n = new Vector3();
/** After a switch the body is put this far above the new surface (capsule half height + a short drop). */
const SWITCH_CLEARANCE = PLAYER_HEIGHT / 2 + 0.2;
/** Falling this long with nothing level for you below = the void. */
const VOID_TIME = 1.5;

/**
 * Authoritative player simulation (movement + world rules). Runs on the client for prediction
 * and will run unchanged on the server.
 */
export class PlayerSim {
  readonly state: PlayerState = createPlayerState();
  readonly mover: Mover;
  readonly events: SimEvent[] = [];
  readonly gravity: GravityField;
  team: TeamDef;
  /** Gravity follows the surface you step onto (gravity.ts). NPCs stay in the gravity they were made in. */
  surfaces = true;
  /** Time spent falling with nothing under you. */
  private voidT = 0;

  constructor(R: Rapier, world: PhysicsWorld, readonly map: MapData, teamId: TeamId,
    readonly cfg: MovementConfig = { ...DEFAULT_MOVEMENT }) {
    this.team = getTeam(teamId);
    this.mover = new Mover(R, world, cfg);
    this.gravity = fieldFor(map);
    this.respawn('spawn');
  }

  respawn(reason: RespawnReason = 'manual') {
    const sp = this.map.spawns[this.team.id];
    const s = this.state;
    s.pos.set(...sp.pos);
    s.vel.set(0, 0, 0);
    s.frame.set(...sp.quat);
    s.yaw = sp.yaw;
    s.pitch = 0;
    s.onGround = false;
    s.airT = -1;
    this.voidT = 0;
    this.mover.place(s);
    this.events.push({ type: 'respawn', reason });
  }

  /** Rotate the body so that its up becomes -down. 180° flips roll around the view direction. */
  setGravity(down: Vector3) {
    const s = this.state;
    const oldUp = upOf(s.frame, _up);
    const newUp = down.clone().negate().normalize();
    const d = oldUp.dot(newUp);
    if (d > 0.999) return;
    if (d < -0.999) {
      moveBasis(s.frame, s.yaw, _fwd, _right);
      _q.setFromAxisAngle(_fwd, Math.PI);
    } else {
      _q.setFromUnitVectors(oldUp, newUp);
    }
    s.frame.premultiply(_q).normalize();
    s.onGround = false;
    this.mover.place(s);
    this.events.push({ type: 'gravity' });
  }

  /** Explosion knockback etc. Leaves the ground so the push is not eaten by friction. */
  applyImpulse(v: Vector3) {
    const s = this.state;
    if (s.noclip) return;
    s.vel.add(v);
    s.onGround = false;
  }

  gravityDown(out = new Vector3()): Vector3 {
    return upOf(this.state.frame, out).negate();
  }

  tick(input: MoveInput, dt: number) {
    const s = this.state;
    this.mover.step(s, input, dt);
    if (s.noclip) return;
    const up = upOf(s.frame, _up);

    // walked onto a surface of another gravity (bridge stub, built floor): turn onto it
    if (this.surfaces) {
      const pull = this.gravity.pull(s.pos, up);
      if (pull) {
        const n = _n.copy(pull.plate.up);
        if (pull.h < SWITCH_CLEARANCE) s.pos.addScaledVector(n, SWITCH_CLEARANCE - pull.h);
        const into = s.vel.dot(n);
        if (into < 0) s.vel.addScaledVector(n, -into);
        this.setGravity(n.negate());
        s.airT = -1;
        return;
      }
    }

    if (s.onGround || this.gravity.holds(s.pos, up)) this.voidT = 0;
    else if ((this.voidT += dt) > VOID_TIME) this.respawn('void');
    if (s.pos.length() > this.map.killRadius) this.respawn('void');
  }
}
