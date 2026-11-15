import type { Economy, ItemId } from './economy';
import { ITEM_ORDER } from './economy';

/** Guns that go into a hand (bought in the shop). */
export type GunId = 'pistol' | 'shotgun' | 'rifle' | 'crossbow' | 'rocket';
export const HELD_GUNS: GunId[] = ['pistol', 'shotgun', 'rifle', 'crossbow', 'rocket'];
export const isHeldGun = (h: Holdable | null): h is GunId => !!h && (HELD_GUNS as string[]).includes(h);
/** Everything that can go into a hand besides the bare fists (an empty hand punches). */
export type Holdable = GunId | 'grenade' | 'build' | 'hook' | 'rod' | ItemId;
/** Where new things go first: weapons on the left, the tools, then the pocket items. */
export const HOLD_ORDER: Holdable[] = [...HELD_GUNS, 'grenade', 'build', 'hook', 'rod', ...ITEM_ORDER];
export const HOTBAR_SIZE = 9;

export const isItem = (h: Holdable | null): h is ItemId => !!h && (ITEM_ORDER as string[]).includes(h);

/** What the player owns right now and could hold (guns bought, grenades left, tools, non-empty item stacks). */
export function holdables(eco: Economy): Holdable[] {
  const ws = eco.weapons;
  return HOLD_ORDER.filter((h) => {
    if (isHeldGun(h)) return ws.owned[h];
    if (h === 'grenade') return ws.ammo.grenade > 0;
    if (h === 'build') return false; // toggled directly with B (KeyB)
    if (h === 'hook') return eco.has('hook');
    if (h === 'rod') return eco.has('rod');
    return eco.items[h] > 0;
  });
}

/** A place in the inventory: hotbar slot or backpack cell. */
export interface SlotRef { where: 'bar' | 'pack'; i: number }

/**
 * Hotbar (keys 1–9, 9 slots total, no separate inventory screen). Things you get go to their old slot if it is free,
 * else to the first free one; things you run out of disappear but remember their slot. An empty selected slot = fists.
 */
export class Hotbar {
  readonly bar: (Holdable | null)[] = Array(HOTBAR_SIZE).fill(null);
  readonly pack: (Holdable | null)[] = [];
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
    if (r.where !== 'bar') return;
    this.bar[r.i] = h;
    if (h) this.home.set(h, { ...r });
  }

  /** Bring the slots in line with what is owned (9 hotbar slots only). */
  sync(owned: Holdable[]) {
    const have = new Set(owned);
    for (let i = 0; i < this.bar.length; i++) if (this.bar[i] && !have.has(this.bar[i]!)) this.bar[i] = null;
    for (const h of owned) {
      if (this.bar.includes(h)) continue;
      const home = this.home.get(h);
      if (home && home.where === 'bar' && !this.get(home)) { this.set(home, h); continue; }
      let i = this.bar.findIndex((s, k) => !s && (k !== this.sel || !isItem(h)));
      if (i < 0) i = this.bar.findIndex((s) => !s);
      if (i >= 0) this.set({ where: 'bar', i }, h);
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
