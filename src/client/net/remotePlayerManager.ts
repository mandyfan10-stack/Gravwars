import { Camera, Group, Quaternion, Scene, Vector3 } from 'three';
import { escapeHtml } from '../../shared/escape';
import type { RemotePlayerSnapshot } from '../../shared/net/protocol';
import type { PlayerSim } from '../../shared/sim';
import { getTeam, type TeamId } from '../../shared/teams';
import type { GameAssets } from '../render/assets';
import { HookView } from '../render/hookView';
import { type HeldItem, PlayerModel, type ModelState } from '../render/playerModel';

const _vel = new Vector3();
const _up = new Vector3();
const _down = new Vector3();
const _hand = new Vector3();
const _tag = new Vector3();
const _proj = new Vector3();

const TAG_HEIGHT = 1.45;
const ENEMY_TAG_RANGE = 45;
const ALLY_TAG_RANGE = 140;

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

function toHeldItem(w: string): HeldItem {
  if (
    w === 'pistol' || w === 'rifle' || w === 'shotgun' || w === 'crossbow' ||
    w === 'rocket' || w === 'hook' || w === 'fists' || w === 'grenade' || w === 'rod'
  ) {
    return w;
  }
  return 'fists';
}

interface InterpolatedRemotePlayer {
  snapshot: RemotePlayerSnapshot;
  model: PlayerModel;
  hookProxy: { hook: PlayerSim['hook'] };
  hookView: HookView;
  tagEl: HTMLElement | null;
  currPos: Vector3;
  targetPos: Vector3;
  currFrame: Quaternion;
  targetFrame: Quaternion;
  currYaw: number;
  targetYaw: number;
  prevHp: number;
  prevAlive: boolean;
  firedOnce: boolean;
  lastUpdate: number;
}

/**
 * Manages 3D humanoid models, grappling hooks, floating nametags, and per-frame interpolation for remote players.
 */
export class RemotePlayerManager {
  readonly group = new Group();
  private players = new Map<string, InterpolatedRemotePlayer>();
  private readonly markersEl = typeof document !== 'undefined' ? document.getElementById('markers') : null;

  constructor(
    private scene: Scene,
    private assets: GameAssets,
  ) {
    this.scene.add(this.group);
  }

  private createTagEl(color: number, name: string): HTMLElement | null {
    if (!this.markersEl) return null;
    const el = document.createElement('div');
    el.className = 'player-tag';
    el.style.color = hex(color);
    el.innerHTML = `<span class="name">${escapeHtml(name)}</span><div class="hp-bar"><i></i></div>`;
    this.markersEl.appendChild(el);
    return el;
  }

  /** Apply authoritative snapshot targets from the host (call when a snapshot packet arrives). */
  applySnapshot(snapshots: RemotePlayerSnapshot[], localPlayerId: string) {
    const presentIds = new Set<string>();

    for (const snap of snapshots) {
      if (snap.id === localPlayerId) continue;
      presentIds.add(snap.id);

      let remote = this.players.get(snap.id);
      if (!remote) {
        const teamDef = getTeam(snap.team);
        const model = new PlayerModel(this.assets, teamDef.color, toHeldItem(snap.activeWeapon), 0, 'soldier');
        this.group.add(model.group);
        const hookProxy: { hook: PlayerSim['hook'] } = { hook: null };
        const hookView = new HookView(this.scene, hookProxy);
        const tagEl = this.createTagEl(teamDef.color, snap.name || teamDef.name);

        remote = {
          snapshot: snap,
          model,
          hookProxy,
          hookView,
          tagEl,
          currPos: new Vector3(...snap.pos),
          targetPos: new Vector3(...snap.pos),
          currFrame: new Quaternion(...snap.frame),
          targetFrame: new Quaternion(...snap.frame),
          currYaw: snap.yaw,
          targetYaw: snap.yaw,
          prevHp: snap.hp,
          prevAlive: snap.alive,
          firedOnce: false,
          lastUpdate: performance.now(),
        };
        this.players.set(snap.id, remote);
      }

      remote.targetPos.set(...snap.pos);
      remote.targetFrame.set(...snap.frame);
      remote.targetYaw = snap.yaw;

      // Snap immediately on respawn or large teleport rather than sliding across the arena
      if ((!remote.prevAlive && snap.alive) || remote.currPos.distanceToSquared(remote.targetPos) > 36) {
        remote.currPos.copy(remote.targetPos);
        remote.currFrame.copy(remote.targetFrame);
        remote.currYaw = remote.targetYaw;
      }

      if (snap.alive && remote.prevAlive && snap.hp < remote.prevHp) {
        remote.model.hit();
      }
      remote.prevHp = snap.hp;
      remote.prevAlive = snap.alive;
      remote.snapshot = snap;

      if (remote.tagEl) {
        const nameSpan = remote.tagEl.querySelector('.name');
        const label = snap.name || getTeam(snap.team).name;
        if (nameSpan && nameSpan.textContent !== label) nameSpan.textContent = label;
        const bar = remote.tagEl.querySelector('.hp-bar > i') as HTMLElement | null;
        if (bar) {
          const pct = Math.max(0, Math.min(100, Math.round((snap.hp / Math.max(1, snap.maxHp)) * 100)));
          bar.style.width = `${pct}%`;
        }
      }

      const held = toHeldItem(snap.activeWeapon);
      if (held !== remote.model.held) remote.model.setHeld(held);
      remote.lastUpdate = performance.now();

      if (!snap.alive) remote.model.die();
      else remote.model.revive();
    }

    for (const [id, remote] of this.players) {
      if (!presentIds.has(id)) {
        this.group.remove(remote.model.group);
        remote.hookView.destroy(this.scene);
        remote.tagEl?.remove();
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

  /** Current interpolated remote players (used by SpectatorController). */
  list(): {
    id: string;
    name: string;
    team: TeamId;
    alive: boolean;
    hp: number;
    maxHp: number;
    pos: Vector3;
    up: Vector3;
    frame: Quaternion;
    yaw: number;
    pitch: number;
    weapon: string;
  }[] {
    const out = [];
    for (const r of this.players.values()) {
      const up = new Vector3(0, 1, 0).applyQuaternion(r.currFrame).normalize();
      out.push({
        id: r.snapshot.id,
        name: r.snapshot.name || getTeam(r.snapshot.team).name,
        team: r.snapshot.team,
        alive: r.snapshot.alive,
        hp: r.snapshot.hp,
        maxHp: r.snapshot.maxHp,
        pos: r.currPos,
        up,
        frame: r.currFrame,
        yaw: r.currYaw,
        pitch: r.snapshot.pitch,
        weapon: r.snapshot.activeWeapon,
      });
    }
    return out;
  }

  /** Smoothly interpolate remote players, grappling hooks, and floating nametags once per render frame. */
  update(dt: number, camera?: Camera, myTeam?: TeamId, hasLos?: (pos: Vector3) => boolean) {
    const lerpSpeed = Math.min(1, dt * 18);
    const w = typeof window !== 'undefined' ? window.innerWidth : 0;
    const h = typeof window !== 'undefined' ? window.innerHeight : 0;

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
      _down.copy(_up).negate();
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

      // Grapple hook visual from chest/hand toward anchor
      if (remote.snapshot.alive && remote.snapshot.hookPos) {
        _hand.copy(remote.currPos).addScaledVector(_up, 0.35);
        remote.hookProxy.hook = {
          from: _hand,
          anchor: new Vector3(...remote.snapshot.hookPos),
          phase: remote.snapshot.hookPhase ?? 'pull',
          t: 0.25,
          dist: 0,
          miss: false,
          best: 0,
          still: 0,
        };
        remote.hookView.update(_hand, _down);
      } else {
        remote.hookProxy.hook = null;
        remote.hookView.update(null, _down);
      }

      // Floating nametag + health bar
      const tag = remote.tagEl;
      if (tag) {
        const snap = remote.snapshot;
        if (!camera || !snap.alive) {
          tag.style.display = 'none';
          continue;
        }
        const ally = myTeam ? snap.team === myTeam : false;
        const maxDist = ally ? ALLY_TAG_RANGE : ENEMY_TAG_RANGE;
        _tag.copy(remote.currPos).addScaledVector(_up, TAG_HEIGHT);
        const dist = _tag.distanceTo(camera.position);
        if (dist > maxDist || (!ally && hasLos && !hasLos(_tag))) {
          tag.style.display = 'none';
          continue;
        }
        _proj.copy(_tag).project(camera);
        if (_proj.z > 1 || _proj.x < -1.1 || _proj.x > 1.1 || _proj.y < -1.1 || _proj.y > 1.1) {
          tag.style.display = 'none';
          continue;
        }
        tag.style.display = '';
        tag.style.transform = `translate(${((_proj.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-_proj.y * 0.5 + 0.5) * h).toFixed(1)}px) translate(-50%, -100%)`;
      }
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
      remote.hookView.destroy(this.scene);
      remote.tagEl?.remove();
    }
    this.players.clear();
    this.scene.remove(this.group);
  }
}
