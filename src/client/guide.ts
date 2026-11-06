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
 * New-player guidance: an objective line that follows where you are (hall → bridge stub → bridge → centre →
 * enemy lane → enemy hall → crystal), and screen markers for every crystal still standing, with the distance.
 */
export class Guide {
  private readonly tip = document.getElementById('objective')!;
  private readonly markers = new Map<TeamId, HTMLElement>();
  private tipKey = '';
  private lastLoc: Loc = { kind: 'air' };

  constructor(private match: Match, private bots: BotManager, private sim: PlayerSim) {
    const layer = document.getElementById('markers')!;
    for (const t of TEAMS.filter((x) => match.beds.some((b) => b.team === x.id))) {
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
    if (loc.kind === 'center') {
      if (Math.max(Math.abs(loc.x), Math.abs(loc.z)) > this.sim.map.centerHalf)
        return ['bridge', 'Мост: держи пол под ногами — <kbd>B</kbd>, плита «Пол» над пустотой стоит 1 материал. Упадёшь — конец'];
      return ['center', 'Центр: генераторы кристаллов на площади, нейтральные магазины на рынках. Мосты к базам идут по бульварам'];
    }
    const id = loc.island as TeamId;
    if (id === m.team && loc.hall) return ['home-hall', 'Выходи из зала и иди в <b>опору моста</b> на площади перед ним — гравитация повернёт тебя к центру'];
    if (id === m.team) return ['home-street', 'Опора моста — бетонная полоса посреди площади. Подойди к ней вплотную: она станет полом'];
    if (!m.bed(id).alive) return [`done-${id}`, `Кристалл ${team(id)} сломан — добей оставшихся бойцов`];
    if (loc.hall) return [`hall-${id}`, 'Пробей стену вокруг кристалла и держи <kbd>E</kbd> рядом с ним'];
    return [`street-${id}`, `База: ${team(id)}. Кристалл в зале — две двери с улицы и два спуска с крыши`];
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
