import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { Combat, CombatEvent, MAX_HP, Target } from '../shared/combat';
import { EYE_OFFSET, TICK_DT } from '../shared/constants';
import { upOf } from '../shared/math';
import { viewQuat } from '../shared/movement';
import type { PlayerSim } from '../shared/sim';
import { getTeam, TeamId } from '../shared/teams';
import { createWeaponState, WeaponId, WEAPONS, weaponTick } from '../shared/weapons';
import type { GameAudio } from './audio';
import { Hud, teamHex } from './hud';
import { icon } from './icons';
import type { Fx } from './render/fx';
import type { ViewModel } from './render/viewmodel';

const _vq = new Quaternion();

const KILL = icon('swords');
const SELF = icon('skull');
const teamSpan = (id: TeamId, label?: string) => {
  const t = getTeam(id);
  return `<span style="color:${teamHex(t.color)}">${label ?? t.name}</span>`;
};

/** Local player's combat: weapon state, firing, hit / death feedback, recoil and explosion shake. */
export class PlayerCombat {
  /** The local player as a combat target (id 0). */
  readonly me: Target;
  readonly weapons = createWeaponState();
  pendingSelect: WeaponId | null = null;
  pendingReload = false;
  /** Debug / tests: fire for this many ticks regardless of input. */
  forceFire = 0;
  private punch = 0;
  private shake = 0;
  /** Asked when the local player dies: false = no respawn (bed lost). */
  canRespawn: () => boolean = () => true;
  /** The local player killed someone. */
  onKill: (target: Target) => void = () => {};

  constructor(private sim: PlayerSim, private combat: Combat, private hud: Hud, private fx: Fx,
    private audio: GameAudio, private viewModel: ViewModel) {
    this.me = {
      id: 0, team: sim.team.id, center: sim.state.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1,
      onImpulse: (v) => sim.applyImpulse(v),
    };
    combat.targets.push(this.me);
  }

  /** Restore HP and weapons (after death / respawn). */
  reset() {
    this.me.hp = MAX_HP;
    this.me.alive = true;
    Object.assign(this.weapons, createWeaponState());
    this.hud.setHp(this.me.hp);
  }

  /** Medkit: back to full HP. False if already full. */
  heal(): boolean {
    if (!this.me.alive || this.me.hp >= MAX_HP) return false;
    this.me.hp = MAX_HP;
    this.hud.setHp(this.me.hp);
    return true;
  }

  toggleWeapon() {
    this.pendingSelect = this.weapons.current === 'rifle' ? 'grenade' : 'rifle';
  }

  /** 0..1 while reloading the rifle, otherwise 0. */
  get reloadProgress() {
    return this.weapons.reloadT > 0 ? 1 - this.weapons.reloadT / WEAPONS.rifle.reload : 0;
  }

  /** Runs once per simulation tick, right after the movement tick. */
  tick(fireHeld: boolean) {
    const { sim, me, weapons } = this;
    upOf(sim.state.frame, me.up);
    const fire = fireHeld || this.forceFire > 0;
    if (this.forceFire > 0) this.forceFire--;
    const fired = weaponTick(weapons, { fire: fire && me.alive, reload: this.pendingReload, select: this.pendingSelect }, TICK_DT);
    if (this.pendingSelect) this.viewModel.setWeapon(weapons.current);
    this.pendingReload = false;
    this.pendingSelect = null;
    if (fired) {
      const eye = sim.state.pos.clone().addScaledVector(me.up, EYE_OFFSET);
      viewQuat(sim.state.frame, sim.state.yaw, sim.state.pitch, _vq);
      const dir = new Vector3(0, 0, -1).applyQuaternion(_vq);
      const p = this.combat.fire(fired, 0, eye, dir, sim.state.vel, sim.gravityDown());
      if (fired === 'rifle') {
        const muzzle = this.viewModel.muzzleCameraSpace().applyQuaternion(_vq).add(eye);
        this.fx.setMuzzle(p.id, eye, muzzle);
      }
      this.viewModel.fire();
      this.punch = Math.min(this.punch + (fired === 'rifle' ? 0.5 : 0.3), 1.5);
    }
    this.combat.tick(TICK_DT);
    for (const e of this.combat.events.splice(0)) this.onCombat(e);
  }

  private onCombat(e: CombatEvent) {
    const { hud, me } = this;
    this.fx.handle(e);
    if (e.type === 'fire' && e.weapon === 'rifle') this.audio.shot();
    if (e.type === 'explode') this.audio.explosion();
    if (e.type === 'hit') {
      const tg = this.combat.target(e.target)!;
      if (e.owner === 0 && e.target !== 0) {
        hud.hitmarker(e.killed, e.head);
        if (e.killed) {
          hud.killfeed(`${teamSpan(me.team, 'Ты')}${KILL}${teamSpan(tg.team)}${e.head ? ' · в голову' : ''}`);
          this.onKill(tg);
        }
      }
      if (e.killed && e.owner !== 0 && e.target !== 0) {
        const killer = this.combat.target(e.owner);
        hud.killfeed(e.owner === e.target || !killer ? `${SELF}${teamSpan(tg.team)} подорвался` : `${teamSpan(killer.team)}${KILL}${teamSpan(tg.team)}`);
      }
      if (e.target === 0) {
        hud.hurt(e.damage);
        hud.setHp(me.hp);
        if (e.killed) {
          hud.killfeed(e.owner === 0 ? `${SELF}${teamSpan(me.team, 'Ты')} подорвался` : `${teamSpan(this.combat.target(e.owner)?.team ?? 'red')}${KILL}${teamSpan(me.team, 'Ты')}`);
          if (this.canRespawn()) {
            this.sim.respawn('killed');
            this.reset();
          }
        }
      }
    } else if (e.type === 'explode') {
      const d = e.pos.distanceTo(this.sim.state.pos);
      this.shake = Math.max(this.shake, Math.max(0, 1 - d / 18));
    }
  }

  /** View punch (recoil) + explosion shake on top of the already placed camera. */
  applyCameraKick(camera: PerspectiveCamera, dt: number) {
    this.punch = Math.max(0, this.punch - dt * 6);
    this.shake = Math.max(0, this.shake - dt * 1.8);
    camera.rotateX(this.punch * 0.025);
    if (this.shake > 0) {
      camera.rotateX((Math.random() - 0.5) * this.shake * 0.05);
      camera.rotateY((Math.random() - 0.5) * this.shake * 0.05);
    }
    camera.updateMatrixWorld();
  }
}
