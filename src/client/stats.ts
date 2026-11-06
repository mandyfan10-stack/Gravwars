import type { Target } from '../shared/combat';
import type { Match } from '../shared/match';
import { TEAMS, TeamId } from '../shared/teams';
import { teamHex } from './hud';

export const formatTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

const isTeam = (f: string): f is TeamId => TEAMS.some((t) => t.id === f);

/** What happened in this match: the player's record and team kills (scoreboard on Tab, summary at the end). */
export class MatchStats {
  kills = 0;
  headshots = 0;
  npcKills = 0;
  deaths = 0;
  crystals = 0;
  earned = 0;
  readonly teamKills: Record<TeamId, number> = { red: 0, blue: 0, green: 0, yellow: 0 };
  private lastCash = 0;

  constructor(private match: Match, private playerId = 0) {}

  frag(killer: Target | undefined, victim: Target, head: boolean) {
    if (victim.id === this.playerId) this.deaths++;
    if (!killer || killer === victim) return;
    if (killer.id === this.playerId) {
      if (victim.npc) this.npcKills++;
      else { this.kills++; if (head) this.headshots++; }
    }
    if (!victim.npc && isTeam(killer.team)) this.teamKills[killer.team]++;
  }

  /** Money that came in (sales, kills, drops): rises in the wallet, spending does not count. */
  trackCash(cash: number) {
    if (cash > this.lastCash) this.earned += cash - this.lastCash;
    this.lastCash = cash;
  }

  /** Teams table: crystal, fighters left, kills. */
  teamsHtml(playerAlive: boolean) {
    const m = this.match;
    const rows = TEAMS.map((t) => {
      const mine = t.id === m.team;
      const out = m.isOut(t.id);
      const alive = mine ? (playerAlive && !out ? 1 : 0) : m.membersAlive(t.id);
      const bed = m.bed(t.id).alive ? 'цел' : 'разрушен';
      return `<tr class="${mine ? 'mine' : ''}${out ? ' out' : ''}" style="--c:${teamHex(t.color)}">`
        + `<td class="team"><i></i>${t.name}${mine ? '<small>ты</small>' : ''}</td>`
        + `<td>${out ? 'выбыли' : bed}</td><td>${alive}</td><td>${this.teamKills[t.id]}</td></tr>`;
    }).join('');
    return `<table class="score"><thead><tr><th>Команда</th><th>Кристалл</th><th>Бойцов</th><th>Убийств</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  /** The player's own numbers. */
  personalHtml() {
    const cells: [string, string | number][] = [
      ['Время', formatTime(this.match.time)],
      ['Убийства', this.headshots ? `${this.kills} <small>в голову ${this.headshots}</small>` : this.kills],
      ['Смерти', this.deaths],
      ['Кристаллы', this.crystals],
      ['Жители', this.npcKills],
      ['Заработано', this.earned],
    ];
    return `<dl class="stats">${cells.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
  }
}
