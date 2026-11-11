import { BUILDER_WOOD, Currency, Economy, ITEMS, MAX_MEDKITS, SHOP, ShopItem } from './economy';
import { WEAPONS } from './weapons';

/** What a bot's plans need from the shop (see `wishlist`). */
export interface Needs {
  /** Goes raiding: needs the build tool and wood for the bridges on the way. */
  raider: boolean;
  /** Wood the bridges on the way still need. */
  wood: number;
  /** Blocks missing from the fortification around the own crystal (defenders). */
  fort: number;
  /** Prefers the shotgun to the rifle. */
  shotgun: boolean;
  /** Earns money with a rod. */
  fisher: boolean;
  /** A whim (a mistake): something cheap and less useful first. */
  impulse: boolean;
}

export interface Wish { item: ShopItem; major: boolean }

const ITEM = new Map(SHOP.map((s) => [s.id, s]));
const GUNS = ['pistol', 'shotgun', 'rifle'] as const;
/** Medkits a bot keeps. */
const MEDKITS = Math.min(2, MAX_MEDKITS);
/** Apples a bot keeps for healing instead of selling them (once it has a gun and fights). */
export const KEEP_APPLES = 2;
const keepApples = (eco: Economy) => (GUNS.some((w) => eco.weapons.owned[w]) ? Math.min(eco.items.apple, KEEP_APPLES) : 0);

/**
 * What a bot wants from the shop, most important first. `major` purchases (tools, guns) are saved up for: nothing
 * further down the list in the same currency is bought while one of them is out of reach.
 */
export function wishlist(eco: Economy, n: Needs): Wish[] {
  const ws = eco.weapons, inv = eco.blocks.inventory;
  const out: Wish[] = [];
  const add = (id: string, major = false, times = 1) => {
    const item = ITEM.get(id);
    if (!item) return;
    for (let i = 0; i < times; i++) out.push({ item, major });
  };
  const hasGun = GUNS.some((w) => ws.owned[w]);
  if (n.impulse) {
    if (ws.ammo.grenade < 2) add('grenade');
    if (eco.items.medkit < 1) add('medkit');
  }
  if (n.fisher && !eco.has('rod')) add('rod', true);
  if (!hasGun) add('pistol', true);
  if (n.raider && n.wood > 0) {
    const lack = n.wood - inv.wood - (eco.has('builder') ? 0 : BUILDER_WOOD);
    if (lack > 0) add('wood', true, Math.ceil(lack / 16));
  }
  const main = n.shotgun ? 'shotgun' : 'rifle';
  if (!ws.owned[main]) add(main, true);
  if (eco.items.medkit < MEDKITS) add('medkit');
  if (n.raider && ws.ammo.grenade < 2) add('grenade');
  if (n.fort > 0) {
    if (inv.stone + inv.metal < Math.min(n.fort, 16)) add('stone');
  }
  const second = n.shotgun ? 'rifle' : 'shotgun';
  if (!ws.owned[second]) add(second, true);
  // crystals: the rocket launcher (metal for the fort with what is left)
  if (!ws.owned.rocket) add('rocket', true);
  if (n.fort > 0 && ws.owned.rocket && inv.metal < 4) add('metal');
  return out;
}

/** Sell everything the shop takes, apart from a few apples to eat. Returns the money made. */
export function sellLoot(eco: Economy): number {
  const keep = keepApples(eco);
  eco.items.apple -= keep;
  const cash = eco.sellAll();
  eco.items.apple += keep;
  return cash;
}

/** Money the loot would fetch (the apples kept for eating do not count). */
export function lootValue(eco: Economy): number {
  return eco.sellValue - keepApples(eco) * ITEMS.apple.sell;
}

/**
 * The next purchase the bot can make with what it has (+ `extra` money it would get for its loot), following the
 * saving rule of `wishlist`; null = nothing.
 */
export function nextBuy(eco: Economy, n: Needs, extra = 0): ShopItem | null {
  const blocked = new Set<Currency>();
  for (const w of wishlist(eco, n)) {
    const c = w.item.currency;
    if (blocked.has(c)) continue;
    if (eco.wallet[c] + (c === 'cash' ? extra : 0) >= w.item.price && canBuy(eco, w.item)) return w.item;
    if (w.major) blocked.add(c);
  }
  return null;
}

/** Shopping at the counter: sell the loot, then buy down the wish list while the money lasts. */
export function shop(eco: Economy, n: () => Needs): { sold: number; spent: number; bought: string[] } {
  const sold = sellLoot(eco);
  const before = { ...eco.wallet };
  const bought: string[] = [];
  for (let k = 0; k < 16; k++) {
    const item = nextBuy(eco, n());
    if (!item || eco.buy(item) !== 'ok') break;
    bought.push(item.id);
  }
  return { sold, spent: before.cash - eco.wallet.cash, bought };
}

/** Would the shop sell it (not owned yet, pockets not full)? */
function canBuy(eco: Economy, item: ShopItem) {
  if (item.step) return !eco.has(item.step);
  if (item.kind === 'weapon' && item.weapon !== 'grenade') return !eco.weapons.owned[item.weapon];
  if (item.kind === 'weapon' && item.weapon === 'grenade') return eco.weapons.ammo.grenade + item.count <= WEAPONS.grenade.mag;
  if (item.kind === 'item' && item.item === 'medkit') return eco.items.medkit + item.count <= MAX_MEDKITS;
  return true;
}
