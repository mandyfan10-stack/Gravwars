import { Quaternion, Vector3 } from 'three';
import type { BlockMaterial } from './blocks';
import { DEFAULT_MOVEMENT } from './constants';
import type { MapData } from './map';
import { Rng } from './math';
import type { PhysicsWorld, Rapier } from './physics';
import { giveWeapon, isGun, WeaponId, WeaponState, WEAPONS } from './weapons';

// --- items -------------------------------------------------------------------------------------

export type ItemId = 'bottle' | 'apple' | 'fish' | 'medkit';
export const ITEM_ORDER: ItemId[] = ['bottle', 'apple', 'fish', 'medkit'];
/**
 * Sell prices are deliberately low: a bottle is pocket change, a fish is worth the wait (0 = the shop does not
 * take it back). `heal`: HP restored when used from the hand (0 = not food; a bottle is thrown instead).
 */
export const ITEMS: Record<ItemId, { name: string; plural: string; sell: number; heal: number }> = {
  bottle: { name: 'Бутылка', plural: 'Бутылки', sell: 1, heal: 0 },
  apple: { name: 'Яблоко', plural: 'Яблоки', sell: 2, heal: 20 },
  fish: { name: 'Рыба', plural: 'Рыба', sell: 7, heal: 15 },
  medkit: { name: 'Аптечка', plural: 'Аптечки', sell: 0, heal: 100 },
};
export const SELLABLE = ITEM_ORDER.filter((i) => ITEMS[i].sell > 0);
export const APPLE_HEAL = ITEMS.apple.heal;
/** Medkits carried at most. */
export const MAX_MEDKITS = 3;
/** Seconds between two apples eaten (0.1 s cooldown). */
export const EAT_COOLDOWN = 0.1;
/** Seconds of holding LMB with an apple in hand to eat it. */
export const APPLE_EAT_TIME = 1.0;

// --- pickups on the map ------------------------------------------------------------------------

export type PickupKind = ItemId | 'cash' | 'ammo' | 'wood' | 'stone' | 'metal';
export interface Pickup {
  id: number;
  kind: PickupKind;
  /** Money in a dropped wad; items: how many in the pile (0 = one). */
  amount: number;
  /** Dropped by someone: gone for good once taken (or after `life` s). */
  once: boolean;
  pos: Vector3;
  up: Vector3;
  /** Downward fall speed (m/s) when falling under gravity; 0 when resting on ground. */
  vy?: number;
  /** True when resting on a surface. */
  grounded?: boolean;
  /** Lying there (false = taken, waiting to come back). */
  alive: boolean;
  respawnT: number;
  /** Bottles move to another street spot when they come back; apples stay under their tree. */
  spot: number;
}

export const PICKUPS = {
  /** Reach from the player's centre to an item for E (items are drawn ×2.5, so they are easy to spot). */
  reach: 2.6,
  appleRespawn: 45,
  /** Street litter is rare; most bottles are dropped by bums (npcs.ts). */
  bottleRespawn: 90,
  /** Litter bottles lying on the streets of each face. */
  bottlesPerIsland: 4,
  /** Dropped items disappear after this long. */
  dropLife: 180,
  /** No more dropped bottles on a face than this (bums stop littering). */
  maxBottlesPerIsland: 18,
};

/**
 * Apples under every tree, bottles on random street spots of every face (and dropped by bums).
 * Items sit on the ground found by a ray along the local gravity.
 */
export class Pickups {
  readonly items: Pickup[] = [];
  private readonly bottleSpots: { pos: Vector3; up: Vector3 }[] = [];
  private readonly rng = new Rng(9001);
  private nextId = 1;
  /** Colliders the ground ray passes through (people: a body standing over the spot is not the ground). */
  passThrough: ((c: { handle: number }) => boolean) | undefined;

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
    // bottles: along the road graph of each face, a little off the centre line
    for (const isl of map.faces) {
      const nav = map.nav[isl.id];
      if (!nav) continue;
      const up = new Vector3(...isl.up);
      const q = new Quaternion(...isl.quat);
      const origin = new Vector3(...isl.origin);
      for (const [a, b] of nav.edges) {
        const A = nav.nodes[a], B = nav.nodes[b];
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        for (let s = 3; s < len - 3; s += 6) {
          const k = s / len;
          const nx = -(B[1] - A[1]) / len, nz = (B[0] - A[0]) / len;
          const off = this.rng.range(-0.7, 0.7);
          const local = new Vector3(A[0] + (B[0] - A[0]) * k + nx * off, 0.3, A[1] + (B[1] - A[1]) * k + nz * off);
          const p = local.applyQuaternion(q).add(origin);
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
    const hit = this.world.castRay(new this.R.Ray(from, down), 4, true, undefined, undefined, undefined, undefined, this.passThrough);
    // nothing, or something well above the expected ground (a car roof, a bench): no item here
    if (!hit || hit.timeOfImpact < 0.9 || hit.timeOfImpact > 2.4) return null;
    return from.addScaledVector(down, hit.timeOfImpact - 0.02);
  }

  /** Something dropped on the ground at `pos` (a bum's empty bottle, a bandit's money). Null if there is no ground. */
  drop(kind: PickupKind, pos: Vector3, up: Vector3, amount = 0): Pickup | null {
    if (kind === 'bottle' && this.countOn('bottle', up) >= PICKUPS.maxBottlesPerIsland) return null;
    const ground = this.ground(pos.clone().addScaledVector(up, -0.5), up) ?? this.ground(pos, up);
    // Even if dropped higher in the air (e.g. from a crate or mid-air death), check if there is a floor within 25 m below
    let startPos = ground;
    let grounded = true;
    if (!startPos) {
      const from = pos.clone().addScaledVector(up, 0.5);
      const down = up.clone().negate();
      const hit = this.world.castRay(new this.R.Ray(from, down), 25, true, undefined, undefined, undefined, undefined, this.passThrough);
      if (!hit) return null;
      startPos = pos.clone().addScaledVector(up, 0.25);
      grounded = false;
    } else if (pos.distanceTo(startPos) > 0.35) {
      startPos = pos.clone();
      grounded = false;
    }
    const it: Pickup = {
      id: this.nextId++, kind, amount, once: true, pos: startPos, up: up.clone(),
      vy: 0, grounded, alive: true, respawnT: PICKUPS.dropLife, spot: -1,
    };
    this.items.push(it);
    return it;
  }

  /** Drop with a small random scatter around `pos` so multiple drops do not overlap. */
  dropSpread(kind: PickupKind, pos: Vector3, up: Vector3, amount = 0): Pickup | null {
    const side = new Vector3(1, 0, 0);
    if (Math.abs(side.dot(up)) > 0.9) side.set(0, 0, 1);
    side.addScaledVector(up, -side.dot(up)).normalize().applyAxisAngle(up, this.rng.range(0, Math.PI * 2));
    const r = this.rng.range(0.35, 1.15);
    return this.drop(kind, pos.clone().addScaledVector(side, r), up, amount) ?? this.drop(kind, pos, up, amount);
  }

  /** Loot dropped when a crate or barrel is broken: building resources, sometimes money and ammo. */
  dropCrateLoot(pos: Vector3, up: Vector3) {
    this.dropSpread('wood', pos, up, this.rng.int(4, 9));
    if (this.rng.chance(0.55)) this.dropSpread('stone', pos, up, this.rng.int(2, 5));
    if (this.rng.chance(0.3)) this.dropSpread('metal', pos, up, this.rng.int(1, 3));
    if (this.rng.chance(0.45)) this.dropSpread('cash', pos, up, this.rng.int(3, 8));
    if (this.rng.chance(0.5)) this.dropSpread('ammo', pos, up, 1);
  }

  /** Items of a kind lying on the surface with this up. */
  countOn(kind: PickupKind, up: Vector3) {
    return this.items.reduce((n, it) => n + (it.alive && it.kind === kind && it.up.dot(up) > 0.99 ? 1 : 0), 0);
  }

  tick(dt: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.alive) {
        // Physics for pickable items: if not grounded (or if ground beneath was destroyed), fall with gravity
        const down = it.up.clone().negate();
        const from = it.pos.clone().addScaledVector(it.up, 0.35);
        const hit = this.world.castRay(new this.R.Ray(from, down), 30, true, undefined, undefined, undefined, undefined, this.passThrough);
        if (!hit) {
          it.grounded = false;
          it.vy = (it.vy ?? 0) + DEFAULT_MOVEMENT.gravity * dt;
          it.pos.addScaledVector(down, it.vy * dt);
        } else {
          const distToGround = hit.timeOfImpact - 0.33;
          if (distToGround > 0.04) {
            it.grounded = false;
            it.vy = (it.vy ?? 0) + DEFAULT_MOVEMENT.gravity * dt;
            const step = it.vy * dt;
            if (step >= distToGround) {
              it.pos.copy(from).addScaledVector(down, hit.timeOfImpact - 0.02);
              it.vy = 0;
              it.grounded = true;
            } else {
              it.pos.addScaledVector(down, step);
            }
          } else {
            if (!it.grounded) {
              it.pos.copy(from).addScaledVector(down, hit.timeOfImpact - 0.02);
              it.grounded = true;
            }
            it.vy = 0;
          }
        }
      }
      if (it.once) {
        it.respawnT -= dt;
        if (!it.alive || it.respawnT <= 0) this.items.splice(i, 1);
        continue;
      }
      if (it.alive) continue;
      it.respawnT -= dt;
      if (it.respawnT > 0) continue;
      if (it.kind === 'bottle') {
        // a new free spot on the same face
        const taken = new Set(this.items.filter((o) => o.alive && o.kind === 'bottle' && !o.once).map((o) => o.spot));
        const free = this.bottleSpots.map((s, i) => i).filter((i) => !taken.has(i) && this.bottleSpots[i].up.equals(it.up));
        if (free.length) it.spot = this.rng.pick(free);
        it.pos.copy(this.bottleSpots[it.spot].pos);
      }
      it.alive = true;
      it.grounded = true;
      it.vy = 0;
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

  /** All alive items within `radius` m of the point 1 m in front of the player (for holding E). */
  inFrontRadius(center: Vector3, forward: Vector3, up: Vector3, radius = 1.0): Pickup[] {
    const flatFwd = forward.clone().addScaledVector(up, -forward.dot(up));
    if (flatFwd.lengthSq() > 1e-4) flatFwd.normalize();
    const frontSpot = center.clone().addScaledVector(flatFwd, 1.0);
    const out: Pickup[] = [];
    for (const it of this.items) {
      if (!it.alive) continue;
      // Check planar + vertical distance to the 1m spot in front of the player (or within reach in front)
      const relFront = it.pos.clone().sub(frontSpot);
      const vDist = Math.abs(relFront.dot(up));
      const pDist = relFront.addScaledVector(up, -relFront.dot(up)).length();
      if (vDist <= 1.6 && (pDist <= radius || (center.distanceTo(it.pos) <= PICKUPS.reach && it.pos.clone().sub(center).dot(flatFwd) >= -0.2))) {
        out.push(it);
      }
    }
    return out;
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

/** One-off tools: bought once, kept for the match. */
export type Step = 'rod' | 'builder' | 'hook';

/** Wood that comes with the build tool, so that it is usable right away (a bridge to the centre is ~75 plates). */
export const BUILDER_WOOD = 16;

export type ShopItem = {
  id: string;
  label: string;
  /** Short note under the label. */
  note?: string;
  price: number;
  currency: Currency;
  /** Tool this purchase gives (one-off). */
  step?: Step;
} & (
  | { kind: 'tool' }
  | { kind: 'weapon'; weapon: WeaponId; count: number }
  | { kind: 'ammo'; weapon: WeaponId; count: number }
  | { kind: 'blocks'; material: BlockMaterial; count: number }
  | { kind: 'item'; item: ItemId; count: number }
);

/**
 * The shop window's rows: item ids by column (null = an empty slot). Every gun's ammo sits right under the gun.
 * `short`: the name on the tile (the full label is in the details line).
 */
export const SHOP_ROWS: { label: string; ids: (string | null)[] }[] = [
  { label: 'Оружие', ids: ['pistol', 'shotgun', 'rifle', 'crossbow', 'rocket', 'grenade'] },
  { label: 'Блоки', ids: ['wood', 'stone', 'metal'] },
  { label: 'Снаряжение', ids: ['hook', 'rod', 'medkit'] },
];
export const SHOP_SHORT: Record<string, string> = {
  builder: 'Лопатка', crossbow: 'Арбалет', grenade: 'Гранаты', wood: 'Дерево', stone: 'Камень', metal: 'Металл',
};

/** Everything is on the shelf from the start; building mode (B) is always available and ammo is found in the world or at your crystal. */
export const SHOP: ShopItem[] = [
  { id: 'rod', label: 'Удочка', note: 'ловить рыбу в прудах парка', price: 5, currency: 'cash', step: 'rod', kind: 'tool' },
  { id: 'hook', label: 'Крюк-кошка', note: 'притягивает к точке до 35 м', price: 9, currency: 'cash', step: 'hook', kind: 'tool' },
  { id: 'pistol', label: 'Пистолет', note: `магазин ${WEAPONS.pistol.mag}`, price: 19, currency: 'cash', kind: 'weapon', weapon: 'pistol', count: WEAPONS.pistol.mag },
  { id: 'shotgun', label: 'Дробовик', note: `${WEAPONS.shotgun.mag} патронов, вблизи смертелен`, price: 27, currency: 'cash', kind: 'weapon', weapon: 'shotgun', count: WEAPONS.shotgun.mag },
  { id: 'rifle', label: 'Автомат', note: `магазин ${WEAPONS.rifle.mag}`, price: 41, currency: 'cash', kind: 'weapon', weapon: 'rifle', count: WEAPONS.rifle.mag },
  { id: 'crossbow', label: 'Арбалет', note: 'зажим ЛКМ (0–3 ур., 5–20 ур.), ПКМ — зум', price: 34, currency: 'cash', kind: 'weapon', weapon: 'crossbow', count: 1 },
  { id: 'rocket', label: 'Ракетница', note: `взрыв ${WEAPONS.rocket.radius} м, ${WEAPONS.rocket.damage} урона`, price: 4, currency: 'crystal', kind: 'weapon', weapon: 'rocket', count: 1 },
  { id: 'grenade', label: 'Гранаты ×2', price: 14, currency: 'cash', kind: 'weapon', weapon: 'grenade', count: 2 },
  { id: 'wood', label: 'Дерево ×16', note: '1 дерево = 1 постройка', price: 4, currency: 'cash', kind: 'blocks', material: 'wood', count: 16 },
  { id: 'stone', label: 'Камень ×8', price: 8, currency: 'cash', kind: 'blocks', material: 'stone', count: 8 },
  { id: 'metal', label: 'Металл ×4', price: 2, currency: 'crystal', kind: 'blocks', material: 'metal', count: 4 },
  { id: 'medkit', label: 'Аптечка', note: 'в руку, ЛКМ — полное здоровье', price: 8, currency: 'cash', kind: 'item', item: 'medkit', count: 1 },
];

export type BuyResult = 'ok' | 'money' | 'full';
/** What the shop shows: every item still for sale and whether it is affordable. */
export interface ShopOffer { item: ShopItem; state: 'ok' | 'money' }

/**
 * One player's money and pockets: wallet, items, bought tools. Purchases go straight into the weapon state
 * and the block inventory.
 */
export class Economy {
  readonly items: Record<ItemId, number> = { bottle: 0, apple: 0, fish: 0, medkit: 0 };
  readonly done = new Set<Step>(['builder']);

  /** `blocks`: where bought material goes (the player's BlockSystem, or a bot's own pockets). */
  constructor(readonly wallet: Record<Currency, number>, readonly blocks: { inventory: Record<BlockMaterial, number> }, readonly weapons: WeaponState) {}

  has(step: Step) {
    return this.done.has(step);
  }

  /** Already owned for good: one-off tools and guns leave the shelf once bought. */
  private sold(item: ShopItem) {
    if (item.step) return this.done.has(item.step);
    return item.kind === 'weapon' && item.weapon !== 'grenade' && this.weapons.owned[item.weapon];
  }

  /** Items on the shelf now, in shop order. */
  offers(): ShopOffer[] {
    return SHOP.filter((item) => !this.sold(item))
      .map((item) => ({ item, state: this.wallet[item.currency] >= item.price ? 'ok' as const : 'money' as const }));
  }

  /** Buy an item. */
  buy(item: ShopItem): BuyResult {
    if (this.sold(item)) return 'full';
    if (this.wallet[item.currency] < item.price) return 'money';
    const ws = this.weapons;
    if (item.kind === 'weapon' && item.weapon === 'grenade' && ws.ammo.grenade + item.count > WEAPONS.grenade.mag) return 'full';
    if (item.kind === 'item' && item.item === 'medkit' && this.items.medkit + item.count > MAX_MEDKITS) return 'full';
    this.wallet[item.currency] -= item.price;
    if (item.step) this.done.add(item.step);
    if (item.kind === 'blocks') this.blocks.inventory[item.material] += item.count;
    else if (item.kind === 'weapon') {
      giveWeapon(ws, item.weapon, item.count);
      if (isGun(item.weapon)) ws.reserve[item.weapon] += item.count * 2;
    }
    else if (item.kind === 'ammo' && isGun(item.weapon)) ws.reserve[item.weapon] += item.count;
    else if (item.kind === 'item') this.items[item.item] += item.count;
    else if (item.kind === 'tool' && item.id === 'builder') this.blocks.inventory.wood += BUILDER_WOOD;
    return 'ok';
  }

  /** Sell every item of a kind; returns the money made. */
  sell(id: ItemId): number {
    if (!ITEMS[id].sell) return 0;
    const n = this.items[id];
    const cash = n * ITEMS[id].sell;
    this.items[id] = 0;
    this.wallet.cash += cash;
    return cash;
  }

  sellAll(): number {
    return SELLABLE.reduce((sum, id) => sum + this.sell(id), 0);
  }

  get sellValue() {
    return SELLABLE.reduce((sum, id) => sum + this.items[id] * ITEMS[id].sell, 0);
  }

  /** Use up one item (eaten, thrown, applied). False if there is none. */
  take(id: ItemId): boolean {
    if (this.items[id] <= 0) return false;
    this.items[id]--;
    return true;
  }

  /** Eat an apple. Returns false if there is none. */
  eat(): boolean {
    return this.take('apple');
  }

  /**
   * Death: everything in the pockets falls out — the items and half of the cash (the killer can pick it up).
   * Tools, guns, ammo and blocks are kept. Returns the piles to put on the ground.
   */
  spill(): { kind: PickupKind; amount: number }[] {
    const out: { kind: PickupKind; amount: number }[] = [];
    for (const id of ITEM_ORDER) {
      if (this.items[id] > 0) out.push({ kind: id, amount: this.items[id] });
      this.items[id] = 0;
    }
    const cash = Math.floor(this.wallet.cash / 2);
    if (cash > 0) {
      this.wallet.cash -= cash;
      out.push({ kind: 'cash', amount: cash });
    }
    const ws = this.weapons;
    if (ws.owned.pistol || ws.owned.shotgun || ws.owned.rifle || ws.owned.rocket) {
      out.push({ kind: 'ammo', amount: 1 });
    }
    return out;
  }
}
