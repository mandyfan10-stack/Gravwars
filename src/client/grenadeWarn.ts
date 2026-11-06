import { PerspectiveCamera, Vector3 } from 'three';
import type { Combat } from '../shared/combat';
import { WEAPONS } from '../shared/weapons';
import { icon } from './icons';

/** Live grenades within this many metres of the player get a marker. */
const RANGE = WEAPONS.grenade.radius + 4;
const _p = new Vector3();
const _d = new Vector3();

/**
 * Grenade warning: an icon over every live grenade near you (thrown by anyone), with a ring that fills as the fuse
 * burns down. Off screen or behind you it sits on the screen edge in its direction, so you know which way to run.
 */
export class GrenadeWarn {
  private readonly pool: HTMLElement[] = [];
  private readonly layer = document.getElementById('markers')!;

  constructor(private combat: Combat) {}

  private el(i: number) {
    while (this.pool.length <= i) {
      const e = document.createElement('div');
      e.className = 'nade-mark';
      e.innerHTML = icon('grenade');
      this.layer.append(e);
      this.pool.push(e);
    }
    return this.pool[i];
  }

  update(camera: PerspectiveCamera, me: Vector3) {
    const w = window.innerWidth, h = window.innerHeight;
    let n = 0;
    for (const p of this.combat.projectiles) {
      if (!p.alive || p.weapon !== 'grenade' || p.pos.distanceTo(me) > RANGE) continue;
      const e = this.el(n++);
      _p.copy(p.pos).project(camera);
      let x = _p.x, y = _p.y;
      const behind = _p.z > 1;
      if (behind) { x = -x; y = -y; }
      // off screen / behind: pushed out to an ellipse near the edge, in the grenade's direction
      const r = Math.hypot(x, y);
      if (behind || r > 0.85 || Math.abs(x) > 0.92 || Math.abs(y) > 0.88) {
        _d.set(x, y, 0);
        if (r < 1e-3) _d.set(0, -1, 0);
        _d.normalize();
        x = _d.x * 0.85;
        y = _d.y * 0.8;
      }
      const fuse = Math.min(1, p.age / WEAPONS.grenade.fuse);
      e.style.display = '';
      e.style.setProperty('--fuse', `${Math.round(fuse * 360)}deg`);
      e.style.transform = `translate(${((x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-y * 0.5 + 0.5) * h).toFixed(1)}px)`;
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }
}
