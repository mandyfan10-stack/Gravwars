import type { BotRoster, Difficulty } from './bots';
import { TeamId, TEAMS } from './teams';

/** A seat in a team: a player (local or remote), a bot of some difficulty, or empty. */
export type Seat = { kind: 'player'; id?: string; name?: string } | { kind: 'bot'; difficulty: Difficulty } | null;
export type GameMode = 'standard' | 'sandbox' | 'duel' | 'skirmish';
export const TEAM_SEATS = 5;
export const MAX_TEAM_SEATS = 10;

export interface LobbyMultipliers {
  reward: number;
  damage: number;
  playerHp: number;
  crystalHp: number;
  crateHp: number;
  blockHp: number;
  cashPrice: number;
  crystalPrice: number;
}

export const DEFAULT_MULTIPLIERS: LobbyMultipliers = {
  reward: 1,
  damage: 1,
  playerHp: 1,
  crystalHp: 1,
  crateHp: 1,
  blockHp: 1,
  cashPrice: 1,
  crystalPrice: 1,
};

/** Live match multipliers read by combat, economy, match, blocks, and props. */
export const MATCH_RULES: LobbyMultipliers = { ...DEFAULT_MULTIPLIERS };

export function applyMatchRules(m?: Partial<LobbyMultipliers>) {
  Object.assign(MATCH_RULES, DEFAULT_MULTIPLIERS, m ?? {});
}

/** Who plays: up to five teams × N seats (default 5, up to 10 in extreme settings). A team with nobody in it gets no face. */
export interface LobbyConfig {
  seats: Record<TeamId, Seat[]>;
  /** Match mode: standard cube (6 islands), duel (4 islands: 2 opposing bases + 2 side neutral islands), or solo sandbox. */
  mode?: GameMode;
  /** Pre-match mode: the player's wallet never runs out. */
  infiniteMoney?: boolean;
  /** Number of seats per team (5 by default, up to 10 in extreme settings). */
  seatCount?: number;
  /** Optional random seed for map generation. */
  seed?: number;
  /** Custom match multipliers (extreme settings). */
  multipliers?: Partial<LobbyMultipliers>;
}

const empty = (n = TEAM_SEATS): Seat[] => Array(n).fill(null);

export function seatsPerTeam(c: LobbyConfig): number {
  return Math.max(TEAM_SEATS, Math.min(MAX_TEAM_SEATS, c.seatCount ?? TEAM_SEATS));
}

export function setSeatsPerTeam(c: LobbyConfig, count: number) {
  const n = Math.max(TEAM_SEATS, Math.min(MAX_TEAM_SEATS, Math.round(count)));
  c.seatCount = n;
  for (const t of TEAMS) {
    const cur = c.seats[t.id] ?? [];
    if (cur.length < n) {
      c.seats[t.id] = [...cur, ...Array(n - cur.length).fill(null)];
    } else if (cur.length > n) {
      c.seats[t.id] = cur.slice(0, n);
    }
  }
}

/** The classic setup: you in red, two bots in blue/green/yellow (purple starts empty unless enabled). */
export function defaultLobby(difficulty: Difficulty = 'normal'): LobbyConfig {
  const seats = Object.fromEntries(TEAMS.map((t) => [t.id, empty()])) as Record<TeamId, Seat[]>;
  seats.red[0] = { kind: 'player' };
  for (const t of ['blue', 'green', 'yellow'] as TeamId[]) for (let i = 0; i < 2; i++) seats[t][i] = { kind: 'bot', difficulty };
  return { seats, seatCount: TEAM_SEATS, multipliers: { ...DEFAULT_MULTIPLIERS } };
}

export function playerTeam(c: LobbyConfig, playerId?: string): TeamId | null {
  for (const t of TEAMS) {
    const row = c.seats[t.id] ?? [];
    if (playerId) {
      if (row.some((s) => s?.kind === 'player' && s.id === playerId)) return t.id;
    } else {
      if (row.some((s) => s?.kind === 'player' && !s.id)) return t.id;
    }
  }
  for (const t of TEAMS) if ((c.seats[t.id] ?? []).some((s) => s?.kind === 'player')) return t.id;
  return null;
}

/** Teams with at least one member (they get a face of the cube), in the usual order. */
export function activeTeams(c: LobbyConfig): TeamId[] {
  return TEAMS.filter((t) => (c.seats[t.id] ?? []).some((s) => s)).map((t) => t.id);
}

export function botRoster(c: LobbyConfig, spectator = false): BotRoster {
  const r: BotRoster = {};
  const active = activeTeams(c);
  for (const t of TEAMS) {
    const row = c.seats[t.id] ?? [];
    let bots = row.filter((s): s is { kind: 'bot'; difficulty: Difficulty } => s?.kind === 'bot').map((s) => s.difficulty);
    if (spectator) {
      if (row.some((s) => s?.kind === 'player')) {
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
  const mode = c.mode ?? 'standard';
  if (mode === 'sandbox') return null;
  if (mode === 'duel') {
    if (activeTeams(c).length !== 2) return 'В режиме Дуэль должны участвовать ровно 2 команды';
    return null;
  }
  if (mode === 'skirmish') {
    if (activeTeams(c).length !== 2) return 'В режиме Схватка должны участвовать ровно 2 команды';
    return null;
  }
  if (activeTeams(c).length < 2) return 'Нужна хотя бы ещё одна команда с ботами или игроками';
  return null;
}

/** Whether `playerId` can legally occupy seat `(team, i)`. */
export function canSeatPlayer(c: LobbyConfig, team: TeamId, i: number, playerId?: string): boolean {
  const row = c.seats[team];
  const max = seatsPerTeam(c);
  if (!row || i < 0 || i >= max) return false;
  const cur = row[i];
  if (cur?.kind === 'player' && cur.id && cur.id !== playerId) return false;
  return true;
}

/** Teams with at least one human player (used so humans never spawn trapped inside bed forts). */
export function humanTeams(c: LobbyConfig): TeamId[] {
  return TEAMS.filter((t) => (c.seats[t.id] ?? []).some((s) => s?.kind === 'player')).map((t) => t.id);
}

/** Put a player into a seat (leaving their old one). */
export function seatPlayer(c: LobbyConfig, team: TeamId, i: number, playerId?: string, name?: string) {
  if (!canSeatPlayer(c, team, i, playerId)) return;
  for (const t of TEAMS) {
    c.seats[t.id] = (c.seats[t.id] ?? empty(seatsPerTeam(c))).map((s) => {
      if (s?.kind !== 'player') return s;
      if (playerId && s.id === playerId) return null;
      if (!playerId && !s.id) return null;
      return s;
    });
  }
  c.seats[team][i] = { kind: 'player', id: playerId, name };
}

/** Replace any bot seats left in `seats` without breaking existing player seats, returning false if full. */
export function firstFreeSeat(c: LobbyConfig, preferOrder: TeamId[] = ['blue', 'green', 'yellow', 'purple', 'red']): { team: TeamId; seatIndex: number } | null {
  for (const t of preferOrder) {
    const row = c.seats[t] ?? [];
    const idx = row.findIndex((s) => s === null);
    if (idx !== -1) return { team: t, seatIndex: idx };
  }
  for (const t of preferOrder) {
    const row = c.seats[t] ?? [];
    const idx = row.findIndex((s) => s?.kind === 'bot');
    if (idx !== -1) return { team: t, seatIndex: idx };
  }
  return null;
}

/** Free up any seat occupied by a player ID. */
export function removePlayerSeat(c: LobbyConfig, playerId: string) {
  for (const t of TEAMS) {
    if (!c.seats[t.id]) continue;
    c.seats[t.id] = c.seats[t.id].map((s) => (s?.kind === 'player' && s.id === playerId ? null : s));
  }
}

/**
 * Strip remote/stale network player seats so only the local player seat (`{ kind: 'player' }`) and bots remain.
 * Used when saving/loading `localStorage` and when leaving or closing a P2P room.
 */
export function sanitizeLocalLobby(c: LobbyConfig, keepPlayerId = ''): LobbyConfig {
  const n = seatsPerTeam(c);
  const seats = Object.fromEntries(TEAMS.map((t) => {
    const row = c.seats[t.id] ?? empty(n);
    return [t.id, [...row, ...Array(Math.max(0, n - row.length)).fill(null)].slice(0, n)];
  })) as Record<TeamId, Seat[]>;
  let keptTeam: TeamId | null = null;
  let keptIdx = -1;
  for (const t of TEAMS) {
    for (let i = 0; i < n; i++) {
      const s = seats[t.id][i];
      if (s?.kind !== 'player') continue;
      if (keepPlayerId && s.id === keepPlayerId) {
        keptTeam = t.id;
        keptIdx = i;
      } else if (!keptTeam && !s.id) {
        keptTeam = t.id;
        keptIdx = i;
      }
      seats[t.id][i] = null;
    }
  }
  const team = keptTeam ?? 'red';
  const idx = keptIdx >= 0 ? keptIdx : Math.max(0, seats[team].findIndex((s) => s === null));
  seats[team][idx] = { kind: 'player' };
  return {
    seats,
    mode: c.mode === 'sandbox' || c.mode === 'duel' || c.mode === 'skirmish' ? c.mode : 'standard',
    seatCount: n,
    ...(c.infiniteMoney ? { infiniteMoney: true } : {}),
    ...(c.multipliers ? { multipliers: { ...DEFAULT_MULTIPLIERS, ...c.multipliers } } : {}),
  };
}

/** Parse a stored config; anything broken → the default. */
export function parseLobby(raw: string | null, difficulty: Difficulty = 'normal'): LobbyConfig {
  try {
    const c = JSON.parse(raw ?? '') as LobbyConfig;
    if (!c || typeof c !== 'object' || !c.seats) return defaultLobby(difficulty);
    const n = Math.max(TEAM_SEATS, Math.min(MAX_TEAM_SEATS, c.seatCount ?? (c.seats.red?.length || TEAM_SEATS)));
    for (const t of TEAMS) {
      if (!Array.isArray(c.seats[t.id])) c.seats[t.id] = empty(n);
      else if (c.seats[t.id].length < n) c.seats[t.id] = [...c.seats[t.id], ...empty(n - c.seats[t.id].length)];
      else if (c.seats[t.id].length > n) c.seats[t.id] = c.seats[t.id].slice(0, n);
    }
    const ok = TEAMS.every((t) => Array.isArray(c.seats?.[t.id]) && c.seats[t.id].length === n
      && c.seats[t.id].every((s) => s === null || s.kind === 'player' || (s.kind === 'bot' && ['easy', 'normal', 'hard'].includes(s.difficulty))));
    const players = TEAMS.reduce((sum, t) => sum + c.seats[t.id].filter((s) => s?.kind === 'player').length, 0);
    if (ok && players <= n * TEAMS.length) {
      return {
        ...c,
        mode: c.mode === 'sandbox' || c.mode === 'duel' || c.mode === 'skirmish' ? c.mode : 'standard',
        seatCount: n,
        infiniteMoney: c.infiniteMoney === true,
        multipliers: { ...DEFAULT_MULTIPLIERS, ...(c.multipliers ?? {}) },
      };
    }
  } catch { /* default */ }
  return defaultLobby(difficulty);
}
