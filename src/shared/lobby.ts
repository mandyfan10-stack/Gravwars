import type { BotRoster, Difficulty } from './bots';
import { TeamId, TEAMS } from './teams';

/** A seat in a team: the local player, a bot of some difficulty, or empty. */
export type Seat = { kind: 'player' } | { kind: 'bot'; difficulty: Difficulty } | null;
export const TEAM_SEATS = 5;

/** Who plays: four teams × five seats. A team with nobody in it gets no island. */
export interface LobbyConfig {
  seats: Record<TeamId, Seat[]>;
}

const empty = (): Seat[] => Array(TEAM_SEATS).fill(null);

/** The classic setup: you in red, two bots in each other team. */
export function defaultLobby(difficulty: Difficulty = 'normal'): LobbyConfig {
  const seats = Object.fromEntries(TEAMS.map((t) => [t.id, empty()])) as Record<TeamId, Seat[]>;
  seats.red[0] = { kind: 'player' };
  for (const t of ['blue', 'green', 'yellow'] as TeamId[]) for (let i = 0; i < 2; i++) seats[t][i] = { kind: 'bot', difficulty };
  return { seats };
}

export function playerTeam(c: LobbyConfig): TeamId | null {
  for (const t of TEAMS) if (c.seats[t.id].some((s) => s?.kind === 'player')) return t.id;
  return null;
}

/** Teams with at least one member (they get an island), in the usual order. */
export function activeTeams(c: LobbyConfig): TeamId[] {
  return TEAMS.filter((t) => c.seats[t.id].some((s) => s)).map((t) => t.id);
}

export function botRoster(c: LobbyConfig): BotRoster {
  const r: BotRoster = {};
  for (const t of TEAMS) {
    const bots = c.seats[t.id].filter((s): s is { kind: 'bot'; difficulty: Difficulty } => s?.kind === 'bot').map((s) => s.difficulty);
    if (bots.length) r[t.id] = bots;
  }
  return r;
}

/** Why the match cannot start (null: it can). */
export function lobbyProblem(c: LobbyConfig): string | null {
  if (!playerTeam(c)) return 'Займи место в одной из команд';
  if (activeTeams(c).length < 2) return 'Нужна хотя бы ещё одна команда с ботами';
  return null;
}

/** Put the player into a seat (leaving the old one). */
export function seatPlayer(c: LobbyConfig, team: TeamId, i: number) {
  for (const t of TEAMS) c.seats[t.id] = c.seats[t.id].map((s) => (s?.kind === 'player' ? null : s));
  c.seats[team][i] = { kind: 'player' };
}

/** Parse a stored config; anything broken → the default. */
export function parseLobby(raw: string | null, difficulty: Difficulty = 'normal'): LobbyConfig {
  try {
    const c = JSON.parse(raw ?? '') as LobbyConfig;
    const ok = TEAMS.every((t) => Array.isArray(c.seats?.[t.id]) && c.seats[t.id].length === TEAM_SEATS
      && c.seats[t.id].every((s) => s === null || s.kind === 'player' || (s.kind === 'bot' && ['easy', 'normal', 'hard'].includes(s.difficulty))));
    const players = TEAMS.reduce((n, t) => n + c.seats[t.id].filter((s) => s?.kind === 'player').length, 0);
    if (ok && players <= 1) return c;
  } catch { /* default */ }
  return defaultLobby(difficulty);
}
