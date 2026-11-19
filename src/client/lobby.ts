import { DIFFICULTY_LABEL, type Difficulty } from '../shared/bots';
import { escapeHtml } from '../shared/escape';
import {
  activeTeams, DEFAULT_MULTIPLIERS, type GameMode, LobbyConfig, type LobbyMultipliers, lobbyProblem, MAX_TEAM_SEATS,
  normalizeSeed, parseLobby, randomMapSeed, sanitizeLocalLobby, seatPlayer, seatsPerTeam, setSeatsPerTeam, TEAM_SEATS,
} from '../shared/lobby';
import { TeamId, TEAMS } from '../shared/teams';

const KEY = 'gravity-bedwars-lobby';
const ORDER: Difficulty[] = ['easy', 'normal', 'hard'];
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

/** The saved line-up of the last match (or the default one), stripped of stale network peer seats. */
export function loadLobby(difficulty: Difficulty): LobbyConfig {
  return sanitizeLocalLobby(parseLobby(localStorage.getItem(KEY), difficulty));
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
    this.el.addEventListener('input', (e) => {
      if (this.isNetworkClient) return;
      const s = e.target as HTMLInputElement;
      const key = s.dataset.mult as keyof LobbyMultipliers | undefined;
      if (key) {
        const val = Number(s.value);
        this.config.multipliers = { ...DEFAULT_MULTIPLIERS, ...(this.config.multipliers ?? {}), [key]: val };
        const out = s.closest('.ext-item')?.querySelector('b');
        if (out) out.textContent = `${val.toFixed(2)}×`;
        this.save();
        this.onChange(this.problem);
        return;
      }
      if (s.dataset.act === 'seats') {
        const val = Math.max(TEAM_SEATS, Math.min(MAX_TEAM_SEATS, Math.round(Number(s.value))));
        setSeatsPerTeam(this.config, val);
        this.save();
        this.render();
        return;
      }
      if (s.dataset.act === 'seed') {
        const digits = s.value.replace(/\D/g, '').slice(0, 9);
        if (s.value !== digits) s.value = digits;
        this.config.seed = normalizeSeed(digits);
        this.save();
        this.onChange(this.problem);
      }
    });
    this.el.addEventListener('change', (e) => {
      if (this.isNetworkClient) return;
      const s = e.target as HTMLSelectElement;
      if (s.dataset.act === 'money') { this.config.infiniteMoney = (e.target as HTMLInputElement).checked; this.save(); this.onChange(this.problem); return; }
      if (s.dataset.act === 'seed') {
        const inp = e.target as HTMLInputElement;
        const parsed = normalizeSeed(inp.value);
        this.config.seed = parsed;
        inp.value = parsed !== undefined ? String(parsed) : '';
        this.save();
        this.render();
        return;
      }
      if (s.dataset.act === 'level') { this.difficulty = s.value as Difficulty; this.onLevel(this.difficulty); }
    });
    this.render();
  }

  private extremeOpen = false;

  set hidden(v: boolean) {
    this.el.hidden = v;
  }

  get problem() {
    return lobbyProblem(this.config);
  }

  save() {
    localStorage.setItem(KEY, JSON.stringify(sanitizeLocalLobby(this.config, this.localPlayerId)));
  }

  localPlayerId = '';
  isNetworkClient = false;
  onSeatRequest?: (team: TeamId, i: number) => void;

  private act(act: string, team: TeamId | undefined, i: number) {
    const seatCount = seatsPerTeam(this.config);
    if (act === 'toggle-extreme') { this.extremeOpen = !this.extremeOpen; this.render(); return; }
    if (act === 'reset-extreme') {
      setSeatsPerTeam(this.config, TEAM_SEATS);
      this.config.multipliers = { ...DEFAULT_MULTIPLIERS };
      this.save();
      this.render();
      return;
    }
    if (this.isNetworkClient && act !== 'sit') return;
    if (act === 'roll-seed') {
      this.config.seed = randomMapSeed();
      this.save();
      this.render();
      return;
    }
    if (act === 'clear-seed') {
      this.config.seed = undefined;
      this.save();
      this.render();
      return;
    }
    if (act === 'mode') {
      const m = (team as unknown as string) as GameMode;
      if (m === 'standard' || m === 'duel' || m === 'skirmish' || m === 'sandbox') {
        this.applyMode(m);
        this.save();
        this.render();
      }
      return;
    }
    const seats = this.config.seats;
    if (act === 'bot' && team) seats[team][i] = { kind: 'bot', difficulty: this.difficulty };
    else if (act === 'sit' && team) {
      if (this.onSeatRequest) {
        this.onSeatRequest(team, i);
        return;
      }
      seatPlayer(this.config, team, i);
    }
    else if (act === 'del' && team) seats[team][i] = null;
    else if (act === 'diff' && team) {
      const s = seats[team][i];
      if (s?.kind === 'bot') s.difficulty = ORDER[(ORDER.indexOf(s.difficulty) + 1) % ORDER.length];
    } else if (act === 'fill' || act === 'fill2') {
      // every seat but the player's: bots up to 2 per team (or full seatCount team)
      const n = act === 'fill' ? seatCount : 2;
      for (const t of TEAMS) {
        const l = seats[t.id];
        for (let k = 0; k < seatCount; k++) if (l[k]?.kind !== 'player') l[k] = null;
        let placed = l.filter((s) => s).length;
        for (let k = 0; k < seatCount && placed < n; k++) if (!l[k]) { l[k] = { kind: 'bot', difficulty: this.difficulty }; placed++; }
      }
    } else if (act === 'clear') {
      for (const t of TEAMS) seats[t.id] = seats[t.id].map((s) => (s?.kind === 'player' ? s : null));
    } else return;
    this.save();
    this.render();
  }

  private applyMode(mode: GameMode) {
    this.config.mode = mode;
    const seatCount = seatsPerTeam(this.config);
    const seats = this.config.seats;
    if (mode === 'sandbox') {
      this.config.infiniteMoney = true;
      for (const t of TEAMS) {
        seats[t.id] = seats[t.id].map((s) => (s?.kind === 'player' ? s : null));
      }
    } else if (mode === 'duel' || mode === 'skirmish') {
      const pTeam = TEAMS.find((t) => (seats[t.id] ?? []).some((s) => s?.kind === 'player'))?.id ?? 'red';
      const rival = TEAMS.find((t) => t.id !== pTeam && (seats[t.id] ?? []).some((s) => s))?.id
        ?? (pTeam === 'blue' ? 'red' : 'blue');
      for (const t of TEAMS) {
        if (t.id !== pTeam && t.id !== rival) {
          seats[t.id] = Array(seatCount).fill(null);
        }
      }
      if (!seats[rival].some((s) => s)) {
        seats[rival][0] = { kind: 'bot', difficulty: this.difficulty };
        if (seatCount > 1) seats[rival][1] = { kind: 'bot', difficulty: this.difficulty };
      }
    } else if (!activeTeams(this.config).some((t) => t !== 'red')) {
      for (const t of ['blue', 'green', 'yellow'] as TeamId[]) {
        for (let k = 0; k < Math.min(2, seatCount); k++) if (!seats[t][k]) seats[t][k] = { kind: 'bot', difficulty: this.difficulty };
      }
    }
  }

  render() {
    const seats = this.config.seats;
    const seatCount = seatsPerTeam(this.config);
    const mode: GameMode = this.config.mode ?? 'standard';
    const active = new Set(activeTeams(this.config));
    const client = this.isNetworkClient;
    const modesHtml = `<div class="mode-bar">`
      + ([
        ['standard', 'Классика', '6 граней · до 5 команд'],
        ['duel', 'Дуэль', '4 острова · 2 базы друг напротив друга'],
        ['skirmish', 'Схватка', '2 острова близко · 3 тайла · беспл. оружие'],
        ['sandbox', 'Песочница', 'Одному · без ограничений'],
      ] as const).map(([id, title, sub]) =>
        `<button class="mode-pill${mode === id ? ' on' : ''}" data-act="mode" data-team="${id}"${client ? ' disabled' : ''}><b>${title}</b><small>${sub}</small></button>`
      ).join('')
      + `</div>`;
    const teams = TEAMS.map((t) => {
      const l = seats[t.id];
      const n = l.slice(0, seatCount).filter((s) => s).length;
      const rows = Array.from({ length: seatCount }, (_, i) => {
        const s = l[i] ?? null;
        const at = `data-team="${t.id}" data-i="${i}"`;
        if (s?.kind === 'player') {
          const isMe = !s.id || s.id === this.localPlayerId;
          const label = escapeHtml(s.name || (isMe ? 'Ты' : 'Игрок'));
          return `<li class="seat ${isMe ? 'you' : 'remote'}"><span>${label}</span></li>`;
        }
        if (s?.kind === 'bot') {
          if (client) {
            return `<li class="seat bot"><span class="lvl ${s.difficulty}">Бот · ${DIFFICULTY_LABEL[s.difficulty].toLowerCase()}</span></li>`;
          }
          return `<li class="seat bot"><button class="lvl ${s.difficulty}" data-act="diff" ${at} title="Сменить сложность">Бот · ${DIFFICULTY_LABEL[s.difficulty].toLowerCase()}</button>`
            + `<button class="x" data-act="del" ${at} title="Убрать">×</button></li>`;
        }
        if (client) {
          return `<li class="seat free"><button data-act="sit" ${at}>сесть</button></li>`;
        }
        return `<li class="seat free"><button data-act="bot" ${at}>+ бот</button><button data-act="sit" ${at}>сесть</button></li>`;
      }).join('');
      return `<section class="team${active.has(t.id) ? '' : ' off'}" style="--c:${hex(t.color)}"><h3><i></i>${t.name}<small>${n ? `${n} из ${seatCount}` : 'нет острова'}</small></h3><ol>${rows}</ol></section>`;
    }).join('');
    const problem = this.problem;
    const headerNote = client
      ? 'Настройки матча задаёт хост. Выбери свободную команду или место.'
      : 'До 5 команд · Команда без игроков не получает острова · Клик по боту — сложность.';
    const quickBtns = client
      ? ''
      : `<div class="quick"><button data-act="fill2">По 2 бота</button><button data-act="fill">Полные команды</button><button data-act="clear">Убрать ботов</button></div>`;
    const dis = client ? ' disabled' : '';
    const m = { ...DEFAULT_MULTIPLIERS, ...(this.config.multipliers ?? {}) };
    const multDefs: [keyof LobbyMultipliers, string, number, number, number][] = [
      ['reward', 'Награда', 0.25, 5, 0.25],
      ['damage', 'Урон', 0.25, 4, 0.25],
      ['playerHp', 'HP игроков', 0.25, 4, 0.25],
      ['crystalHp', 'HP кристаллов', 0.25, 5, 0.25],
      ['crateHp', 'HP ящиков', 0.25, 4, 0.25],
      ['blockHp', 'HP построек', 0.25, 4, 0.25],
      ['cashPrice', 'Цены $', 0.25, 3, 0.25],
      ['crystalPrice', 'Цены кристаллов', 0.25, 3, 0.25],
    ];
    const extremePanel = `<div class="extreme-wrap">`
      + `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">`
      + `<button class="extreme-toggle" data-act="toggle-extreme">${this.extremeOpen ? '▼' : '▶'} Экстрим-настройки (${seatCount} мест, модификаторы)</button>`
      + (this.extremeOpen && !client ? `<button class="extreme-toggle" data-act="reset-extreme">Сбросить</button>` : '')
      + `</div><div class="extreme-grid"${this.extremeOpen ? '' : ' hidden'}>`
      + `<label class="ext-item"><span>Мест в команде<b>${seatCount}</b></span><input type="range" data-act="seats" min="${TEAM_SEATS}" max="${MAX_TEAM_SEATS}" step="1" value="${seatCount}"${dis}></label>`
      + multDefs.map(([k, lbl, lo, hi, st]) => `<label class="ext-item"><span>${lbl}<b>${m[k].toFixed(2)}×</b></span><input type="range" data-mult="${k}" min="${lo}" max="${hi}" step="${st}" value="${m[k]}"${dis}></label>`).join('')
      + `</div></div>`;

    const seedVal = normalizeSeed(this.config.seed);
    const seedCtrl = `<label class="seed-field">Сид `
      + `<input type="text" inputmode="numeric" maxlength="9" data-act="seed" placeholder="случайный" value="${seedVal !== undefined ? seedVal : ''}"${dis}>`
      + (!client ? `<button type="button" class="seed-btn" data-act="roll-seed" title="Случайный фиксированный сид">🎲</button>` : '')
      + (!client && seedVal !== undefined ? `<button type="button" class="seed-btn" data-act="clear-seed" title="Случайный каждый матч">×</button>` : '')
      + `</label>`;

    this.el.innerHTML = `<header><h2>Состав матча</h2><p>${headerNote}</p></header>`
      + modesHtml
      + `<div class="teams">${teams}</div>`
      + `<footer>${quickBtns}`
      + seedCtrl
      + `<label>Новые боты <select data-act="level"${dis}>${ORDER.map((d) => `<option value="${d}"${d === this.difficulty ? ' selected' : ''}>${DIFFICULTY_LABEL[d]}</option>`).join('')}</select></label>`
      + `<label class="money"><input type="checkbox" data-act="money"${this.config.infiniteMoney ? ' checked' : ''}${dis}> Бесконечные деньги</label></footer>`
      + extremePanel
      + (problem ? `<p class="problem">${escapeHtml(problem)}</p>` : '');
    this.onChange(problem);
  }
}
