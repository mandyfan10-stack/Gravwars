import { Matrix4, Quaternion, Vector3 } from 'three';
import { DEFAULT_MOVEMENT, MovementConfig } from './constants';
import type { MapData } from './map';
import { upOf } from './math';
import { createPlayerState, MoveInput, moveBasis, Mover, PlayerState } from './movement';
import type { PhysicsWorld, Rapier } from './physics';
import { buildPortals, crossesPortal, PortalRuntime } from './portals';
import { getTeam, TeamDef, TeamId } from './teams';

export type RespawnReason = 'void' | 'manual' | 'spawn' | 'killed';

export type SimEvent =
  | { type: 'gravity' }
  | { type: 'teleport'; matrix: Matrix4; quat: Quaternion }
  | { type: 'respawn'; reason: RespawnReason }
  | { type: 'launch' };

const _prev = new Vector3();
const _up = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _q = new Quaternion();
const _d = new Vector3();

/**
 * Authoritative player simulation (movement + world rules). Runs on the client for prediction
 * and will run unchanged on the server.
 */
export class PlayerSim {
  readonly state: PlayerState = createPlayerState();
  readonly mover: Mover;
  readonly portals: PortalRuntime[];
  readonly events: SimEvent[] = [];
  team: TeamDef;

  constructor(R: Rapier, world: PhysicsWorld, readonly map: MapData, teamId: TeamId,
    readonly cfg: MovementConfig = { ...DEFAULT_MOVEMENT }) {
    this.team = getTeam(teamId);
    this.mover = new Mover(R, world, cfg);
    this.portals = buildPortals(map.portals);
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
    _prev.copy(s.pos);
    this.mover.step(s, input, dt);

    // portals: teleport + inherit the gravity of the exit face
    for (const p of this.portals) {
      if (!crossesPortal(p, _prev, s.pos)) continue;
      s.pos.applyMatrix4(p.toPartner);
      s.vel.applyQuaternion(p.qToPartner);
      s.frame.premultiply(p.qToPartner).normalize();
      this.mover.place(s);
      this.events.push({ type: 'teleport', matrix: p.toPartner, quat: p.qToPartner });
      break;
    }

    // geysers
    if (s.onGround && !s.noclip) {
      const up = upOf(s.frame, _up);
      for (const pad of this.map.pads) {
        const pu = new Vector3(...pad.up);
        if (pu.dot(up) < 0.99) continue;
        _d.copy(s.pos).sub(new Vector3(...pad.pos));
        const h = _d.dot(pu);
        if (h > 1.6) continue;
        _d.addScaledVector(pu, -h);
        if (_d.length() > pad.radius) continue;
        this.launch(pad.target, pad.apex, pu);
        break;
      }
    }

    if (s.pos.length() > this.map.killRadius) this.respawn('void');
  }

  /** Ballistic launch that lands on `target` with the current gravity. */
  private launch(target: number[], apex: number, up: Vector3) {
    const g = this.cfg.gravity;
    const s = this.state;
    const delta = new Vector3(target[0] - s.pos.x, target[1] - s.pos.y, target[2] - s.pos.z);
    const dy = delta.dot(up);
    const vUp = Math.sqrt(2 * g * (dy + apex));
    const t = (vUp + Math.sqrt(Math.max(vUp * vUp - 2 * g * dy, 0))) / g;
    const horiz = delta.addScaledVector(up, -dy).divideScalar(t);
    s.vel.copy(horiz).addScaledVector(up, vUp);
    s.onGround = false;
    this.events.push({ type: 'launch' });
  }
}