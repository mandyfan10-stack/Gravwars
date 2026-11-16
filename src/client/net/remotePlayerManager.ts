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
/** GoldSrc/Source entity interpolation delay (ms behind estimated latest server snapshot clock). */
export const INTERP_DELAY_MS = 100;
const MAX_ENTITY_HISTORY = 32;

const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

function toHeldItem(w: string): HeldItem {
  if (
    w === 'pistol' || w === 'revolver' || w === 'rifle' || w === 'shotgun' || w === 'crossbow' ||
    w === 'rocket' || w === 'hook' || w === 'fists' || w === 'grenade' || w === 'rod'
  ) {
    return w;
  }
  return 'fists';
}

export interface EntitySnapshotEntry {
  timeMs: number;
  pos: Vector3;
  vel: Vector3;
  frame: Quaternion;
  yaw: number;
  pitch: number;
}

/** Wrap shortest angular delta into [-π, π] and linearly interpolate yaw. */
function lerpAngle(a: number, b: number, t: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(t)) return Number.isFinite(a) ? a : 0;
  const tau = Math.PI * 2;
  let d = (b - a) % tau;
  if (d > Math.PI) d -= tau;
  else if (d < -Math.PI) d += tau;
  return a + d * t;
}

/**
 * Sample a remote entity's interpolated state at `renderTimeMs` (`serverClock - INTERP_DELAY_MS`)
 * using its timestamped server snapshot history buffer.
 */
export function sampleEntityInterpolation(
  buffer: readonly EntitySnapshotEntry[],
  renderTimeMs: number,
  outPos: Vector3,
  outFrame: Quaternion,
): { yaw: number; vel: Vector3 } {
  if (!buffer.length) return { yaw: 0, vel: _vel.set(0, 0, 0) };
  if (buffer.length === 1 || renderTimeMs <= buffer[0].timeMs) {
    const first = buffer[0];
    outPos.copy(first.pos);
    outFrame.copy(first.frame);
    return { yaw: first.yaw, vel: first.vel };
  }
  const last = buffer[buffer.length - 1];
  if (renderTimeMs >= last.timeMs) {
    // Brief bounded linear velocity extrapolation (≤ 120 ms) if a packet arrived late
    const extraS = Math.min(0.12, Math.max(0, (renderTimeMs - last.timeMs) / 1000));
    outPos.copy(last.pos).addScaledVector(last.vel, extraS);
    outFrame.copy(last.frame);
    return { yaw: last.yaw, vel: last.vel };
  }
  // Find bracketing pair A.timeMs <= renderTimeMs <= B.timeMs
  let lo = 0;
  let hi = buffer.length - 1;
  for (let i = 0; i < buffer.length - 1; i++) {
    if (buffer[i].timeMs <= renderTimeMs && buffer[i + 1].timeMs >= renderTimeMs) {
      lo = i;
      hi = i + 1;
      break;
    }
  }
  const a = buffer[lo];
  const b = buffer[hi];
  // Guard against teleport / respawn / face-switch discontinuities: snap instead of blurring across cube
  if (a.pos.distanceToSquared(b.pos) > 324) {
    outPos.copy(b.pos);
    outFrame.copy(b.frame);
    return { yaw: b.yaw, vel: b.vel };
  }
  const span = Math.max(1, b.timeMs - a.timeMs);
  const t = Math.max(0, Math.min(1, (renderTimeMs - a.timeMs) / span));
  outPos.lerpVectors(a.pos, b.pos, t);
  outFrame.slerpQuaternions(a.frame, b.frame, t);
  return { yaw: lerpAngle(a.yaw, b.yaw, t), vel: _vel.lerpVectors(a.vel, b.vel, t) };
}

interface InterpolatedRemotePlayer {
  snapshot: RemotePlayerSnapshot;
  model: PlayerModel;
  hookProxy: { hook: PlayerSim['hook'] };
  hookView: HookView;
  tagEl: HTMLElement | null;
  buffer: EntitySnapshotEntry[];
  currPos: Vector3;
  currVel: Vector3;
  currFrame: Quaternion;
  currYaw: number;
  prevHp: number;
  prevAlive: boolean;
  firedOnce: boolean;
  lastUpdate: number;
}

/**
 * Manages 3D humanoid models, grappling hooks, floating nametags, and GoldSrc-style Entity Interpolation
 * (`renderTime = estServerTime - INTERP_DELAY_MS` across timestamped server snapshots).
 */
export class RemotePlayerManager {
  readonly group = new Group();
  private players = new Map<string, InterpolatedRemotePlayer>();
  private readonly markersEl = typeof document !== 'undefined' ? document.getElementById('markers') : null;
  private estServerTimeMs = 0;
  private lastRecvLocalMs = 0;

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

  /** Record authoritative snapshot entry into each remote entity's interpolation history buffer. */
  applySnapshot(snapshots: RemotePlayerSnapshot[], localPlayerId: string, serverTimeMs?: number) {
    const presentIds = new Set<string>();
    const nowLocal = performance.now();
    const stampMs = serverTimeMs !== undefined && Number.isFinite(serverTimeMs) ? serverTimeMs : nowLocal;
    if (this.estServerTimeMs === 0 || Math.abs(stampMs - this.estServerTimeMs) > 600) {
      this.estServerTimeMs = stampMs;
    } else if (stampMs > this.estServerTimeMs) {
      this.estServerTimeMs = stampMs;
    }
    this.lastRecvLocalMs = nowLocal;

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
          buffer: [],
          currPos: new Vector3(...snap.pos),
          currVel: new Vector3(...snap.vel),
          currFrame: new Quaternion(...snap.frame),
          currYaw: snap.yaw,
          prevHp: snap.hp,
          prevAlive: snap.alive,
          firedOnce: false,
          lastUpdate: nowLocal,
        };
        this.players.set(snap.id, remote);
      }

      const entry: EntitySnapshotEntry = {
        timeMs: stampMs,
        pos: new Vector3(...snap.pos),
        vel: new Vector3(...snap.vel),
        frame: new Quaternion(...snap.frame),
        yaw: snap.yaw,
        pitch: snap.pitch,
      };

      // Snap immediately on respawn or large teleport rather than sliding across the arena
      const last = remote.buffer[remote.buffer.length - 1];
      if ((!remote.prevAlive && snap.alive) || (last && last.pos.distanceToSquared(entry.pos) > 324)) {
        remote.buffer.length = 0;
        remote.currPos.copy(entry.pos);
        remote.currFrame.copy(entry.frame);
        remote.currYaw = entry.yaw;
      }

      if (!last || entry.timeMs > last.timeMs) {
        remote.buffer.push(entry);
        if (remote.buffer.length > MAX_ENTITY_HISTORY) remote.buffer.shift();
      } else {
        // Handle non-timestamped repeat calls monotonically
        entry.timeMs = last.timeMs + 16;
        remote.buffer.push(entry);
        if (remote.buffer.length > MAX_ENTITY_HISTORY) remote.buffer.shift();
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

  /** Interpolate remote entities at `renderTime = estimatedServerTime - 100 ms` across history buffers. */
  update(dt: number, camera?: Camera, myTeam?: TeamId, hasLos?: (pos: Vector3) => boolean) {
    const w = typeof window !== 'undefined' ? window.innerWidth : 0;
    const h = typeof window !== 'undefined' ? window.innerHeight : 0;
    const nowLocal = performance.now();
    const elapsedSinceSnap = this.lastRecvLocalMs > 0 ? Math.min(250, Math.max(0, nowLocal - this.lastRecvLocalMs)) : 0;
    const renderTimeMs = (this.estServerTimeMs + elapsedSinceSnap) - INTERP_DELAY_MS;

    for (const remote of this.players.values()) {
      const res = sampleEntityInterpolation(remote.buffer, renderTimeMs, remote.currPos, remote.currFrame);
      remote.currYaw = res.yaw;
      remote.currVel.copy(res.vel);

      remote.model.setPose(remote.currPos, remote.currFrame, remote.currYaw);

      _vel.copy(remote.currVel);
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

  /** Returns the latest received snapshots for all remote players. */
  getSnapshots(): RemotePlayerSnapshot[] {
    const out: RemotePlayerSnapshot[] = [];
    for (const p of this.players.values()) out.push(p.snapshot);
    return out;
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
