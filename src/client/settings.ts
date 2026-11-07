import type { Difficulty } from '../shared/bots';

/** Player settings that survive a reload (localStorage). */
export interface Settings {
  volume: number;
  sensitivity: number;
  fov: number;
  /** Nearest texture filtering (crisp texels). */
  pixel: boolean;
  difficulty: Difficulty;
  /** Map pieces and people further than this (m) are not drawn. */
  drawDistance: number;
  shadows: ShadowQuality;
  bloom: boolean;
  /** Retro pixels: lines of the picture (0 = full resolution); see RetroLook. */
  pixels: number;
  /** Retro palette: few shades per channel with dithering. */
  palette: boolean;
}

/** Picture heights offered in the settings (lines; 0 = off). */
export const PIXEL_LINES = [360, 480, 720, 0] as const;
/** Shades per colour channel of the retro palette. */
export const PALETTE_LEVELS = 16;

export type ShadowQuality = 'off' | 'low' | 'high';

const KEY = 'gravity-bedwars.settings';
export const DEFAULT_SETTINGS: Settings = { volume: 0.45, sensitivity: 0.0022, fov: 80, pixel: true, difficulty: 'normal', drawDistance: 700, shadows: 'high', bloom: true, pixels: 480, palette: true };

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
    drawDistance: num(raw.drawDistance, 150, 1200, d.drawDistance),
    shadows: raw.shadows === 'off' || raw.shadows === 'low' || raw.shadows === 'high' ? raw.shadows : d.shadows,
    bloom: typeof raw.bloom === 'boolean' ? raw.bloom : d.bloom,
    pixels: PIXEL_LINES.includes(raw.pixels as never) ? (raw.pixels as number) : d.pixels,
    palette: typeof raw.palette === 'boolean' ? raw.palette : d.palette,
    difficulty: raw.difficulty === 'easy' || raw.difficulty === 'hard' || raw.difficulty === 'normal' ? raw.difficulty : d.difficulty,
  };
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: settings live until reload */ }
}
