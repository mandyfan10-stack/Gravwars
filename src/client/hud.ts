import { Vector3 } from 'three';
import { HU } from '../shared/constants';
import type { PlayerSim } from '../shared/sim';
import { WEAPONS, WeaponState } from '../shared/weapons';
import { teamByDown } from '../shared/teams';
import { icon } from './icons';

const $ = (id: string) => document.getElementById(id)!;
const _down = new Vector3();
const _up = new Vector3();

export class Hud {
  constructor() {
    document.querySelector('#hp .hp-ic')!.innerHTML = icon('heart');
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
  private wName = $('weapon-name');
  private ammo = $('ammo');
  private windArrow = $('wind-arrow');
  private windVal = $('wind-val');
  private hit = $('hitmarker');
  private hurtEl = $('hurt');
  private feed = $('feed');
  private hitT = 0;
  private hurtT = 0;

  setHp(hp: number) {
    this.hpVal.textContent = String(Math.ceil(hp));
    this.hpBar.style.width = `${Math.max(0, hp)}%`;
    this.hpBar.style.background = hp > 50 ? 'var(--hp)' : hp > 25 ? '#ffc94a' : '#ff5a5a';
  }

  private readonly hotbar = document.getElementById('hotbar')!;
  private readonly weaponIc = document.getElementById('weapon-ic')!;
  private hotbarKey = '';

  /** Weapon / ammo panel and the 1-2-3 hotbar (rifle, grenade, shovel). */
  setWeapon(ws: WeaponState, building = false) {
    const active = building ? 'shovel' : ws.current;
    if (active !== this.hotbarKey) {
      this.hotbarKey = active;
      this.hotbar.innerHTML = ([['rifle', 'Винтовка'], ['grenade', 'Граната'], ['shovel', 'Лопатка']] as const)
        .map(([id, name], i) => `<div class="slot${id === active ? ' on' : ''}" title="${name}"><kbd>${i + 1}</kbd>${icon(id)}</div>`).join('');
      this.weaponIc.innerHTML = icon(active);
    }
    if (building) {
      this.wName.textContent = 'Лопатка';
      this.ammo.innerHTML = '<small>ЛКМ — строить</small>';
      return;
    }
    const def = WEAPONS[ws.current];
    this.wName.textContent = def.name;
    if (ws.current === 'rifle') {
      this.ammo.innerHTML = ws.reloadT > 0 ? '<span class="reload">перезарядка…</span>' : `${ws.ammo.rifle}<small>/${def.mag}</small>`;
    } else {
      this.ammo.innerHTML = `<div class="pips">${'<i></i>'.repeat(ws.ammo.grenade)}${'<i class="empty"></i>'.repeat(def.mag - ws.ammo.grenade)}</div>`;
    }
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
    const team = teamByDown(sim.gravityDown(_down));
    if (team.id !== this.lastTeam) {
      this.lastTeam = team.id;
      const hex = '#' + team.color.toString(16).padStart(6, '0');
      this.gravDot.style.color = hex;
      this.gravName.textContent = `Гравитация: ${team.name}`;
    }
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