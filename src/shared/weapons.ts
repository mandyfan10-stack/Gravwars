/** Weapon definitions + per-player weapon state machine (shared by client prediction and server). */
export type WeaponId = 'fists' | 'pistol' | 'shotgun' | 'rifle' | 'crossbow' | 'rocket' | 'grenade';
export const WEAPON_ORDER: WeaponId[] = ['fists', 'pistol', 'shotgun', 'rifle', 'crossbow', 'rocket', 'grenade'];

export interface CrossbowLevel {
  level: 0 | 1 | 2 | 3;
  /** Final HP damage (raw). */
  damage: number;
  blockDamage: number;
  /** Projectile width in meters (diameter = 2 * radius). */
  width: number;
  /** Post-shot reload / cooldown: 0.5 s + 1 s * level. */
  reload: number;
  /** Knockback multiplier (scales with charge level). */
  push: number;
  speed: number;
}

export const CROSSBOW_CHARGE_RATE = 1.5;

export const CROSSBOW_LEVELS: readonly CrossbowLevel[] = [
  { level: 0, damage: 5, blockDamage: 15, width: 0.25, reload: 0.375, push: 0.8, speed: 180 },
  { level: 1, damage: 10, blockDamage: 35, width: 1.0, reload: 1.125, push: 2.2, speed: 45 },
  { level: 2, damage: 25, blockDamage: 75, width: 1.75, reload: 1.875, push: 4.5, speed: 24 },
  { level: 3, damage: 60, blockDamage: 140, width: 2.5, reload: 2.625, push: 8.5, speed: 5 },
];

export function crossbowSpec(chargeT: number): CrossbowLevel {
  const lvl = Math.min(3, Math.max(0, Math.floor(chargeT + 1e-6))) as 0 | 1 | 2 | 3;
  return CROSSBOW_LEVELS[lvl];
}

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /**
   * Flight speed, m/s (0 = melee). GravWars bullets are slow on purpose (you see them fly and can lead a target);
   * how hard they hit walls is `power`.
   */
  speed: number;
  /**
   * Bullets: the real muzzle speed the wall penetration is reckoned with, m/s (a slow tracer of a rifle still goes
   * through planks like a real 5.45 round). 0 = never pierces.
   */
  power: number;
  /** Projectiles per shot (shotgun pellets) spread evenly over a cone of `cone` rad (half-angle). */
  pellets: number;
  cone: number;
  /** Knockback of a hit × this (pellets push a little each, the sum is one good shove). */
  push: number;
  /** `damage` is final, not scaled by DAMAGE_SCALE (the rocket: 50 HP). */
  raw: boolean;
  /** Blows up on the first thing it touches (the rocket); grenades bounce and wait for the fuse. */
  explodeOnHit: boolean;
  /** Share of the shooter's gravity applied to the projectile. */
  gravityScale: number;
  /** Share of the wind applied to the projectile. */
  windScale: number;
  /**
   * Damage to players, bots and NPCs. Tuned for a time-to-kill of about 4–6 s in a real fight (~40 % of shots hit);
   * a perfect spray kills in ~1.5 s.
   */
  damage: number;
  /** Damage to buildings: kept apart from `damage` so that the TTK tuning does not change how long walls hold. */
  blockDamage: number;
  /** Seconds between shots / swings. */
  interval: number;
  /** Holding the trigger keeps firing (otherwise one shot per click). */
  auto: boolean;
  /** Magazine size (guns); grenades are carried up to this many. 0 = no ammo (fists). */
  mag: number;
  reload: number;
  /** Max flight time, s. */
  life: number;
  /** Share of the shooter's velocity added to the projectile. */
  inherit: number;
  headMul: number;
  /** Melee reach from the eye, m (fists only). */
  reach: number;
  // grenade only
  fuse: number;
  radius: number;
  bounce: number;
  knockback: number;
  selfMul: number;
  /** Bullets: reload with an empty magazine takes this long (the bolt / slide has to be racked), s. */
  reloadEmpty: number;
  /**
   * Bullets: air drag, 1/m (a = -drag·|v|·v relative to the air). Damage scales with the kinetic energy left,
   * so slow far bullets hurt less: (v / speed)², but not below `minEnergy`.
   */
  drag: number;
  minEnergy: number;
  /** Accuracy: cone half-angle standing still, rad; + per shot of sustained fire (bloom), + at full run speed. */
  spread: number;
  bloom: number;
  moveSpread: number;
  /** Recoil per shot: view climb and sideways wobble, rad. */
  recoil: number;
  recoilYaw: number;
  /** Shooting in the air pushes the shooter back this hard, m/s per shot. */
  airPush: number;
}

const base = { power: 0, pellets: 1, cone: 0, push: 1, raw: false, explodeOnHit: false, reloadEmpty: 0, drag: 0, minEnergy: 1, spread: 0, bloom: 0, moveSpread: 0, recoil: 0, recoilYaw: 0, airPush: 0, headMul: 1, fuse: 0, radius: 0, bounce: 0, knockback: 0, selfMul: 0, reach: 0, auto: false, reload: 0, inherit: 0 };

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  // punches land on everyone in front (MELEE) and shove them back
  fists: {
    ...base, id: 'fists', name: 'Кулаки', speed: 0, gravityScale: 0, windScale: 0, damage: 10, blockDamage: 12, headMul: 1.25,
    interval: 0.42, auto: true, mag: 0, life: 0, reach: 2.3,
  },
  // 9×19 mm self-loading pistol: 2x ballistics, +25% bullet damage
  pistol: {
    ...base, id: 'pistol', name: 'Пистолет', speed: 150, power: 360, gravityScale: 0.34, windScale: 0.5, damage: 10, blockDamage: 26, headMul: 2,
    interval: 0.12, mag: 15, reload: 1.69, reloadEmpty: 2.14, life: 3, drag: 0.0019, minEnergy: 0.3,
    spread: 0.004, bloom: 0.006, moveSpread: 0.02, recoil: 0.03, recoilYaw: 0.008, airPush: 2.8,
  },
  // pump shotgun: 8 pellets in a fixed cone, 2x ballistics, damage 11, +50% owner pushback
  shotgun: {
    ...base, id: 'shotgun', name: 'Дробовик', speed: 140, power: 420, pellets: 8, cone: 0.065, push: 0.35, gravityScale: 0.3, windScale: 0.5,
    damage: 11, blockDamage: 12, headMul: 1.5, interval: 0.8, mag: 6, reload: 2.7, reloadEmpty: 3.15, life: 1.2, drag: 0.012, minEnergy: 0.15,
    moveSpread: 0.02, recoil: 0.075, recoilYaw: 0.012, airPush: 10.5,
  },
  // 5.45×39 mm assault rifle, 650 rounds per minute: 2x ballistics, +25% bullet damage
  rifle: {
    ...base, id: 'rifle', name: 'Автомат', speed: 210, power: 880, gravityScale: 0.12, windScale: 0.5, damage: 7, blockDamage: 28, headMul: 2,
    interval: 0.092, auto: true, mag: 30, reload: 2.36, reloadEmpty: 2.925, life: 3, drag: 0.0008, minEnergy: 0.3,
    spread: 0.0025, bloom: 0.0045, moveSpread: 0.035, recoil: 0.013, recoilYaw: 0.006, airPush: 1.5,
  },
  // crossbow: hold LMB to charge (levels 0..3, 1s per level), release to fire; RMB zooms
  crossbow: {
    ...base, id: 'crossbow', name: 'Арбалет', speed: 180, power: 650, gravityScale: 0, windScale: 0, damage: 10, raw: true,
    blockDamage: 40, headMul: 1.5, interval: 0.5, mag: 1, reload: 0.375, reloadEmpty: 0.375, life: 16,
    drag: 0, minEnergy: 1, recoil: 0.025, recoilYaw: 0.004, airPush: 3.2,
  },
  // single-shot rocket launcher: 2x ballistics, +70% rocket damage (80 * 1.7 = 136), +50% radius (4.5 -> 6.75)
  rocket: {
    ...base, id: 'rocket', name: 'Ракетница', speed: 36, gravityScale: 0, windScale: 0, damage: 136, raw: true, explodeOnHit: true,
    blockDamage: 272, interval: 0.9, mag: 1, reload: 1.91, reloadEmpty: 1.91, life: 5,
    radius: 6.75, knockback: 20, selfMul: 0.4, recoil: 0.05, recoilYaw: 0.01, airPush: 5.0,
  },
  grenade: {
    ...base, id: 'grenade', name: 'Граната', speed: 22, gravityScale: 1, windScale: 0.6, damage: 45, blockDamage: 75,
    interval: 0.7, mag: 4, life: 6, inherit: 0.6,
    fuse: 2.5, radius: 5.5, bounce: 0.22, knockback: 16, selfMul: 0.35,
  },
};

/** Punches: everyone within the reach and this cone (cos of the half-angle) is hit; the push, m/s. */
export const MELEE = { cos: Math.cos(0.8), push: 5.5, lift: 0.3 };
/**
 * Kick (V): everyone and every crate / barrel in a wide cone in front. `damage` is final (HP); cooldown `cdHit = 2` s
 * after hitting a player/bot/NPC, `cdMiss = 0.1` s on a miss or wall/prop hit. Does not recharge in the air.
 */
export const KICK = { reach: 2.4, cos: Math.cos(1), damage: 10, push: 3.6, lift: 0.14, propSpeed: 3.6, cdHit: 2, cdMiss: 0.1, recoilDist: 0.6, recoilPush: 3.4, wallRecoilPush: 5.8 };

/** Guns that use a magazine + spare ammo bought in the shop. */
export const isGun = (w: WeaponId) => w === 'pistol' || w === 'rifle' || w === 'shotgun' || w === 'crossbow' || w === 'rocket';
/** Guns in the order a fighter prefers them when nothing better is said. */
export const GUNS_BEST_FIRST: WeaponId[] = ['rifle', 'crossbow', 'shotgun', 'pistol', 'rocket'];

export interface WeaponState {
  current: WeaponId;
  owned: Record<WeaponId, boolean>;
  /** Rounds in the magazine (guns) / grenades carried. */
  ammo: Record<WeaponId, number>;
  /** Spare rounds for reloading (guns). */
  reserve: Record<WeaponId, number>;
  cooldown: number;
  /** > 0 while reloading the current gun. */
  reloadT: number;
  /** Length of the reload in progress (tactical or empty), s. */
  reloadTotal: number;
  /** Trigger was held last tick (semi-auto guns fire on the press). */
  held: boolean;
  /** Sustained fire: shots in a row, cools down between them (spread bloom, recoil pattern). */
  heat: number;
  /** Tried to fire an empty gun with nothing to reload: dry click (for the sound). */
  dry: boolean;
  /** Kick (V) cooldown left, s, and its full length (HUD). */
  kickCd: number;
  kickCdTotal: number;
  /** Crossbow charging state (LMB held) and charge time accumulated, s. */
  charging: boolean;
  chargeT: number;
  /** Charge time & level of the most recently released crossbow bolt. */
  lastChargeT: number;
  lastChargeLevel: 0 | 1 | 2 | 3;
}

export interface ShootInput {
  fire: boolean;
  reload: boolean;
  select: WeaponId | null;
  airborne?: boolean;
}

const none = (): Record<WeaponId, number> => ({ fists: 0, pistol: 0, shotgun: 0, rifle: 0, crossbow: 0, rocket: 0, grenade: 0 });

/** Everyone starts with bare fists; guns, grenades and ammo come from the shop. */
export function createWeaponState(): WeaponState {
  return {
    current: 'fists', owned: { fists: true, pistol: false, shotgun: false, rifle: false, crossbow: false, rocket: false, grenade: false },
    ammo: none(), reserve: none(), cooldown: 0, reloadT: 0, reloadTotal: 0, held: false, heat: 0, dry: false, kickCd: 0, kickCdTotal: 0,
    charging: false, chargeT: 0, lastChargeT: 0, lastChargeLevel: 0,
  };
}

/** Give a weapon (shop / bot loadout) with a full magazine; grenades: `count` more. */
export function giveWeapon(ws: WeaponState, w: WeaponId, count = WEAPONS[w].mag) {
  ws.owned[w] = true;
  ws.ammo[w] = Math.min(WEAPONS[w].mag, ws.ammo[w] + count);
  if (w === 'crossbow' && ws.reserve.crossbow < 12) ws.reserve.crossbow = 12;
}

/** Max spare rounds carried per gun. */
export const maxReserve = (w: WeaponId) => w === 'rocket' ? 6 : w === 'crossbow' ? 24 : WEAPONS[w].mag * 3;

/** Refill reserve ammo for all owned guns (or pistol/rifle reserve if none owned yet). Returns true if any ammo was added. */
export function refillAmmo(ws: WeaponState, mags = 1): boolean {
  let added = false;
  const guns: WeaponId[] = ['pistol', 'shotgun', 'rifle', 'crossbow', 'rocket'];
  const anyOwned = guns.some((g) => ws.owned[g]);
  for (const g of guns) {
    if (!ws.owned[g] && (anyOwned || g !== 'pistol')) continue;
    const cap = maxReserve(g);
    const add = Math.max(1, Math.round((g === 'crossbow' ? 6 : WEAPONS[g].mag) * mags));
    const next = Math.min(cap, ws.reserve[g] + add);
    if (next > ws.reserve[g]) {
      ws.reserve[g] = next;
      added = true;
    }
  }
  return added;
}

/** Can this weapon be used right now (owned, something to shoot / throw)? */
export function hasAmmo(ws: WeaponState, w: WeaponId) {
  return ws.owned[w] && (WEAPONS[w].mag === 0 || ws.ammo[w] > 0 || (isGun(w) && ws.reserve[w] > 0));
}

/** Advances timers; returns the weapon that fires / swings this tick (or null). */
export function weaponTick(ws: WeaponState, input: ShootInput, dt: number): WeaponId | null {
  ws.cooldown = Math.max(0, ws.cooldown - dt);
  if (!input.airborne) ws.kickCd = Math.max(0, ws.kickCd - dt);
  ws.dry = false;
  const pressed = input.fire && !ws.held;
  ws.held = input.fire;

  if (input.select && input.select !== ws.current && ws.owned[input.select]) {
    ws.current = input.select;
    ws.reloadT = 0;
    ws.charging = false;
    ws.chargeT = 0;
    ws.cooldown = Math.max(ws.cooldown, 0.25);
  }
  const w = ws.current;
  const def = WEAPONS[w];
  // the gun settles a shot's worth every ~2 intervals without firing
  if (ws.cooldown <= 0) ws.heat = Math.max(0, ws.heat - dt / Math.max(def.interval * 2, 0.15));
  if (ws.reloadT > 0) {
    ws.reloadT -= dt;
    if (ws.reloadT <= 0) {
      ws.reloadT = 0;
      // a tactical reload keeps the round in the chamber: mag + 1
      const cap = def.mag + (ws.reloadTotal === def.reload && ws.ammo[w] > 0 ? 1 : 0);
      const take = Math.min(cap - ws.ammo[w], ws.reserve[w]);
      ws.ammo[w] += take;
      ws.reserve[w] -= take;
    }
    return null;
  }
  if (w === 'crossbow') {
    // Crossbow keeps an infinite or reserve-fed bolt ready; holding LMB charges, releasing fires.
    if (ws.ammo.crossbow <= 0) {
      if (ws.reserve.crossbow > 0) { ws.ammo.crossbow = 1; ws.reserve.crossbow--; }
      else ws.ammo.crossbow = 1; // energy bolts recharge per shot
    }
    if (ws.cooldown > 0) {
      ws.charging = false;
      ws.chargeT = 0;
      return null;
    }
    if (input.fire) {
      ws.charging = true;
      ws.chargeT = Math.min(3.5, ws.chargeT + dt * CROSSBOW_CHARGE_RATE);
      return null;
    }
    if (ws.charging) {
      const spec = crossbowSpec(ws.chargeT);
      ws.lastChargeT = ws.chargeT;
      ws.lastChargeLevel = spec.level;
      ws.charging = false;
      ws.chargeT = 0;
      ws.ammo.crossbow = 0;
      if (ws.reserve.crossbow <= 0) ws.reserve.crossbow = 1;
      ws.reloadTotal = ws.reloadT = spec.reload;
      ws.cooldown = spec.reload;
      ws.heat = Math.min(ws.heat + 1, 30);
      return 'crossbow';
    }
    return null;
  }
  // reload on R, or automatically when trying to fire an empty gun (only if there are spare rounds); a single-shot
  // launcher reloads by itself right after the shot
  const single = def.mag === 1 && ws.ammo[w] === 0 && ws.cooldown <= 0;
  if (isGun(w) && ws.ammo[w] < def.mag && ws.reserve[w] > 0 && (input.reload || (input.fire && ws.ammo[w] === 0) || single)) {
    ws.reloadTotal = ws.reloadT = ws.ammo[w] > 0 ? def.reload : def.reloadEmpty;
    ws.heat = 0;
    return null;
  }
  if (!input.fire || ws.cooldown > 0) return null;
  if (!def.auto && !pressed) return null;
  if (def.mag > 0) {
    if (ws.ammo[w] <= 0) {
      if (pressed && isGun(w)) { ws.dry = true; ws.cooldown = 0.25; }
      return null;
    }
    ws.ammo[w]--;
  }
  ws.cooldown = def.interval;
  ws.heat = Math.min(ws.heat + 1, 30);
  return w;
}

/** Can kick now (V)? */
export const kickReady = (ws: WeaponState) => ws.kickCd <= 0;
/** A kick was made: `hit` = it landed on someone / something (the long cooldown). */
export function kicked(ws: WeaponState, hit: boolean) {
  ws.kickCdTotal = ws.kickCd = hit ? KICK.cdHit : KICK.cdMiss;
}

/** Damage multiplier of a bullet still flying at `speed` (kinetic energy left; 1 for melee / grenades). */
export function energyLeft(def: WeaponDef, speed: number): number {
  if (!def.drag) return 1;
  return Math.max(def.minEnergy, Math.min(1, (speed / def.speed) ** 2));
}

/**
 * Cone half-angle of the next shot: base accuracy + bloom from the shots just fired (`heat` counts the current one)
 * + running. `moving` = planar speed / run speed (0..1+).
 */
export function shotSpread(def: WeaponDef, heat: number, moving: number, airborne = false): number {
  return def.spread + def.bloom * Math.max(0, Math.min(heat, 12) - 1) + def.moveSpread * Math.min(1, moving) + (airborne ? def.moveSpread : 0);
}

/** Bullet resistance of materials: m/s of `power` lost per metre. Map concrete / brick is not shot through. */
export const PENETRATION = { wood: 1600, stone: 9000, metal: 22000 } as const;
