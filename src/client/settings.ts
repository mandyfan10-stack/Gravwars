import type { Difficulty } from '../shared/bots';

export interface OutlineSettings {
  enabled: boolean;
  strength: number;        // 0.2 .. 2.0 (default 1.0)
  playerDistance: number;  // 15 .. 25 m in normal play (default 22)
  specDistance: number;    // 30 .. 200 m in spectator mode (default 120)
  showCrystal: boolean;
  showAllies: boolean;
  showEnemies: boolean;    // spectator only
  showItems: boolean;      // spectator only
  showNpcs: boolean;       // spectator only
  showCars: boolean;       // spectator only
  colorCrystal: string;    // e.g. '#00f5ff'
  colorAlly: string;       // e.g. '#4dff88'
  colorEnemy: string;      // e.g. '#ff4d4d'
  colorItem: string;       // e.g. '#ffe066'
  colorNpc: string;        // e.g. '#ff9f43'
  colorCar: string;        // e.g. '#c084fc'
}

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
  /** X-Ray / through-wall contour outline settings. */
  outline: OutlineSettings;
}

/** Picture heights offered in the settings (lines; 0 = off). */
export const PIXEL_LINES = [360, 480, 720, 0] as const;
/** Shades per colour channel of the retro palette. */
export const PALETTE_LEVELS = 16;

export type ShadowQuality = 'off' | 'low' | 'high';

export const DEFAULT_OUTLINE_SETTINGS: OutlineSettings = {
  enabled: true,
  strength: 1.0,
  playerDistance: 22,
  specDistance: 120,
  showCrystal: true,
  showAllies: true,
  showEnemies: true,
  showItems: true,
  showNpcs: true,
  showCars: true,
  colorCrystal: '#ffffff',
  colorAlly: '#ffffff',
  colorEnemy: '#ff3333',
  colorItem: '#ffe066',
  colorNpc: '#ff3333',
  colorCar: '#ff3333',
};

const KEY = 'gravity-bedwars.settings';
export const DEFAULT_SETTINGS: Settings = {
  volume: 0.45,
  sensitivity: 0.0022,
  fov: 80,
  pixel: true,
  difficulty: 'normal',
  drawDistance: 700,
  shadows: 'high',
  bloom: true,
  pixels: 480,
  palette: true,
  outline: { ...DEFAULT_OUTLINE_SETTINGS },
};

const num = (v: unknown, lo: number, hi: number, def: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
const bool = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
const hexColor = (v: unknown, def: string) =>
  typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim() : def;

let liveSettings: Settings = { ...DEFAULT_SETTINGS, outline: { ...DEFAULT_OUTLINE_SETTINGS } };

export function getLiveSettings(): Settings {
  return liveSettings;
}

export function loadSettings(): Settings {
  const d = DEFAULT_SETTINGS;
  const od = DEFAULT_OUTLINE_SETTINGS;
  let raw: Partial<Record<keyof Settings, unknown>> = {};
  try { raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {}; } catch { /* broken or blocked storage: defaults */ }
  const ro = (raw.outline && typeof raw.outline === 'object' ? raw.outline : {}) as Partial<Record<keyof OutlineSettings, unknown>>;
  const loaded: Settings = {
    volume: num(raw.volume, 0, 1, d.volume),
    sensitivity: num(raw.sensitivity, 0.0005, 0.006, d.sensitivity),
    fov: num(raw.fov, 60, 120, d.fov),
    pixel: bool(raw.pixel, d.pixel),
    drawDistance: num(raw.drawDistance, 150, 1200, d.drawDistance),
    shadows: raw.shadows === 'off' || raw.shadows === 'low' || raw.shadows === 'high' ? raw.shadows : d.shadows,
    bloom: bool(raw.bloom, d.bloom),
    pixels: PIXEL_LINES.includes(raw.pixels as never) ? (raw.pixels as number) : d.pixels,
    palette: bool(raw.palette, d.palette),
    difficulty: raw.difficulty === 'easy' || raw.difficulty === 'hard' || raw.difficulty === 'normal' ? raw.difficulty : d.difficulty,
    outline: {
      enabled: bool(ro.enabled, od.enabled),
      strength: num(ro.strength, 0.2, 2.0, od.strength),
      playerDistance: num(ro.playerDistance, 15, 25, od.playerDistance),
      specDistance: num(ro.specDistance, 30, 200, od.specDistance),
      showCrystal: bool(ro.showCrystal, od.showCrystal),
      showAllies: bool(ro.showAllies, od.showAllies),
      showEnemies: bool(ro.showEnemies, od.showEnemies),
      showItems: bool(ro.showItems, od.showItems),
      showNpcs: bool(ro.showNpcs, od.showNpcs),
      showCars: bool(ro.showCars, od.showCars),
      colorCrystal: ro.colorCrystal === '#00f5ff' ? od.colorCrystal : hexColor(ro.colorCrystal, od.colorCrystal),
      colorAlly: ro.colorAlly === '#4dff88' ? od.colorAlly : hexColor(ro.colorAlly, od.colorAlly),
      colorEnemy: ro.colorEnemy === '#ff4d4d' ? od.colorEnemy : hexColor(ro.colorEnemy, od.colorEnemy),
      colorItem: hexColor(ro.colorItem, od.colorItem),
      colorNpc: ro.colorNpc === '#ff9f43' ? od.colorNpc : hexColor(ro.colorNpc, od.colorNpc),
      colorCar: ro.colorCar === '#c084fc' ? od.colorCar : hexColor(ro.colorCar, od.colorCar),
    },
  };
  liveSettings = loaded;
  return loaded;
}

export function saveSettings(s: Settings) {
  liveSettings = s;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: settings live until reload */ }
}

