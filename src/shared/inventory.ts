import type { Economy, ItemId } from './economy';
import { ITEM_ORDER } from './economy';

/** Everything that can go into a hand besides the bare fists (an empty hand punches). */
export type Holdable = 'pistol' | 'rifle' | 'grenade' | 'build' | 'rod' | ItemId;
/** Where new things go first: weapons on the left, the tools, then the pocket items. */
export const HOLD_ORDER: Holdable[] = ['pistol', 'rifle', 'grenade', 'build', 'rod', ...ITEM_ORDER];
export const HOTBAR_SIZE = 9;

export const isItem = (h: Holdable | null): h is ItemId => !!h && (ITEM_ORDER as string[]).includes(h);

/** What the player owns right now and could hold (guns bought, grenades left, tools, non-empty item stacks). */
export function holdables(eco: Economy): Holdable[] {
  const ws = eco.weapons;
  return HOLD_ORDER.filter((h) => {
    if (h === 'pistol' || h === 'rifle') return ws.owned[h];
    if (h === 'grenade') return ws.ammo.grenade > 0;
    if (h === 'build') return eco.has('builder');
    if (h === 'rod') return eco.has('rod');
    return eco.items[h] > 0;
  });
}

/** A place in the inventory: hotbar slot or backpack cell. */
export interface SlotRef { where: 'bar' | 'pack'; i: number }

/**
 * Hotbar (keys 1–9) + backpack. Things you get go to their old slot if it is free, else to the first free one,
 * else into the backpack; things you run out of disappear but remember their slot. An empty selected slot = fists.
 */
export class Hotbar {
  readonly bar: (Holdable | null)[] = Array(HOTBAR_SIZE).fill(null);
  readonly pack: (Holdable | null)[] = Array(HOTBAR_SIZE).fill(null);
  /** Selected hotbar slot. */
  sel = 0;
  private readonly home = new Map<Holdable, SlotRef>();

  /** Thing in the hand (null = fists). */
  get held(): Holdable | null {
    return this.bar[this.sel];
  }

  private list(where: SlotRef['where']) {
    return where === 'bar' ? this.bar : this.pack;
  }

  get(r: SlotRef) {
    return this.list(r.where)[r.i] ?? null;
  }

  private set(r: SlotRef, h: Holdable | null) {
    this.list(r.where)[r.i] = h;
    if (h) this.home.set(h, { ...r });
  }

  /** Bring the slots in line with what is owned. */
  sync(owned: Holdable[]) {
    const have = new Set(owned);
    for (const where of ['bar', 'pack'] as const) {
      const l = this.list(where);
      for (let i = 0; i < l.length; i++) if (l[i] && !have.has(l[i]!)) l[i] = null;
    }
    for (const h of owned) {
      if (this.bar.includes(h) || this.pack.includes(h)) continue;
      const home = this.home.get(h);
      if (home && !this.get(home)) { this.set(home, h); continue; }
      // the first free hotbar slot; a pocket item never into the empty hand (picking up an apple mid-fight must not
      // replace the fists), a bought gun or tool may
      let i = this.bar.findIndex((s, k) => !s && (k !== this.sel || !isItem(h)));
      if (i >= 0) { this.set({ where: 'bar', i }, h); continue; }
      i = this.pack.indexOf(null);
      if (i >= 0) this.set({ where: 'pack', i }, h);
    }
  }

  /** Swap two places (moving onto an empty one is a move). */
  swap(a: SlotRef, b: SlotRef) {
    const x = this.get(a), y = this.get(b);
    this.set(a, y);
    this.set(b, x);
  }

  /** Hotbar slot of a thing (-1 if it is not on the bar). */
  slotOf(h: Holdable) {
    return this.bar.indexOf(h);
  }

  /** Next non-empty hotbar slot after the selected one (Q / wheel), wrapping around; stays if there is none. */
  cycle(step: 1 | -1) {
    for (let k = 1; k <= HOTBAR_SIZE; k++) {
      const i = (this.sel + step * k + HOTBAR_SIZE * 2) % HOTBAR_SIZE;
      if (this.bar[i]) { this.sel = i; return; }
    }
  }
}
