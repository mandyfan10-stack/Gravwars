import { PerspectiveCamera, Vector3 } from 'three';
import type { BotManager, Loc } from '../shared/bots';
import type { Match } from '../shared/match';
import type { PlayerSim } from '../shared/sim';
import { getTeam, TEAMS, TeamId } from '../shared/teams';
import { teamHex } from './hud';
import { icon } from './icons';

const _p = new Vector3();
const _d = new Vector3();

/**
 * New-player guidance: an objective line that follows where you are (roof → geyser → core face → portal → drop →
 * lift → enemy crystal), and screen markers for every crystal still standing, with the distance.
 */
export class Guide {
  private readonly tip = document.getElementById('objective')!;
  private readonly markers = new Map<TeamId, HTMLElement>();
  private tipKey = '';
  private lastLoc: Loc = { kind: 'air' };

  constructor(private match: Match, private bots: BotManager, private sim: PlayerSim) {
    const layer = document.getElementById('markers')!;
    for (const t of TEAMS) {
      const el = document.createElement('div');
      el.className = `marker${t.id === match.team ? ' mine' : ''}`;
      el.style.setProperty('--c', teamHex(t.color));
      el.innerHTML = `${icon('crystal')}<span></span>`;
      layer.append(el);
      this.markers.set(t.id, el);
    }
  }

  private objective(loc: Loc): [string, string] {
    const m = this.match;
    const team = (id: TeamId) => `<b style="color:${teamHex(getTeam(id).color)}">${getTeam(id).name}</b>`;
    if (!m.bed(m.team).alive) return ['lost', 'Твой кристалл сломан — следующая смерть станет последней'];
    if (loc.kind === 'air') return [this.tipKey, this.tip.innerHTML];
    const mine = loc.team === m.team;
    if (loc.kind === 'island' && mine && loc.roof)
      return ['home-roof', '<b class="geyser">Фиолетовый гейзер</b> в углу крыши — на промежуточный остров. <b class="lift">Голубая площадка</b> в другом углу — вниз в город'];
    if (loc.kind === 'island' && mine) return ['home-street', '<b class="lift">Голубой лифт</b> у входа в небоскрёб — обратно на крышу'];
    if (loc.kind === 'mid') return [`mid-${loc.team}`, 'Арка в центре острова ведёт на грань центрального куба. Упадёшь с края — вернёшься на базу'];
    if (loc.kind === 'face' && mine) return ['home-face', 'Арки-порталы ведут на грани других команд. Цвет арки — чья грань за ней'];
    if (loc.kind === 'face') {
      if (m.isOut(loc.team)) return ['out-face', `${team(loc.team)} уже выбыли — иди через портал к другим`];
      return [`face-${loc.team}`, `Грань: ${team(loc.team)}. Сойди с края — упадёшь на их остров`];
    }
    if (!loc.roof) return [`street-${loc.team}`, `Остров: ${team(loc.team)}. <b class="lift">Голубой лифт</b> у небоскрёба — на крышу к кристаллу`];
    if (m.bed(loc.team).alive) return [`roof-${loc.team}`, 'Пробей стену вокруг кристалла и держи <kbd>E</kbd> рядом с ним'];
    return [`roof-done-${loc.team}`, `Кристалл ${team(loc.team)} сломан — добей оставшихся бойцов`];
  }

  update(camera: PerspectiveCamera) {
    const loc = this.bots.locate(this.sim);
    if (loc.kind !== 'air') this.lastLoc = loc;
    const [key, html] = this.objective(loc.kind === 'air' ? this.lastLoc : loc);
    if (key !== this.tipKey) {
      this.tipKey = key;
      this.tip.innerHTML = html;
      this.tip.classList.remove('flash');
      void this.tip.offsetWidth; // restart the highlight animation
      this.tip.classList.add('flash');
    }

    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const bed of this.match.beds) {
      const el = this.markers.get(bed.team)!;
      if (!bed.alive) { el.style.display = 'none'; continue; }
      _p.copy(bed.pos).addScaledVector(bed.up, 2.2).project(camera);
      _d.copy(bed.pos).sub(camera.position);
      const behind = _p.z > 1;
      let x = (_p.x * 0.5 + 0.5) * w;
      let y = (-_p.y * 0.5 + 0.5) * h;
      if (behind) { x = w - x; y = h - y; }
      // off screen / behind: stick to the edge of an inner frame that keeps clear of the HUD panels
      const left = 70, right = w - 70, top = 140, bottom = h - 120;
      const off = behind || x < left || x > right || y < top || y > bottom;
      if (off) {
        const cx = x - w / 2, cy = y - (top + bottom) / 2;
        const k = Math.min((right - left) / 2 / Math.max(Math.abs(cx), 1e-3), (bottom - top) / 2 / Math.max(Math.abs(cy), 1e-3));
        x = w / 2 + cx * k;
        y = (top + bottom) / 2 + cy * k;
      }
      // your own crystal only when you are away from home
      if (bed.team === this.match.team && _d.length() < 30) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.classList.toggle('edge', off);
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      (el.lastElementChild as HTMLElement).textContent = `${Math.round(_d.length())} м`;
    }
  }
}
