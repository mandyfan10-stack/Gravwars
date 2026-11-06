import type { GameAudio } from './audio';

/** How much the player is in each kind of place right now, 0..1 each (several can overlap). */
export interface Area {
  /** Inside or right by a base hall. */
  base: number;
  /** Many trees around. */
  forest: number;
  /** A few trees, lawns, benches. */
  park: number;
  /** Houses and towers around. */
  city: number;
  /** By a pond or a fountain. */
  water: number;
}
export type AreaKind = keyof Area;

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(l: T[]) => l[Math.floor(Math.random() * l.length)];

/**
 * No constant beds of noise (no endless wind): now and then a single sound somewhere around the player, chosen by
 * the place: birds and a woodpecker in the trees, horns, a siren far off, dogs and passing cars in the city, a fish
 * plopping by the water, the ventilation and a door somewhere in the base hall. Each comes from its own side and
 * distance (pan, level, muffling), so the place sounds alive without a loop that can be heard repeating.
 */
export class Ambience {
  /** Seconds until the next sound of each kind. */
  private readonly next: Record<AreaKind, number> = { base: 2, forest: 1.5, park: 2.5, city: 3, water: 3 };
  /** Mean pause between sounds when fully in that kind of place. */
  private static readonly GAP: Record<AreaKind, [number, number]> = {
    base: [5, 11], forest: [1.8, 5], park: [3, 8], city: [3.5, 9], water: [4, 10],
  };

  constructor(private audio: GameAudio) {}

  update(area: Area, dt: number) {
    for (const k of Object.keys(this.next) as AreaKind[]) {
      this.next[k] -= dt * area[k];
      if (this.next[k] > 0) continue;
      const [a, b] = Ambience.GAP[k];
      this.next[k] = rnd(a, b);
      if (area[k] > 0.15) this.play(k, area[k]);
    }
  }

  /** One sound of that place, `w` = how much the player is in it (closer, louder). */
  play(kind: AreaKind, w = 1) {
    const A = this.audio;
    const side = () => rnd(-0.9, 0.9);
    switch (kind) {
      case 'forest':
      case 'park': {
        const s = pick(kind === 'forest' ? ['chirp', 'trill', 'whistle', 'pecker', 'crow', 'rustle', 'chirp', 'trill'] : ['chirp', 'whistle', 'crow', 'rustle', 'chirp']);
        const d = rnd(6, 30) / (0.5 + w);
        A.at(side(), d, () => this[s as 'chirp']());
        break;
      }
      case 'city': {
        const s = pick(['horn', 'siren', 'dog', 'car', 'car', 'clank', 'horn']);
        if (s === 'car') { const l = Math.random() < 0.5 ? -1 : 1; A.at(l * 0.9, rnd(12, 35), () => this.car(), -l * 0.9, 2.6); break; }
        A.at(side(), s === 'siren' ? rnd(80, 160) : rnd(20, 70) / (0.5 + w), () => this[s as 'horn']());
        break;
      }
      case 'water':
        A.at(side(), rnd(2, 9), () => this[pick(['plop', 'lap', 'lap', 'frog'] as const)]());
        break;
      case 'base':
        A.at(side(), rnd(6, 20), () => this[pick(['vent', 'creak', 'door', 'buzz', 'drip'] as const)]());
        break;
    }
  }

  // --- birds and trees
  private chirp() {
    const f = rnd(2600, 4800), n = 2 + Math.floor(Math.random() * 4);
    let t = 0;
    for (let i = 0; i < n; i++) {
      this.audio.tone('sine', f * rnd(1, 1.15), f * rnd(0.75, 1.15), 0.06, 0.05, t);
      t += rnd(0.08, 0.13);
    }
  }
  private trill() {
    const f = rnd(3200, 5200), n = 8 + Math.floor(Math.random() * 10);
    for (let i = 0; i < n; i++) this.audio.tone('sine', f, f * 0.85, 0.03, 0.035, i * 0.045);
  }
  /** Two- or three-note whistle, falling. */
  private whistle() {
    const f = rnd(1800, 2600);
    this.audio.tone('sine', f, f * 1.02, 0.28, 0.05);
    this.audio.tone('sine', f * 0.84, f * 0.8, 0.34, 0.05, 0.36);
    if (Math.random() < 0.5) this.audio.tone('sine', f * 0.84, f * 0.8, 0.34, 0.045, 0.78);
  }
  private pecker() {
    const n = 10 + Math.floor(Math.random() * 8);
    for (let i = 0; i < n; i++) this.audio.noise(0.02, 0.12 * (1 - i / n * 0.4), 1500, 900, i * 0.055, 'bandpass', 5);
  }
  private crow() {
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const t = i * rnd(0.38, 0.5);
      this.audio.tone('sawtooth', 520, 400, 0.26, 0.018, t);
      this.audio.noise(0.24, 0.05, 1200, 700, t, 'bandpass', 3);
    }
  }
  private rustle() {
    for (let i = 0; i < 3; i++) this.audio.noise(rnd(0.3, 0.6), 0.03, rnd(5000, 7000), 2500, i * rnd(0.15, 0.3), 'highpass', 0.6);
  }

  // --- city
  private horn() {
    const f = rnd(380, 460), n = Math.random() < 0.5 ? 1 : 2;
    for (let i = 0; i < n; i++) {
      const t = i * 0.32, l = i === n - 1 ? rnd(0.3, 0.6) : 0.18;
      this.audio.tone('square', f, f * 0.99, l, 0.03, t);
      this.audio.tone('square', f * 1.26, f * 1.25, l, 0.025, t);
    }
  }
  /** Far off: two or three wails up and down. */
  private siren() {
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      this.audio.tone('triangle', 620, 960, 0.75, 0.12, i * 1.5);
      this.audio.tone('triangle', 960, 620, 0.75, 0.12, i * 1.5 + 0.75);
    }
  }
  private dog() {
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const t = i * rnd(0.25, 0.4);
      this.audio.tone('sawtooth', rnd(320, 380), 180, 0.12, 0.05, t);
      this.audio.noise(0.1, 0.08, 1400, 500, t, 'bandpass', 2);
    }
  }
  /** A car going by: tyre hiss and engine swelling and fading while the pan sweeps across. */
  private car() {
    this.audio.noise(1.3, 0.07, 300, 1100, 0, 'lowpass', 0.8);
    this.audio.noise(1.3, 0.07, 1100, 250, 1.3, 'lowpass', 0.8);
    this.audio.tone('sawtooth', 70, 95, 1.2, 0.02);
    this.audio.tone('sawtooth', 95, 62, 1.3, 0.02, 1.2);
  }
  /** Building site / scaffolding far away. */
  private clank() {
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const t = i * rnd(0.3, 0.6), f = rnd(700, 1100);
      this.audio.tone('triangle', f, f * 0.98, 0.35, 0.06, t);
      this.audio.tone('sine', f * 2.7, f * 2.6, 0.2, 0.025, t);
      this.audio.noise(0.04, 0.1, 4000, 1500, t, 'bandpass', 2);
    }
  }

  // --- water
  private plop() {
    this.audio.tone('sine', rnd(700, 1000), 260, 0.09, 0.08);
    this.audio.noise(0.15, 0.04, 2400, 600, 0.03, 'bandpass', 1.5);
  }
  private lap() {
    for (let i = 0; i < 2; i++) this.audio.noise(rnd(0.35, 0.6), 0.035, rnd(500, 800), 250, i * rnd(0.4, 0.7), 'bandpass', 1.2);
  }
  private frog() {
    const n = 2 + Math.floor(Math.random() * 3), f = rnd(110, 160);
    for (let i = 0; i < n; i++) this.audio.tone('sawtooth', f, f * 0.9, 0.12, 0.04, i * 0.22);
  }

  // --- base hall
  private vent() {
    this.audio.tone('sine', 62, 48, 0.5, 0.12);
    this.audio.noise(0.8, 0.03, 600, 200, 0.05, 'lowpass');
  }
  private creak() {
    const f = rnd(150, 240);
    this.audio.tone('sawtooth', f, f * rnd(1.15, 1.4), rnd(0.4, 0.8), 0.012);
  }
  private door() {
    this.audio.noise(0.18, 0.12, 900, 120);
    this.audio.tone('sine', 95, 50, 0.25, 0.1);
    this.audio.noise(0.06, 0.05, 3000, 1200, 0.02, 'bandpass', 3);
  }
  /** A fluorescent tube flickering. */
  private buzz() {
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) this.audio.tone('square', 100, 100, rnd(0.05, 0.15), 0.01, i * rnd(0.12, 0.25));
  }
  private drip() {
    this.audio.tone('sine', rnd(1600, 2200), 900, 0.05, 0.05);
  }
}
