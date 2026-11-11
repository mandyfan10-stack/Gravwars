import { DIFFICULTY_LABEL, type Difficulty } from '../shared/bots';
import { activeTeams, LobbyConfig, lobbyProblem, parseLobby, seatPlayer, TEAM_SEATS } from '../shared/lobby';
import { TeamId, TEAMS } from '../shared/teams';

const KEY = 'gravity-bedwars-lobby';
const ORDER: Difficulty[] = ['easy', 'normal', 'hard'];
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** The saved line-up of the last match (or the default one). */
export function loadLobby(difficulty: Difficulty): LobbyConfig {
  return parseLobby(localStorage.getItem(KEY), difficulty);
}

/**
 * Before the match: four teams × five seats. Click an empty seat to put a bot there (of the difficulty picked
 * below) or to sit down yourself; click a bot to change its difficulty, × to remove it. A team nobody plays for
 * gets no island. The main menu button starts the match once the line-up is valid.
 */
export class Lobby {
  readonly config: LobbyConfig;
  /** Difficulty of the bots added next. */
  difficulty: Difficulty;
  private readonly el = document.getElementById('menu-lobby')!;
  onChange: (problem: string | null) => void = () => {};
  /** The difficulty for new bots was changed (kept in the settings). */
  onLevel: (d: Difficulty) => void = () => {};

  constructor(difficulty: Difficulty) {
    this.difficulty = difficulty;
    this.config = loadLobby(difficulty);
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
      if (!b) return;
      this.act(b.dataset.act!, b.dataset.team as TeamId | undefined, Number(b.dataset.i));
    });
    this.el.addEventListener('change', (e) => {
      const s = e.target as HTMLSelectElement;
      if (s.dataset.act === 'money') { this.config.infiniteMoney = (e.target as HTMLInputElement).checked; this.save(); return; }
      if (s.dataset.act === 'level') { this.difficulty = s.value as Difficulty; this.onLevel(this.difficulty); }
    });
    this.render();
  }

  set hidden(v: boolean) {
    this.el.hidden = v;
  }

  get problem() {
    return lobbyProblem(this.config);
  }

  save() {
    localStorage.setItem(KEY, JSON.stringify(this.config));
  }

  private act(act: string, team: TeamId | undefined, i: number) {
    const seats = this.config.seats;
    if (act === 'bot' && team) seats[team][i] = { kind: 'bot', difficulty: this.difficulty };
    else if (act === 'sit' && team) seatPlayer(this.config, team, i);
    else if (act === 'del' && team) seats[team][i] = null;
    else if (act === 'diff' && team) {
      const s = seats[team][i];
      if (s?.kind === 'bot') s.difficulty = ORDER[(ORDER.indexOf(s.difficulty) + 1) % ORDER.length];
    } else if (act === 'fill' || act === 'fill2') {
      // every seat but the player's: bots up to 2 per team (or a full team)
      const n = act === 'fill' ? TEAM_SEATS : 2;
      for (const t of TEAMS) {
        const l = seats[t.id];
        for (let k = 0; k < TEAM_SEATS; k++) if (l[k]?.kind !== 'player') l[k] = null;
        let placed = l.filter((s) => s).length;
        for (let k = 0; k < TEAM_SEATS && placed < n; k++) if (!l[k]) { l[k] = { kind: 'bot', difficulty: this.difficulty }; placed++; }
      }
    } else if (act === 'clear') {
      for (const t of TEAMS) seats[t.id] = seats[t.id].map((s) => (s?.kind === 'player' ? s : null));
    } else return;
    this.save();
    this.render();
  }

  private render() {
    const seats = this.config.seats;
    const active = new Set(activeTeams(this.config));
    const teams = TEAMS.map((t) => {
      const l = seats[t.id];
      const n = l.filter((s) => s).length;
      const rows = l.map((s, i) => {
        const at = `data-team="${t.id}" data-i="${i}"`;
        if (s?.kind === 'player') return `<li class="seat you"><span>Ты</span></li>`;
        if (s?.kind === 'bot') {
          return `<li class="seat bot"><button class="lvl ${s.difficulty}" data-act="diff" ${at} title="Сменить сложность">Бот · ${DIFFICULTY_LABEL[s.difficulty].toLowerCase()}</button>`
            + `<button class="x" data-act="del" ${at} title="Убрать">×</button></li>`;
        }
        return `<li class="seat free"><button data-act="bot" ${at}>+ бот</button><button data-act="sit" ${at}>сесть</button></li>`;
      }).join('');
      return `<section class="team${active.has(t.id) ? '' : ' off'}" style="--c:${hex(t.color)}"><h3><i></i>${t.name}<small>${n ? `${n} из ${TEAM_SEATS}` : 'нет острова'}</small></h3><ol>${rows}</ol></section>`;
    }).join('');
    const problem = this.problem;
    this.el.innerHTML = `<header><h2>Состав матча</h2><p>Команда без игроков не получает острова. Клик по боту — сложность.</p></header>`
      + `<div class="teams">${teams}</div>`
      + `<footer><div class="quick"><button data-act="fill2">По 2 бота</button><button data-act="fill">Полные команды</button><button data-act="clear">Убрать ботов</button></div>`
      + `<label>Новые боты <select data-act="level">${ORDER.map((d) => `<option value="${d}"${d === this.difficulty ? ' selected' : ''}>${DIFFICULTY_LABEL[d]}</option>`).join('')}</select></label>`
      + `<label class="money"><input type="checkbox" data-act="money"${this.config.infiniteMoney ? ' checked' : ''}> Бесконечные деньги</label></footer>`
      + (problem ? `<p class="problem">${problem}</p>` : '');
    this.onChange(problem);
  }
}
