import { Vector3 } from 'three';
import { HU } from '../shared/constants';
import { STAMINA } from '../shared/movement';
import { HOOK, PlayerSim } from '../shared/sim';
import { ITEMS } from '../shared/economy';
import { isGun, WEAPONS, WeaponState } from '../shared/weapons';
import { faceByUp } from '../shared/map';
import { getTeam, TeamId } from '../shared/teams';
import { icon, IconName } from './icons';
import type { ViewTool } from './render/viewmodel';

const $ = (id: string) => document.getElementById(id)!;
const _down = new Vector3();
const _up = new Vector3();

export class Hud {
  constructor() {
    document.querySelector('#hp .hp-ic')!.innerHTML = icon('heart');
    document.querySelector('#kick .k-ic')!.innerHTML = icon('kick');
    document.querySelector('#wind .wind-ic')!.innerHTML = icon('wind');
  }

  private speed = $('speed-val');
  private gravDot = $('grav-dot');
  private gravName = $('grav-name');
  private info = $('info');
  private toastEl = $('toast');
  private toastTimer = 0;
  private fps = 60;
  private lastTeam = '';

  private hpVal = $('hp-val');
  private hpBar = $('hp-bar');
  private stEl = $('st');
  private stBar = $('st-bar');
  private guardEl = $('guard');
  private wName = $('weapon-name');
  private ammo = $('ammo');
  private windArrow = $('wind-arrow');
  private windVal = $('wind-val');
  private hit = $('hitmarker');
  private hurtEl = $('hurt');
  private feed = $('feed');
  private hitT = 0;
  private hurtT = 0;

  /** Spawn protection indicator (seconds left, or null = none). */
  setGuard(t: number | null) {
    this.guardEl.hidden = t === null;
    if (t !== null) this.guardEl.textContent = `Защита после спавна · ${Math.ceil(t)}`;
  }

  setHp(hp: number) {
    this.hpVal.textContent = String(Math.ceil(hp));
    this.hpBar.style.width = `${Math.max(0, hp)}%`;
    this.hpBar.style.background = hp > 50 ? 'var(--hp)' : hp > 25 ? '#ffc94a' : '#ff5a5a';
  }

  private readonly weaponIc = document.getElementById('weapon-ic')!;
  private iconKey = '';

  /** Weapon / ammo panel: what is in the hands. `items`: pocket counts (for an item in hand). */
  setWeapon(ws: WeaponState, tool: ViewTool, items: Record<string, number>) {
    const active = tool ?? ws.current;
    if (active !== this.iconKey) {
      this.iconKey = active;
      const ic: Record<string, IconName> = {
        fists: 'fist', pistol: 'pistol', shotgun: 'shotgun', rifle: 'rifle', rocket: 'rocket', grenade: 'grenade', build: 'shovel', hook: 'hook',
        rod: 'rod', apple: 'apple', bottle: 'bottle', fish: 'fish', medkit: 'heart',
      };
      this.weaponIc.innerHTML = icon(ic[active]);
    }
    if (tool && tool in ITEMS) {
      const it = ITEMS[tool as keyof typeof ITEMS];
      this.wName.textContent = it.name;
      const hint = tool === 'medkit' ? 'ЛКМ — вылечиться' : it.heal ? 'ЛКМ — съесть' : 'ЛКМ — бросить';
      this.ammo.innerHTML = `${items[tool] ?? 0}<small> ${hint}</small>`;
      return;
    }
    if (tool === 'build') {
      this.wName.textContent = 'Строительство';
      this.ammo.innerHTML = '<small>ЛКМ — строить</small>';
      return;
    }
    if (tool === 'rod') {
      this.wName.textContent = 'Удочка';
      this.ammo.innerHTML = '<small>ЛКМ — забросить в пруд</small>';
      return;
    }
    if (tool === 'hook') {
      this.wName.textContent = 'Крюк-кошка';
      this.ammo.innerHTML = `<small>ЛКМ — зацепиться (до ${HOOK.range} м), ещё раз — отпустить</small>`;
      return;
    }
    const w = ws.current;
    const def = WEAPONS[w];
    this.wName.textContent = def.name;
    if (w === 'fists') this.ammo.innerHTML = '<small>ЛКМ — удар</small>';
    else if (isGun(w)) {
      this.ammo.innerHTML = ws.reloadT > 0 ? '<span class="reload">перезарядка…</span>'
        : `<span class="${ws.ammo[w] === 0 ? 'empty' : ''}">${ws.ammo[w]}</span><small>/${ws.reserve[w]}</small>`;
    } else {
      this.ammo.innerHTML = `<div class="pips">${'<i></i>'.repeat(ws.ammo.grenade)}${'<i class="empty"></i>'.repeat(def.mag - ws.ammo.grenade)}</div>`;
    }
  }

  private readonly kickEl = $('kick');
  private readonly kickBar = $('kick').querySelector('i')!;
  private kickKey = -1;
  /** Kick (V) readiness: 0 = ready, else the share of the cooldown left. */
  setKick(left: number) {
    const k = Math.round(left * 50);
    if (k === this.kickKey) return;
    this.kickKey = k;
    this.kickEl.classList.toggle('cd', left > 0);
    this.kickBar.style.width = `${((1 - left) * 100).toFixed(0)}%`;
  }

  /** angle: radians, 0 = blowing forward (away from you), positive = to the right. */
  setWind(angle: number, strength: number, vertical: number) {
    this.windArrow.style.transform = `rotate(${angle}rad) scale(${0.6 + Math.min(strength / 7, 1) * 0.6})`;
    this.windArrow.style.opacity = String(0.35 + Math.min(strength / 7, 1) * 0.65);
    this.windVal.textContent = `${strength.toFixed(1)}${Math.abs(vertical) > 0.5 ? (vertical > 0 ? ' ↑' : ' ↓') : ''}`;
  }

  hitmarker(kill: boolean, head: boolean) {
    this.hit.className = kill ? 'show kill' : head ? 'show head' : 'show';
    this.hitT = kill ? 0.35 : 0.15;
  }

  hurt(amount: number) {
    this.hurtT = Math.min(1, this.hurtT + amount / 40);
  }

  private readonly cross = document.getElementById('crosshair')!;
  private crossGap = 6;
  /** Spread ticks around the crosshair: `cone` rad at this vertical FOV (deg); null hides them. */
  setSpread(cone: number | null, fovDeg: number) {
    this.cross.classList.toggle('gun', cone !== null);
    if (cone === null) return;
    const px = Math.tan(cone) / Math.tan((fovDeg * Math.PI) / 360) * (window.innerHeight / 2);
    // ease, so the ticks breathe instead of jumping
    this.crossGap += (Math.max(3, px) - this.crossGap) * 0.35;
    this.cross.style.setProperty('--gap', `${this.crossGap.toFixed(1)}px`);
  }

  killfeed(html: string) {
    const el = document.createElement('div');
    el.innerHTML = html;
    this.feed.prepend(el);
    setTimeout(() => el.remove(), 5000);
    while (this.feed.children.length > 5) this.feed.lastChild!.remove();
  }

  toast(text: string, color = '#fff', time = 1.6) {
    this.toastEl.textContent = text;
    this.toastEl.style.setProperty('--c', color);
    this.toastEl.classList.add('show');
    this.toastTimer = time;
  }

  update(dt: number, sim: PlayerSim, extra: string) {
    this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.05;
    const s = sim.state;
    _up.set(0, 1, 0).applyQuaternion(s.frame);
    const planar = s.vel.clone().addScaledVector(_up, -s.vel.dot(_up)).length();
    this.speed.textContent = String(Math.round(planar / HU));
    // the face whose gravity you have: a team's base or a neutral city
    const face = faceByUp(sim.map, _down.set(0, 1, 0).applyQuaternion(s.frame));
    const team = face?.team ? getTeam(face.team as TeamId) : null;
    const id = face?.id ?? '';
    if (id !== this.lastTeam) {
      this.lastTeam = id;
      this.gravDot.style.color = team ? '#' + team.color.toString(16).padStart(6, '0') : '#e8e2d0';
      this.gravName.textContent = `Гравитация: ${team ? team.name : 'нейтральная грань'}`;
    }
    // sprint stamina: hidden while full
    const st = s.stamina / STAMINA.max;
    this.stBar.style.width = `${(st * 100).toFixed(1)}%`;
    this.stBar.classList.toggle('dry', s.exhausted);
    this.stEl.classList.toggle('full', st >= 0.999);
    this.info.textContent =
      `${Math.round(this.fps)} fps\n` +
      `${s.noclip ? 'NOCLIP' : s.onGround ? 'на земле' : 'в воздухе'}\n` +
      `верт. ${(s.vel.dot(_up) / HU).toFixed(0)} u/s\n` + extra;
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.hitT <= 0) this.hit.className = '';
    }
    this.hurtT = Math.max(0, this.hurtT - dt * 1.2);
    this.hurtEl.style.opacity = String(this.hurtT);
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    }
  }
}

export function teamHex(color: number) {
  return '#' + color.toString(16).padStart(6, '0');
}