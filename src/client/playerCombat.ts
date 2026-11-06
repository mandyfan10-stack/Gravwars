import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { Combat, CombatEvent, Faction, MAX_HP, Target } from '../shared/combat';
import { CROUCH_EYE_DROP, EYE_OFFSET, TICK_DT } from '../shared/constants';
import { Rng, upOf } from '../shared/math';
import { viewQuat } from '../shared/movement';
import type { PlayerSim } from '../shared/sim';
import { getTeam, TeamId } from '../shared/teams';
import { createWeaponState, hasAmmo, isGun, shotSpread, WEAPON_ORDER, WeaponId, WEAPONS, weaponTick } from '../shared/weapons';
import type { GameAudio } from './audio';
import { Hud, teamHex } from './hud';
import { icon } from './icons';
import type { Fx } from './render/fx';
import type { ViewModel } from './render/viewmodel';

const _vq = new Quaternion();
const _side = new Vector3();
const _upv = new Vector3();
/** Share of the recoil climb that the gun brings back by itself after the trigger is released. */
const RECOIL_RETURN = 0.6;
/** Crouching steadies the aim: spread × this. */
export const CROUCH_ACCURACY = 0.65;

const KILL = icon('swords');
const SELF = icon('skull');
/** Coloured name of a team, or a muted NPC name. */
const teamSpan = (id: Faction, label?: string) => {
  if (id.startsWith('bum:')) return '<span class="npc">Бродяга</span>';
  if (id.startsWith('gang:')) return '<span class="npc">Бандит</span>';
  const t = getTeam(id as TeamId);
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
  private readonly rng = new Rng(9001);
  /** Recoil climb that will come back down once the shooting stops, rad. */
  private recoilDebt = 0;
  private sinceShot = 0;
  /** Moves the view (pitch up, yaw right), rad: recoil kicks the actual aim, not just the camera. */
  onRecoil: (pitch: number, yaw: number) => void = () => {};
  /** Asked when the local player dies: false = no respawn (bed lost). */
  canRespawn: () => boolean = () => true;
  /** The local player was killed (before the respawn): where the body fell and its up. */
  onDeath: (pos: Vector3, up: Vector3) => void = () => {};
  /** The local player killed someone. */
  onKill: (target: Target) => void = () => {};
  /** Any kill (players, bots, NPCs): killer is undefined for falls and unknown sources. */
  onFrag: (killer: Target | undefined, victim: Target, head: boolean) => void = () => {};

  constructor(private sim: PlayerSim, private combat: Combat, private hud: Hud, private fx: Fx,
    private audio: GameAudio, private viewModel: ViewModel) {
    this.me = {
      id: 0, team: sim.team.id, center: sim.state.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1,
      onImpulse: (v) => sim.applyImpulse(v),
    };
    combat.targets.push(this.me);
    combat.guard(this.me);
  }

  /** Restore HP after death / respawn. Bought weapons and ammo are kept. */
  reset() {
    this.me.hp = MAX_HP;
    this.me.alive = true;
    this.combat.guard(this.me);
    this.weapons.reloadT = 0;
    this.weapons.cooldown = 0;
    this.hud.setHp(this.me.hp);
  }

  /** Heal by `amount` (medkit: to full). False if already full. */
  heal(amount = MAX_HP): boolean {
    if (!this.me.alive || this.me.hp >= MAX_HP) return false;
    this.me.hp = Math.min(MAX_HP, this.me.hp + amount);
    this.hud.setHp(this.me.hp);
    return true;
  }

  /** Q: next owned weapon that can be used. */
  toggleWeapon() {
    const ws = this.weapons;
    const i = WEAPON_ORDER.indexOf(ws.current);
    for (let k = 1; k <= WEAPON_ORDER.length; k++) {
      const w = WEAPON_ORDER[(i + k) % WEAPON_ORDER.length];
      if (hasAmmo(ws, w)) { this.pendingSelect = w; return; }
    }
  }

  /** Cone half-angle the next shot would have right now (null: not holding a gun). */
  get nextSpread(): number | null {
    const ws = this.weapons, s = this.sim.state;
    if (!isGun(ws.current)) return null;
    const planar = _upv.copy(s.vel).addScaledVector(this.me.up, -s.vel.dot(this.me.up)).length();
    return shotSpread(WEAPONS[ws.current], ws.heat + 1, planar / this.sim.cfg.maxSpeed, !s.onGround) * (s.crouched ? CROUCH_ACCURACY : 1);
  }

  /** 0..1 while reloading, otherwise 0. */
  get reloadProgress() {
    const ws = this.weapons;
    return ws.reloadT > 0 ? 1 - ws.reloadT / ws.reloadTotal : 0;
  }

  /** Runs once per simulation tick, right after the movement tick. */
  tick(fireHeld: boolean) {
    const { sim, me, weapons } = this;
    upOf(sim.state.frame, me.up);
    const fire = fireHeld || this.forceFire > 0;
    if (this.forceFire > 0) this.forceFire--;
    const fired = weaponTick(weapons, { fire: fire && me.alive, reload: this.pendingReload, select: this.pendingSelect }, TICK_DT);
    if (this.pendingSelect) this.viewModel.setWeapon(weapons.current);
    const reloadStarted = weapons.reloadT > 0 && weapons.reloadT === weapons.reloadTotal;
    if (reloadStarted) {
      this.audio.reload(weapons.current === 'pistol', weapons.reloadTotal, weapons.reloadTotal === WEAPONS[weapons.current].reloadEmpty);
      this.viewModel.reload(weapons.reloadTotal === WEAPONS[weapons.current].reloadEmpty);
    }
    if (weapons.dry) this.audio.dry();
    this.pendingReload = false;
    this.pendingSelect = null;
    this.sinceShot += TICK_DT;
    if (fired) {
      const eye = sim.state.pos.clone().addScaledVector(me.up, EYE_OFFSET - (sim.state.crouched ? CROUCH_EYE_DROP : 0));
      viewQuat(sim.state.frame, sim.state.yaw, sim.state.pitch, _vq);
      const dir = new Vector3(0, 0, -1).applyQuaternion(_vq);
      const def = WEAPONS[fired];
      if (isGun(fired)) {
        // accuracy: a random point in the cone (bloom from the burst, worse on the move / in the air)
        const planar = _upv.copy(sim.state.vel).addScaledVector(me.up, -sim.state.vel.dot(me.up)).length();
        const cone = shotSpread(def, weapons.heat, planar / sim.cfg.maxSpeed, !sim.state.onGround) * (sim.state.crouched ? CROUCH_ACCURACY : 1);
        const a = cone * Math.sqrt(this.rng.next());
        const t = this.rng.next() * Math.PI * 2;
        _side.set(Math.cos(t), Math.sin(t), 0).applyQuaternion(_vq);
        dir.addScaledVector(_side, Math.tan(a)).normalize();
        // recoil: the muzzle climbs; after a few rounds of a burst it also wanders sideways
        const h = weapons.heat;
        const climb = def.recoil * (h <= 6 ? 1 : 0.55) * this.rng.range(0.85, 1.15);
        const wander = def.recoilYaw * ((h > 4 ? 1.6 * Math.sin(h * 0.7) : 0) + this.rng.range(-0.6, 0.6));
        this.onRecoil(climb, wander);
        this.recoilDebt += climb * RECOIL_RETURN;
        this.sinceShot = 0;
      }
      const p = this.combat.use(fired, 0, eye, dir, sim.state.vel, sim.gravityDown());
      if (p && isGun(fired)) {
        const muzzle = this.viewModel.muzzleCameraSpace().applyQuaternion(_vq).add(eye);
        this.fx.setMuzzle(p.id, eye, muzzle);
      }
      this.viewModel.fire();
      this.punch = Math.min(this.punch + (fired === 'rifle' ? 0.5 : fired === 'pistol' ? 0.6 : fired === 'fists' ? 0.15 : 0.3), 1.5);
      // threw the last grenade: back to the best thing in hand
      if (fired === 'grenade' && weapons.ammo.grenade === 0) this.pendingSelect = this.best();
    }
    // released the trigger: the gun settles back part of the way
    if (this.recoilDebt > 0 && this.sinceShot > 0.12) {
      const back = Math.min(this.recoilDebt, this.recoilDebt * TICK_DT * 9 + TICK_DT * 0.01);
      this.recoilDebt -= back;
      this.onRecoil(-back, 0);
    }
    this.combat.tick(TICK_DT);
    for (const e of this.combat.events.splice(0)) this.onCombat(e);
  }

  /** Best weapon with something to shoot. */
  best(): WeaponId {
    const ws = this.weapons;
    return (['rifle', 'pistol'] as const).find((w) => hasAmmo(ws, w)) ?? 'fists';
  }

  private onCombat(e: CombatEvent) {
    const { hud, me } = this;
    this.fx.handle(e);
    if (e.type === 'fire' && isGun(e.weapon)) this.audio.shot(e.weapon === 'pistol', e.owner === 0 ? 0 : e.origin.distanceTo(this.sim.state.pos));
    if (e.type === 'ricochet') this.audio.ricochet(e.pos.distanceTo(this.sim.state.pos));
    if (e.type === 'impact' && e.pos.distanceTo(this.sim.state.pos) < 25) this.audio.impact(e.material ?? 'concrete', e.pos.distanceTo(this.sim.state.pos));
    if (e.type === 'melee' && e.owner === 0) this.audio.punch(e.pos !== null);
    if (e.type === 'explode') this.audio.explosion();
    if (e.type === 'hit') {
      const tg = this.combat.target(e.target)!;
      if (e.killed) this.onFrag(this.combat.target(e.owner), tg, e.head);
      if (e.owner === 0 && e.target !== 0) {
        hud.hitmarker(e.killed, e.head);
        if (e.killed) {
          hud.killfeed(`${teamSpan(me.team, 'Ты')}${KILL}${teamSpan(tg.team)}${e.head ? ' · в голову' : ''}`);
          this.onKill(tg);
        }
      }
      // street fights between city NPCs are not news: the feed is about players and bots
      if (e.killed && e.owner !== 0 && e.target !== 0 && !(tg.npc && this.combat.target(e.owner)?.npc)) {
        const killer = this.combat.target(e.owner);
        hud.killfeed(e.owner === e.target || !killer ? `${SELF}${teamSpan(tg.team)} подорвался` : `${teamSpan(killer.team)}${KILL}${teamSpan(tg.team)}`);
      }
      if (e.target === 0) {
        hud.hurt(e.damage);
        hud.setHp(me.hp);
        if (e.killed) {
          this.onDeath(this.sim.state.pos.clone(), me.up.clone());
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
