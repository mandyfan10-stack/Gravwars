import { Group, Quaternion, Scene, Vector3 } from 'three';
import type { GameAssets } from '../render/assets';
import { type HeldItem, PlayerModel, type ModelState } from '../render/playerModel';
import type { RemotePlayerSnapshot } from '../../shared/net/protocol';
import { getTeam } from '../../shared/teams';

const _vel = new Vector3();
const _up = new Vector3();

function toHeldItem(w: string): HeldItem {
  if (w === 'pistol' || w === 'rifle' || w === 'shotgun' || w === 'crossbow' || w === 'rocket' || w === 'hook' || w === 'fists' || w === 'grenade' || w === 'rod') return w;
  return 'fists';
}

interface InterpolatedRemotePlayer {
  snapshot: RemotePlayerSnapshot;
  model: PlayerModel;
  currPos: Vector3;
  targetPos: Vector3;
  currFrame: Quaternion;
  targetFrame: Quaternion;
  currYaw: number;
  targetYaw: number;
  firedOnce: boolean;
  lastUpdate: number;
}

/**
 * Manages 3D humanoid models and per-frame interpolation for other human players over the network.
 */
export class RemotePlayerManager {
  readonly group = new Group();
  private players = new Map<string, InterpolatedRemotePlayer>();

  constructor(
    private scene: Scene,
    private assets: GameAssets
  ) {
    this.scene.add(this.group);
  }

  /** Apply authoritative snapshot targets from the host (call when a snapshot packet arrives). */
  applySnapshot(snapshots: RemotePlayerSnapshot[], localPlayerId: string) {
    const presentIds = new Set<string>();

    for (const snap of snapshots) {
      if (snap.id === localPlayerId) continue; // Don't draw ourselves as remote model
      presentIds.add(snap.id);

      let remote = this.players.get(snap.id);
      if (!remote) {
        const teamDef = getTeam(snap.team);
        const model = new PlayerModel(this.assets, teamDef.color, toHeldItem(snap.activeWeapon), 0, 'soldier');
        this.group.add(model.group);

        remote = {
          snapshot: snap,
          model,
          currPos: new Vector3(...snap.pos),
          targetPos: new Vector3(...snap.pos),
          currFrame: new Quaternion(...snap.frame),
          targetFrame: new Quaternion(...snap.frame),
          currYaw: snap.yaw,
          targetYaw: snap.yaw,
          firedOnce: false,
          lastUpdate: performance.now(),
        };
        this.players.set(snap.id, remote);
      }

      remote.targetPos.set(...snap.pos);
      remote.targetFrame.set(...snap.frame);
      remote.targetYaw = snap.yaw;
      remote.snapshot = snap;
      const held = toHeldItem(snap.activeWeapon);
      if (held !== remote.model.held) remote.model.setHeld(held);
      remote.lastUpdate = performance.now();

      if (!snap.alive) remote.model.die();
      else remote.model.revive();
    }

    for (const [id, remote] of this.players) {
      if (!presentIds.has(id)) {
        this.group.remove(remote.model.group);
        this.players.delete(id);
      }
    }
  }

  /** Trigger a one-shot recoil / punch animation for a remote player on weapon fire event. */
  triggerFire(playerId: string) {
    const remote = this.players.get(playerId);
    if (remote) remote.firedOnce = true;
  }

  /** Trigger a kick animation for a remote player on kick event. */
  triggerKick(playerId: string) {
    const remote = this.players.get(playerId);
    if (remote) remote.model.kick();
  }

  /** Smoothly interpolate remote players and animate their rigs once per render frame. */
  update(dt: number) {
    const lerpSpeed = Math.min(1, dt * 18);
    for (const remote of this.players.values()) {
      remote.currPos.lerp(remote.targetPos, lerpSpeed);
      remote.currFrame.slerp(remote.targetFrame, lerpSpeed);

      let dYaw = remote.targetYaw - remote.currYaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      remote.currYaw += dYaw * lerpSpeed;

      remote.model.setPose(remote.currPos, remote.currFrame, remote.currYaw);

      _vel.set(...remote.snapshot.vel);
      _up.set(0, 1, 0).applyQuaternion(remote.currFrame);
      const vUp = _vel.dot(_up);
      const speed = Math.sqrt(Math.max(0, _vel.lengthSq() - vUp * vUp));

      const modelState: ModelState = {
        speed,
        vUp,
        grounded: remote.snapshot.onGround,
        fired: remote.firedOnce || remote.snapshot.isFiring,
      };
      remote.firedOnce = false;

      remote.model.update(dt, modelState);
    }
  }

  /** Legacy helper: apply snapshot and step interpolation in one call. */
  updateSnapshots(snapshots: RemotePlayerSnapshot[], localPlayerId: string, dt: number) {
    this.applySnapshot(snapshots, localPlayerId);
    this.update(dt);
  }

  destroy() {
    for (const remote of this.players.values()) {
      this.group.remove(remote.model.group);
    }
    this.players.clear();
    this.scene.remove(this.group);
  }
}
