import { Quaternion, Vector3 } from 'three';
import { BlockMaterial, BlockSystem } from './blocks';
import type { MapData } from './map';
import { frameForUp, Rng } from './math';
import type { PhysicsWorld, Rapier } from './physics';
import { TEAMS } from './teams';
import { giveWeapon, isGun, WeaponId, WeaponState, WEAPONS } from './weapons';

// --- items -------------------------------------------------------------------------------------

export type ItemId = 'bottle' | 'apple' | 'fish';
export const ITEM_ORDER: ItemId[] = ['bottle', 'apple', 'fish'];
/** Sell prices are deliberately low: a bottle is pocket change, a fish is worth the wait. */
export const ITEMS: Record<ItemId, { name: string; plural: string; sell: number }> = {
  bottle: { name: 'Бутылка', plural: 'Бутылки', sell: 1 },
  apple: { name: 'Яблоко', plural: 'Яблоки', sell: 2 },
  fish: { name: 'Рыба', plural: 'Рыба', sell: 5 },
};
export const APPLE_HEAL = 25;
/** Seconds between two apples eaten. */
export const EAT_COOLDOWN = 0.8;

// --- pickups on the map ------------------------------------------------------------------------

export type PickupKind = 'apple' | 'bottle' | 'cash';
export interface Pickup {
  id: number;
  kind: PickupKind;
  /** Money in a dropped wad (cash only). */
  amount: number;
  /** Dropped by someone: gone for good once taken (or after `life` s). */
  once: boolean;
  pos: Vector3;
  up: Vector3;
  /** Lying there (false = taken, waiting to come back). */
  alive: boolean;
  respawnT: number;
  /** Bottles move to another street spot when they come back; apples stay under their tree. */
  spot: number;
}

export const PICKUPS = {
  /** Reach from the player's centre to an item for E. */
  reach: 2.2,
  appleRespawn: 45,
  /** Street litter is rare; most bottles are dropped by bums (npcs.ts). */
  bottleRespawn: 90,
  /** Litter bottles lying on the streets of each base island. */
  bottlesPerIsland: 4,
  /** Dropped items disappear after this long. */
  dropLife: 180,
  /** No more dropped bottles on an island than this (bums stop littering). */
  maxBottlesPerIsland: 18,
};

/**
 * Apples under every tree, bottles on random street spots of the base islands (later: dropped by bums).
 * Items sit on the ground found by a ray along the local gravity.
 */
export class Pickups {
  readonly items: Pickup[] = [];
  private readonly bottleSpots: { pos: Vector3; up: Vector3 }[] = [];
  private readonly rng = new Rng(9001);
  private nextId = 1;

  constructor(private R: Rapier, private world: PhysicsWorld, map: MapData) {
    for (const t of map.trees) {
      if (t.kind !== 'tree') continue;
      const up = new Vector3(...t.up);
      const side = new Vector3(1, 0, 0);
      if (Math.abs(side.dot(up)) > 0.9) side.set(0, 0, 1);
      side.addScaledVector(up, -side.dot(up)).normalize().applyAxisAngle(up, this.rng.range(0, Math.PI * 2));
      const p = new Vector3(...t.pos).addScaledVector(side, this.rng.range(0.7, 1.3) * t.scale);
      const ground = this.ground(p, up);
      if (!ground) continue;
      this.items.push({ id: this.nextId++, kind: 'apple', amount: 0, once: false, pos: ground, up, alive: true, respawnT: 0, spot: -1 });
    }
    // bottles: along the road graph of each base island, a little off the centre line
    for (const team of TEAMS) {
      const nav = map.nav[team.id];
      if (!nav) continue;
      const up = new Vector3(...team.down).negate();
      const q = frameForUp(up, new Quaternion());
      for (const [a, b] of nav.edges) {
        const A = nav.nodes[a], B = nav.nodes[b];
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        for (let s = 3; s < len - 3; s += 6) {
          const k = s / len;
          const nx = -(B[1] - A[1]) / len, nz = (B[0] - A[0]) / len;
          const off = this.rng.range(-0.7, 0.7);
          const local = new Vector3(A[0] + (B[0] - A[0]) * k + nx * off, 0.3, A[1] + (B[1] - A[1]) * k + nz * off);
          const p = local.applyQuaternion(q).addScaledVector(up, -map.islandDistance);
          const ground = this.ground(p, up);
          if (ground) this.bottleSpots.push({ pos: ground, up });
        }
      }
      const own = this.bottleSpots.filter((s) => s.up.equals(up));
      for (let i = 0; i < PICKUPS.bottlesPerIsland && own.length; i++) {
        const spot = this.bottleSpots.indexOf(own.splice(this.rng.int(0, own.length - 1), 1)[0]);
        const s = this.bottleSpots[spot];
        this.items.push({ id: this.nextId++, kind: 'bottle', amount: 0, once: false, pos: s.pos.clone(), up: s.up, alive: true, respawnT: 0, spot });
      }
    }
  }

  /** Ground under `p` along -up (expected within ~0.6 m of `p`). */
  private ground(p: Vector3, up: Vector3): Vector3 | null {
    const from = p.clone().addScaledVector(up, 1.5);
    const down = up.clone().negate();
    const hit = this.world.castRay(new this.R.Ray(from, down), 4, true);
    // nothing, or something well above the expected ground (a car roof, a bench): no item here
    if (!hit || hit.timeOfImpact < 0.9 || hit.timeOfImpact > 2.4) return null;
    return from.addScaledVector(down, hit.timeOfImpact - 0.02);
  }

  /** Something dropped on the ground at `pos` (a bum's empty bottle, a bandit's money). Null if there is no ground. */
  drop(kind: PickupKind, pos: Vector3, up: Vector3, amount = 0): Pickup | null {
    if (kind === 'bottle' && this.countOn('bottle', up) >= PICKUPS.maxBottlesPerIsland) return null;
    const ground = this.ground(pos.clone().addScaledVector(up, -0.5), up);
    if (!ground) return null;
    const it: Pickup = { id: this.nextId++, kind, amount, once: true, pos: ground, up: up.clone(), alive: true, respawnT: PICKUPS.dropLife, spot: -1 };
    this.items.push(it);
    return it;
  }

  /** Items of a kind lying on the surface with this up. */
  countOn(kind: PickupKind, up: Vector3) {
    return this.items.reduce((n, it) => n + (it.alive && it.kind === kind && it.up.dot(up) > 0.99 ? 1 : 0), 0);
  }

  tick(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.once) {
        it.respawnT -= dt;
        if (!it.alive || it.respawnT <= 0) this.items.splice(i, 1);
        continue;
      }
      if (it.alive) continue;
      it.respawnT -= dt;
      if (it.respawnT > 0) continue;
      if (it.kind === 'bottle') {
        // a new free spot on the same island
        const taken = new Set(this.items.filter((o) => o.alive && o.kind === 'bottle' && !o.once).map((o) => o.spot));
        const free = this.bottleSpots.map((s, i) => i).filter((i) => !taken.has(i) && this.bottleSpots[i].up.equals(it.up));
        if (free.length) it.spot = this.rng.pick(free);
        it.pos.copy(this.bottleSpots[it.spot].pos);
      }
      it.alive = true;
    }
  }

  /** Closest item within reach of the player's centre. */
  nearest(center: Vector3, reach = PICKUPS.reach): Pickup | null {
    let best: Pickup | null = null;
    let bestD = reach;
    for (const it of this.items) {
      if (!it.alive) continue;
      const d = center.distanceTo(it.pos);
      if (d < bestD) { best = it; bestD = d; }
    }
    return best;
  }

  take(it: Pickup) {
    it.alive = false;
    if (it.once) return;
    it.respawnT = it.kind === 'apple' ? PICKUPS.appleRespawn : PICKUPS.bottleRespawn;
  }
}


// --- wallet, shop, selling ---------------------------------------------------------------------

export type Currency = 'cash' | 'crystal';
export const CURRENCY_LABEL: Record<Currency, string> = { cash: 'деньги', crystal: 'кристаллы' };

/** Purchase ladder: each step opens after the previous one is bought. */
export type Step = 'rod' | 'builder' | 'pistol' | 'rifle' | 'grenade' | 'blocks';
export const LADDER: Step[] = ['rod', 'builder', 'pistol', 'rifle', 'grenade', 'blocks'];
export const STEP_LABEL: Record<Step, string> = {
  rod: 'Удочка', builder: 'Инструмент строителя', pistol: 'Пистолет', rifle: 'Автомат', grenade: 'Гранаты', blocks: 'Камень и металл',
};

/** Wood that comes with the build tool, so that it is usable right away. */
export const BUILDER_WOOD = 12;

export type ShopItem = {
  id: string;
  label: string;
  /** Short note under the label. */
  note?: string;
  price: number;
  currency: Currency;
  /** Ladder step this purchase completes (first purchase only). */
  step?: Step;
  /** Ladder step that must be done before this item shows up. */
  needs?: Step;
} & (
  | { kind: 'tool' }
  | { kind: 'weapon'; weapon: WeaponId; count: number }
  | { kind: 'ammo'; weapon: WeaponId; count: number }
  | { kind: 'blocks'; material: BlockMaterial; count: number }
  | { kind: 'heal' }
);

export const SHOP: ShopItem[] = [
  { id: 'rod', label: 'Удочка', note: 'ловить рыбу в пруду парка', price: 6, currency: 'cash', step: 'rod', kind: 'tool' },
  { id: 'builder', label: 'Инструмент строителя', note: `+${BUILDER_WOOD} дерева`, price: 15, currency: 'cash', step: 'builder', needs: 'rod', kind: 'tool' },
  { id: 'pistol', label: 'Пистолет', note: `магазин ${WEAPONS.pistol.mag}`, price: 25, currency: 'cash', step: 'pistol', needs: 'builder', kind: 'weapon', weapon: 'pistol', count: WEAPONS.pistol.mag },
  { id: 'rifle', label: 'Автомат', note: `магазин ${WEAPONS.rifle.mag}`, price: 55, currency: 'cash', step: 'rifle', needs: 'pistol', kind: 'weapon', weapon: 'rifle', count: WEAPONS.rifle.mag },
  { id: 'grenade', label: 'Гранаты ×2', price: 18, currency: 'cash', step: 'grenade', needs: 'rifle', kind: 'weapon', weapon: 'grenade', count: 2 },
  { id: 'stone', label: 'Камень ×12', price: 16, currency: 'cash', step: 'blocks', needs: 'grenade', kind: 'blocks', material: 'stone', count: 12 },
  { id: 'metal', label: 'Металл ×6', price: 3, currency: 'crystal', needs: 'blocks', kind: 'blocks', material: 'metal', count: 6 },
  { id: 'ammo-pistol', label: 'Патроны: пистолет ×15', price: 4, currency: 'cash', needs: 'pistol', kind: 'ammo', weapon: 'pistol', count: 15 },
  { id: 'ammo-rifle', label: 'Патроны: автомат ×30', price: 8, currency: 'cash', needs: 'rifle', kind: 'ammo', weapon: 'rifle', count: 30 },
  { id: 'wood', label: 'Дерево ×16', price: 6, currency: 'cash', needs: 'builder', kind: 'blocks', material: 'wood', count: 16 },
  { id: 'heal', label: 'Аптечка', price: 10, currency: 'cash', kind: 'heal' },
];

export type BuyResult = 'ok' | 'money' | 'locked' | 'full';
/** What the shop shows: buyable items (with their key), plus the next locked ladder step as a teaser. */
export interface ShopOffer { item: ShopItem; state: 'ok' | 'money' | 'locked' }

/**
 * One player's money and pockets: wallet, items, ladder progress. Purchases go straight into the weapon state
 * and the block inventory.
 */
export class Economy {
  readonly items: Record<ItemId, number> = { bottle: 0, apple: 0, fish: 0 };
  readonly done = new Set<Step>();

  constructor(readonly wallet: Record<Currency, number>, readonly blocks: BlockSystem, readonly weapons: WeaponState) {}

  has(step: Step) {
    return this.done.has(step);
  }

  /** Is the item for sale right now (its ladder requirement met; one-off steps not bought yet)? */
  unlocked(item: ShopItem) {
    return !item.needs || this.done.has(item.needs);
  }

  /** Items that are on the shelf now, in shop order; one-off tools already bought are gone. */
  offers(): ShopOffer[] {
    const out: ShopOffer[] = [];
    let teaser = false;
    for (const item of SHOP) {
      const oneOff = item.kind === 'tool' || (item.kind === 'weapon' && item.weapon !== 'grenade');
      if (oneOff && item.step && this.done.has(item.step)) continue;
      if (!this.unlocked(item)) {
        // show only the next ladder step as a locked teaser
        if (!teaser && item.step) { out.push({ item, state: 'locked' }); teaser = true; }
        continue;
      }
      out.push({ item, state: this.wallet[item.currency] >= item.price ? 'ok' : 'money' });
    }
    return out;
  }

  /** Buy an item. `heal` is applied by the caller (it only checks for money here). */
  buy(item: ShopItem): BuyResult {
    if (!this.unlocked(item)) return 'locked';
    if (this.wallet[item.currency] < item.price) return 'money';
    const ws = this.weapons;
    if (item.kind === 'weapon' && item.weapon === 'grenade' && ws.ammo.grenade >= WEAPONS.grenade.mag) return 'full';
    this.wallet[item.currency] -= item.price;
    if (item.step) this.done.add(item.step);
    if (item.kind === 'blocks') this.blocks.inventory[item.material] += item.count;
    else if (item.kind === 'weapon') giveWeapon(ws, item.weapon, item.count);
    else if (item.kind === 'ammo' && isGun(item.weapon)) ws.reserve[item.weapon] += item.count;
    else if (item.kind === 'tool' && item.id === 'builder') this.blocks.inventory.wood += BUILDER_WOOD;
    return 'ok';
  }

  /** Sell every item of a kind; returns the money made. */
  sell(id: ItemId): number {
    const n = this.items[id];
    const cash = n * ITEMS[id].sell;
    this.items[id] = 0;
    this.wallet.cash += cash;
    return cash;
  }

  sellAll(): number {
    return ITEM_ORDER.reduce((sum, id) => sum + this.sell(id), 0);
  }

  get sellValue() {
    return ITEM_ORDER.reduce((sum, id) => sum + this.items[id] * ITEMS[id].sell, 0);
  }

  /** Eat an apple. Returns false if there is none. */
  eat(): boolean {
    if (this.items.apple <= 0) return false;
    this.items.apple--;
    return true;
  }
}
