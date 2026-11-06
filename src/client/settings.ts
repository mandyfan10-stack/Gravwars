import type { Difficulty } from '../shared/bots';

/** Player settings that survive a reload (localStorage). */
export interface Settings {
  volume: number;
  sensitivity: number;
  fov: number;
  /** Nearest texture filtering (crisp texels). */
  pixel: boolean;
  difficulty: Difficulty;
}

const KEY = 'gravity-bedwars.settings';
export const DEFAULT_SETTINGS: Settings = { volume: 0.45, sensitivity: 0.0022, fov: 80, pixel: true, difficulty: 'normal' };

const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);

export function loadSettings(): Settings {
  const d = DEFAULT_SETTINGS;
  let raw: Partial<Record<keyof Settings, unknown>> = {};
  try { raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { /* broken or blocked storage: defaults */ }
  return {
    volume: num(raw.volume, 0, 1, d.volume),
    sensitivity: num(raw.sensitivity, 0.0005, 0.006, d.sensitivity),
    fov: num(raw.fov, 60, 120, d.fov),
    pixel: typeof raw.pixel === 'boolean' ? raw.pixel : d.pixel,
    difficulty: raw.difficulty === 'easy' || raw.difficulty === 'hard' || raw.difficulty === 'normal' ? raw.difficulty : d.difficulty,
  };
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: settings live until reload */ }
}
