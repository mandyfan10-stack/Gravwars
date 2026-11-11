import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { Combat, CombatEvent, Faction, HitSource, MAX_HP, Target } from '../shared/combat';
import { CROUCH_EYE_DROP, EYE_OFFSET, TICK_DT } from '../shared/constants';
import { Rng, upOf } from '../shared/math';
import { viewQuat } from '../shared/movement';
import type { PlayerSim } from '../shared/sim';
import { getTeam, TeamId } from '../shared/teams';
import { crossbowSpec, createWeaponState, hasAmmo, isGun, kicked, kickReady, shotSpread, WEAPON_ORDER, WeaponId, WEAPONS, weaponTick } from '../shared/weapons';
import type { GameAudio } from './audio';
import { Hud, teamHex } from './hud';
import { icon, IconName } from './icons';
import type { Fx } from './render/fx';
import type { ViewModel } from './render/viewmodel';

const _vq = new Quaternion();
const _side = new Vector3();
const _upv = new Vector3();
/** Share of the recoil climb that the gun brings back by itself after the trigger is released. */
const RECOIL_RETURN = 0.6;
/** Crouching steadies the aim: spread × this. */
export const CROUCH_ACCURACY = 0.65;

const SELF = icon('skull');
/** Seconds between a death and the respawn (the death screen). */
export const DEATH_TIME = 4;
const SOURCE_ICON: Record<HitSource, IconName> = {
  fists: 'fist', kick: 'kick', pistol: 'pistol', shotgun: 'shotgun', rifle: 'rifle', crossbow: 'crossbow', rocket: 'rocket', grenade: 'grenade',
};
export const SOURCE_NAME: Record<HitSource, string> = {
  fists: 'кулаки', kick: 'пинок', pistol: 'пистолет', shotgun: 'дробовик', rifle: 'автомат', crossbow: 'арбалет', rocket: 'ракетница', grenade: 'граната',
};
/** Kill-feed separator: the weapon that did it. */
const killIcon = (w?: HitSource) => icon(w ? SOURCE_ICON[w] : 'swords');

/** How the local player died: shown on the death screen. */
export interface Death {
  /** Seconds left until the respawn (counts down; stays at 0 when `final`). */
  t: number;
  /** Where the body was and its up. */
  pos: Vector3;
  up: Vector3;
  eye: Vector3;
  /** Looking direction at the moment of death. */
  look: Vector3;
  killer?: Target;
  weapon?: HitSource;
  head: boolean;
  /** Killer's distance at the moment, m. */
  dist: number;
  cause: 'killed' | 'self' | 'fall' | 'void';
  /** No crystal left: no respawn. */
  final: boolean;
}
/** Coloured name of a team, or a muted NPC name. */
const teamSpan = (id: Faction, label?: string) => {
  if (id.startsWith('bum:')) return '<span class="npc">Бродяга</span>';
  if (id.startsWith('gang:')) return '<span class="npc">Бандит</span>';
  if (id.startsWith('car:')) return '<span class="npc">Машина</span>';
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
  /** The local player respawned after being dead. */
  onRespawn: () => void = () => {};
  /** The local player killed someone. */
  onKill: (target: Target) => void = () => {};
  /** Any kill (players, bots, NPCs): killer is undefined for falls and unknown sources. */
  onFrag: (killer: Target | undefined, victim: Target, head: boolean) => void = () => {};
  /** Set while the local player is dead (the death screen); null when alive. */
  death: Death | null = null;

  constructor(private sim: PlayerSim, private combat: Combat, private hud: Hud, private fx: Fx,
    private audio: GameAudio, private viewModel: ViewModel) {
    this.me = {
      id: 0, team: sim.team.id, center: sim.state.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1, regen: true,
      airborne: () => !sim.state.onGround,
      onImpulse: (v) => sim.applyImpulse(v),
    };
    combat.targets.push(this.me);
    combat.guard(this.me);
  }

  /** Restore HP after death / respawn. Bought weapons and ammo are kept. */
  reset() {
    const wasDead = this.death !== null;
    this.death = null;
    this.me.hp = MAX_HP;
    this.me.alive = true;
    this.combat.guard(this.me);
    this.weapons.reloadT = 0;
    this.weapons.cooldown = 0;
    this.weapons.chargeT = 0;
    this.weapons.lastChargeT = 0;
    this.hud.setHp(this.me.hp);
    if (wasDead) this.onRespawn();
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

  /** V: a kick (splash in front, pushes people and crates). Cooldown 2 s after hitting a fighter/NPC, 0.1 s otherwise. */
  kick() {
    const { sim, me, weapons } = this;
    if (!me.alive || !kickReady(weapons)) return;
    const eye = this.eye();
    viewQuat(sim.state.frame, sim.state.yaw, sim.state.pitch, _vq);
    const dir = new Vector3(0, 0, -1).applyQuaternion(_vq);
    const hits = this.combat.kick(0, eye, dir, me.up);
    const lastEv = this.combat.events[this.combat.events.length - 1];
    const hitLiving = lastEv?.type === 'melee' && lastEv.target !== null;
    kicked(weapons, hitLiving);
    this.viewModel.kick();
    this.punch = Math.min(this.punch + (hits ? 0.9 : 0.4), 1.5);
    if (hits) this.shake = Math.max(this.shake, 0.25);
  }

  /** Kick cooldown 0..1 left (0 = ready). */
  get kickCooldown() {
    const ws = this.weapons;
    return ws.kickCd > 0 ? ws.kickCd / ws.kickCdTotal : 0;
  }

  private eye() {
    const { sim, me } = this;
    return sim.state.pos.clone().addScaledVector(me.up, EYE_OFFSET - (sim.state.crouched ? CROUCH_EYE_DROP : 0));
  }

  /**
   * The local player died (killed, or fell into the void): the body bursts, the death screen runs, and after
   * DEATH_TIME the player is back at the spawn (unless the crystal is gone). The sim is moved to the spawn right away
   * (the body must not stay around to block or be shot), the controls stay off until the respawn.
   */
  die(cause: Death['cause'], killer?: Target, weapon?: HitSource, head = false) {
    const { sim, me } = this;
    if (this.death) return;
    const pos = sim.state.pos.clone(), up = me.up.clone();
    viewQuat(sim.state.frame, sim.state.yaw, sim.state.pitch, _vq);
    const look = new Vector3(0, 0, -1).applyQuaternion(_vq);
    const final = !this.canRespawn();
    this.death = {
      t: DEATH_TIME, pos, up, eye: this.eye(), look, killer, weapon, head, cause, final,
      dist: killer ? killer.center.distanceTo(pos) : 0,
    };
    me.alive = false;
    me.hp = 0;
    this.hud.setHp(0);
    this.recoilDebt = 0;
    if (cause !== 'void') {
      this.onDeath(pos, up);
      this.fx.blood(pos);
      this.audio.gore(0);
    }
    this.audio.death();
    sim.releaseHook();
    if (cause !== 'void') sim.respawn('killed');
  }

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
    if (this.death && !this.death.final) {
      this.death.t -= TICK_DT;
      if (this.death.t <= 0) this.reset();
    }
    const prevChargeLvl = weapons.current === 'crossbow' ? Math.min(3, Math.floor(weapons.chargeT)) : 0;
    const fired = weaponTick(weapons, { fire: fire && me.alive, reload: this.pendingReload, select: this.pendingSelect, airborne: !sim.state.onGround }, TICK_DT);
    if (weapons.current === 'crossbow' && weapons.chargeT > 0) {
      const newChargeLvl = Math.min(3, Math.floor(weapons.chargeT));
      if (newChargeLvl > prevChargeLvl) this.audio.crossbowCharge(newChargeLvl);
    }
    if (this.pendingSelect) this.viewModel.setWeapon(weapons.current);
    const reloadStarted = weapons.reloadT > 0 && weapons.reloadT === weapons.reloadTotal;
    if (reloadStarted) {
      const w = weapons.current;
      if (w !== 'crossbow') {
        this.audio.reload(w === 'pistol', weapons.reloadTotal, weapons.reloadTotal === WEAPONS[w].reloadEmpty,
          w === 'shotgun' ? 'shells' : w === 'rocket' ? 'rocket' : 'mag');
      }
      this.viewModel.reload(weapons.reloadTotal === WEAPONS[weapons.current].reloadEmpty);
    }
    if (weapons.dry) this.audio.dry();
    this.pendingReload = false;
    this.pendingSelect = null;
    this.sinceShot += TICK_DT;
    if (fired) {
      const eye = this.eye();
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
      // in the air a shot pushes you back; shotgun also kicks the shooter back on the ground
      if (fired === 'crossbow') {
        const spec = crossbowSpec(weapons.lastChargeT);
        const xbowRecoil = 2.0 + spec.level * 2.8; // scale owner pushback with charge level
        sim.applyImpulse(dir.clone().multiplyScalar(-xbowRecoil));
      } else if (!sim.state.onGround && def.airPush) {
        sim.applyImpulse(dir.clone().multiplyScalar(-def.airPush));
      } else if (sim.state.onGround && fired === 'shotgun') {
        sim.applyImpulse(dir.clone().multiplyScalar(-def.airPush * 0.38));
      }
      const p = this.combat.use(fired, 0, eye, dir, sim.state.vel, sim.gravityDown(), weapons.lastChargeT);
      if (p && isGun(fired)) {
        // every pellet of a shotgun blast starts from the muzzle
        const muzzle = this.viewModel.muzzleCameraSpace().applyQuaternion(_vq).add(eye);
        for (const q of this.combat.volley) this.fx.setMuzzle(q.id, eye, muzzle);
      }
      this.viewModel.fire();
      const cbLvl = fired === 'crossbow' ? Math.min(3, Math.floor(weapons.lastChargeT)) : 0;
      const kick: Partial<Record<WeaponId, number>> = { rifle: 0.5, pistol: 0.6, shotgun: 1.1, crossbow: 0.35 + cbLvl * 0.2, rocket: 0.9, fists: 0.15 };
      this.punch = Math.min(this.punch + (kick[fired] ?? 0.3), 1.5);
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
    return (['rifle', 'crossbow', 'shotgun', 'pistol'] as const).find((w) => hasAmmo(ws, w)) ?? 'fists';
  }

  private onCombat(e: CombatEvent) {
    const { hud, me } = this;
    const at = this.sim.state.pos;
    this.fx.handle(e);
    if (e.type === 'fire') {
      const d = e.owner === 0 ? 0 : e.origin.distanceTo(at);
      if (e.weapon === 'shotgun') this.audio.shotgun(d, e.owner === 0);
      else if (e.weapon === 'rocket') this.audio.rocket(d);
      else if (e.weapon === 'crossbow') this.audio.crossbowShot(Math.min(3, Math.floor(this.weapons.lastChargeT)), d);
      else if (isGun(e.weapon)) this.audio.shot(e.weapon === 'pistol', d);
    }
    if (e.type === 'ricochet') this.audio.ricochet(e.pos.distanceTo(at));
    if (e.type === 'impact' && e.pos.distanceTo(at) < 25) this.audio.impact(e.material ?? 'concrete', e.pos.distanceTo(at));
    if (e.type === 'melee') {
      if (e.owner === 0) {
        if (e.kind === 'kick') this.audio.kick(e.hits > 0);
        else this.audio.punch(e.pos !== null);
        if (e.kind === 'punch' && e.target !== null) this.shake = Math.max(this.shake, 0.12);
      } else if (e.pos && e.pos.distanceTo(at) < 20 && e.hits > 0) {
        if (e.kind === 'kick') this.audio.kick(true);
        else this.audio.punch(true);
      }
    }
    if (e.type === 'crystal' && (e.owner === 0 || e.pos.distanceTo(at) < 30)) this.audio.crystalHit(e.far, e.owner === 0 ? 0 : e.pos.distanceTo(at));
    if (e.type === 'explode') this.audio.explosion();
    if (e.type === 'hit') {
      const tg = this.combat.target(e.target)!;
      if (e.killed) this.onFrag(this.combat.target(e.owner), tg, e.head);
      if (e.owner === 0 && e.target !== 0) {
        hud.hitmarker(e.killed, e.head);
        if (e.killed) {
          hud.killfeed(`${teamSpan(me.team, 'Ты')}${killIcon(e.weapon)}${teamSpan(tg.team)}${e.head ? ' · в голову' : ''}`);
          this.onKill(tg);
        }
      }
      // street fights between city NPCs are not news: the feed is about players and bots
      if (e.killed && e.owner !== 0 && e.target !== 0 && !(tg.npc && this.combat.target(e.owner)?.npc)) {
        const killer = this.combat.target(e.owner);
        hud.killfeed(e.owner === e.target || !killer ? `${SELF}${teamSpan(tg.team)} ${e.cause === 'fall' ? 'разбился' : 'подорвался'}`
          : `${teamSpan(killer.team)}${killIcon(e.weapon)}${teamSpan(tg.team)}${e.head ? ' · в голову' : ''}`);
      }
      if (e.target === 0) {
        hud.hurt(e.damage);
        if (e.cause === 'fall') this.audio.fallHurt();
        hud.setHp(me.hp);
        if (e.killed) {
          const killer = e.owner !== 0 ? this.combat.target(e.owner) : undefined;
          hud.killfeed(e.owner === 0 || !killer ? `${SELF}${teamSpan(me.team, 'Ты')} ${e.cause === 'fall' ? 'разбился' : 'подорвался'}`
            : `${teamSpan(killer.team)}${killIcon(e.weapon)}${teamSpan(me.team, 'Ты')}`);
          this.die(killer ? 'killed' : e.cause === 'fall' ? 'fall' : 'self', killer, e.weapon, e.head);
        }
      }
    } else if (e.type === 'explode') {
      const d = e.pos.distanceTo(at);
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
