import type { BotRoster, Difficulty } from './bots';
import { TeamId, TEAMS } from './teams';

/** A seat in a team: a player (local or remote), a bot of some difficulty, or empty. */
export type Seat = { kind: 'player'; id?: string; name?: string } | { kind: 'bot'; difficulty: Difficulty } | null;
export const TEAM_SEATS = 5;

/** Who plays: four teams × five seats. A team with nobody in it gets no face. */
export interface LobbyConfig {
  seats: Record<TeamId, Seat[]>;
  /** Pre-match mode: the player's wallet never runs out. */
  infiniteMoney?: boolean;
}

const empty = (): Seat[] => Array(TEAM_SEATS).fill(null);

/** The classic setup: you in red, two bots in each other team. */
export function defaultLobby(difficulty: Difficulty = 'normal'): LobbyConfig {
  const seats = Object.fromEntries(TEAMS.map((t) => [t.id, empty()])) as Record<TeamId, Seat[]>;
  seats.red[0] = { kind: 'player' };
  for (const t of ['blue', 'green', 'yellow'] as TeamId[]) for (let i = 0; i < 2; i++) seats[t][i] = { kind: 'bot', difficulty };
  return { seats };
}

export function playerTeam(c: LobbyConfig, playerId?: string): TeamId | null {
  for (const t of TEAMS) {
    if (playerId) {
      if (c.seats[t.id].some((s) => s?.kind === 'player' && s.id === playerId)) return t.id;
    } else {
      if (c.seats[t.id].some((s) => s?.kind === 'player' && !s.id)) return t.id;
    }
  }
  // Fallback to first player if no specific id matched
  for (const t of TEAMS) if (c.seats[t.id].some((s) => s?.kind === 'player')) return t.id;
  return null;
}

/** Teams with at least one member (they get a face of the cube), in the usual order. */
export function activeTeams(c: LobbyConfig): TeamId[] {
  return TEAMS.filter((t) => c.seats[t.id].some((s) => s)).map((t) => t.id);
}

export function botRoster(c: LobbyConfig, spectator = false): BotRoster {
  const r: BotRoster = {};
  const active = activeTeams(c);
  for (const t of TEAMS) {
    let bots = c.seats[t.id].filter((s): s is { kind: 'bot'; difficulty: Difficulty } => s?.kind === 'bot').map((s) => s.difficulty);
    if (spectator) {
      if (c.seats[t.id].some((s) => s?.kind === 'player')) {
        bots = ['normal', ...bots];
      }
      if (active.includes(t.id)) {
        while (bots.length < 2) bots.push('normal');
      }
    }
    if (bots.length) r[t.id] = bots;
  }
  return r;
}

/** Why the match cannot start (null: it can). */
export function lobbyProblem(c: LobbyConfig): string | null {
  if (!playerTeam(c)) return 'Займи место в одной из команд';
  if (activeTeams(c).length < 2) return 'Нужна хотя бы ещё одна команда с ботами или игроками';
  return null;
}

/** Whether `playerId` can legally occupy seat `(team, i)`. */
export function canSeatPlayer(c: LobbyConfig, team: TeamId, i: number, playerId?: string): boolean {
  const row = c.seats[team];
  if (!row || i < 0 || i >= TEAM_SEATS) return false;
  const cur = row[i];
  if (cur?.kind === 'player' && cur.id && cur.id !== playerId) return false;
  return true;
}

/** Teams with at least one human player (used so humans never spawn trapped inside bed forts). */
export function humanTeams(c: LobbyConfig): TeamId[] {
  return TEAMS.filter((t) => c.seats[t.id].some((s) => s?.kind === 'player')).map((t) => t.id);
}

/** Put a player into a seat (leaving their old one). */
export function seatPlayer(c: LobbyConfig, team: TeamId, i: number, playerId?: string, name?: string) {
  if (!canSeatPlayer(c, team, i, playerId)) return;
  for (const t of TEAMS) {
    c.seats[t.id] = c.seats[t.id].map((s) => {
      if (s?.kind !== 'player') return s;
      if (playerId && s.id === playerId) return null;
      if (!playerId && !s.id) return null;
      return s;
    });
  }
  c.seats[team][i] = { kind: 'player', id: playerId, name };
}

/** Replace any bot seats left in `seats` without breaking existing player seats, returning false if full. */
export function firstFreeSeat(c: LobbyConfig, preferOrder: TeamId[] = ['blue', 'green', 'yellow', 'red']): { team: TeamId; seatIndex: number } | null {
  for (const t of preferOrder) {
    const idx = c.seats[t].findIndex((s) => s === null);
    if (idx !== -1) return { team: t, seatIndex: idx };
  }
  for (const t of preferOrder) {
    const idx = c.seats[t].findIndex((s) => s?.kind === 'bot');
    if (idx !== -1) return { team: t, seatIndex: idx };
  }
  return null;
}

/** Free up any seat occupied by a player ID. */
export function removePlayerSeat(c: LobbyConfig, playerId: string) {
  for (const t of TEAMS) {
    c.seats[t.id] = c.seats[t.id].map((s) => (s?.kind === 'player' && s.id === playerId ? null : s));
  }
}

/** Parse a stored config; anything broken → the default. */
export function parseLobby(raw: string | null, difficulty: Difficulty = 'normal'): LobbyConfig {
  try {
    const c = JSON.parse(raw ?? '') as LobbyConfig;
    const ok = TEAMS.every((t) => Array.isArray(c.seats?.[t.id]) && c.seats[t.id].length === TEAM_SEATS
      && c.seats[t.id].every((s) => s === null || s.kind === 'player' || (s.kind === 'bot' && ['easy', 'normal', 'hard'].includes(s.difficulty))));
    const players = TEAMS.reduce((n, t) => n + c.seats[t.id].filter((s) => s?.kind === 'player').length, 0);
    if (ok && players <= TEAM_SEATS * TEAMS.length) return { ...c, infiniteMoney: c.infiniteMoney === true };
  } catch { /* default */ }
  return defaultLobby(difficulty);
}
