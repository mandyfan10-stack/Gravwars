/** Weapon definitions + per-player weapon state machine (shared by client prediction and server). */
export type WeaponId = 'fists' | 'pistol' | 'rifle' | 'grenade';
export const WEAPON_ORDER: WeaponId[] = ['fists', 'pistol', 'rifle', 'grenade'];

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** Muzzle speed, m/s (0 = melee). */
  speed: number;
  /** Share of the shooter's gravity applied to the projectile. */
  gravityScale: number;
  /** Share of the wind applied to the projectile. */
  windScale: number;
  damage: number;
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
  /** Damage falloff over the travelled distance: full until `from` m, linearly down to `min`× at `to` m. */
  falloff: { from: number; to: number; min: number } | null;
}

const base = { falloff: null, headMul: 1, fuse: 0, radius: 0, bounce: 0, knockback: 0, selfMul: 0, reach: 0, auto: false, reload: 0, inherit: 0 };

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: {
    ...base, id: 'fists', name: 'Кулаки', speed: 0, gravityScale: 0, windScale: 0, damage: 12, headMul: 1.25,
    interval: 0.42, auto: true, mag: 0, life: 0, reach: 2.3,
  },
  pistol: {
    ...base, id: 'pistol', name: 'Пистолет', speed: 140, gravityScale: 0.45, windScale: 0.6, damage: 24, headMul: 1.8,
    interval: 0.2, mag: 12, reload: 1.3, life: 2.2,
    falloff: { from: 8, to: 35, min: 0.4 },
  },
  rifle: {
    ...base, id: 'rifle', name: 'Автомат', speed: 160, gravityScale: 0.4, windScale: 0.6, damage: 20, headMul: 1.6,
    interval: 0.11, auto: true, mag: 30, reload: 1.6, life: 2.5,
    falloff: { from: 10, to: 45, min: 0.35 },
  },
  grenade: {
    ...base, id: 'grenade', name: 'Граната', speed: 22, gravityScale: 1, windScale: 0.6, damage: 75,
    interval: 0.7, mag: 4, life: 6, inherit: 0.6,
    fuse: 2.5, radius: 5.5, bounce: 0.45, knockback: 16, selfMul: 0.35,
  },
};

/** Guns that use a magazine + spare ammo bought in the shop. */
export const isGun = (w: WeaponId) => w === 'pistol' || w === 'rifle';

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
  /** Trigger was held last tick (semi-auto guns fire on the press). */
  held: boolean;
}

export interface ShootInput {
  fire: boolean;
  reload: boolean;
  select: WeaponId | null;
}

const none = (): Record<WeaponId, number> => ({ fists: 0, pistol: 0, rifle: 0, grenade: 0 });

/** Everyone starts with bare fists; guns, grenades and ammo come from the shop. */
export function createWeaponState(): WeaponState {
  return {
    current: 'fists', owned: { fists: true, pistol: false, rifle: false, grenade: false },
    ammo: none(), reserve: none(), cooldown: 0, reloadT: 0, held: false,
  };
}

/** Give a weapon (shop / bot loadout) with a full magazine; grenades: `count` more. */
export function giveWeapon(ws: WeaponState, w: WeaponId, count = WEAPONS[w].mag) {
  ws.owned[w] = true;
  ws.ammo[w] = Math.min(WEAPONS[w].mag, ws.ammo[w] + count);
}

/** Can this weapon be used right now (owned, something to shoot / throw)? */
export function hasAmmo(ws: WeaponState, w: WeaponId) {
  return ws.owned[w] && (WEAPONS[w].mag === 0 || ws.ammo[w] > 0 || (isGun(w) && ws.reserve[w] > 0));
}

/** Advances timers; returns the weapon that fires / swings this tick (or null). */
export function weaponTick(ws: WeaponState, input: ShootInput, dt: number): WeaponId | null {
  ws.cooldown = Math.max(0, ws.cooldown - dt);
  const pressed = input.fire && !ws.held;
  ws.held = input.fire;

  if (input.select && input.select !== ws.current && ws.owned[input.select]) {
    ws.current = input.select;
    ws.reloadT = 0;
    ws.cooldown = Math.max(ws.cooldown, 0.25);
  }
  const w = ws.current;
  const def = WEAPONS[w];
  if (ws.reloadT > 0) {
    ws.reloadT -= dt;
    if (ws.reloadT <= 0) {
      ws.reloadT = 0;
      const take = Math.min(def.mag - ws.ammo[w], ws.reserve[w]);
      ws.ammo[w] += take;
      ws.reserve[w] -= take;
    }
    return null;
  }
  // reload on R, or automatically when trying to fire an empty gun (only if there are spare rounds)
  if (isGun(w) && ws.ammo[w] < def.mag && ws.reserve[w] > 0 && (input.reload || (input.fire && ws.ammo[w] === 0))) {
    ws.reloadT = def.reload;
    return null;
  }
  if (!input.fire || ws.cooldown > 0) return null;
  if (!def.auto && !pressed) return null;
  if (def.mag > 0) {
    if (ws.ammo[w] <= 0) return null;
    ws.ammo[w]--;
  }
  ws.cooldown = def.interval;
  return w;
}

/** Damage multiplier after `dist` metres of flight (1 = full damage). */
export function damageFalloff(def: WeaponDef, dist: number): number {
  const f = def.falloff;
  if (!f || dist <= f.from) return 1;
  if (dist >= f.to) return f.min;
  return 1 - (1 - f.min) * (dist - f.from) / (f.to - f.from);
}
