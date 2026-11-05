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
}

const base = { reloadEmpty: 0, drag: 0, minEnergy: 1, spread: 0, bloom: 0, moveSpread: 0, recoil: 0, recoilYaw: 0, headMul: 1, fuse: 0, radius: 0, bounce: 0, knockback: 0, selfMul: 0, reach: 0, auto: false, reload: 0, inherit: 0 };

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: {
    ...base, id: 'fists', name: 'Кулаки', speed: 0, gravityScale: 0, windScale: 0, damage: 12, headMul: 1.25,
    interval: 0.42, auto: true, mag: 0, life: 0, reach: 2.3,
  },
  // 9×19 mm self-loading pistol: subsonic-ish, slows down fast, stopped by a wooden wall
  pistol: {
    ...base, id: 'pistol', name: 'Пистолет', speed: 360, gravityScale: 1, windScale: 1, damage: 26, headMul: 2,
    interval: 0.12, mag: 15, reload: 1.5, reloadEmpty: 1.9, life: 2.5, drag: 0.0019, minEnergy: 0.3,
    spread: 0.004, bloom: 0.006, moveSpread: 0.02, recoil: 0.03, recoilYaw: 0.008,
  },
  // 5.45×39 mm assault rifle, 650 rounds per minute: flat and fast, goes through a wooden wall
  rifle: {
    ...base, id: 'rifle', name: 'Автомат', speed: 880, gravityScale: 1, windScale: 1, damage: 28, headMul: 2,
    interval: 0.092, auto: true, mag: 30, reload: 2.1, reloadEmpty: 2.6, life: 2.5, drag: 0.0008, minEnergy: 0.3,
    spread: 0.0025, bloom: 0.0045, moveSpread: 0.035, recoil: 0.013, recoilYaw: 0.006,
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
  /** Length of the reload in progress (tactical or empty), s. */
  reloadTotal: number;
  /** Trigger was held last tick (semi-auto guns fire on the press). */
  held: boolean;
  /** Sustained fire: shots in a row, cools down between them (spread bloom, recoil pattern). */
  heat: number;
  /** Tried to fire an empty gun with nothing to reload: dry click (for the sound). */
  dry: boolean;
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
    ammo: none(), reserve: none(), cooldown: 0, reloadT: 0, reloadTotal: 0, held: false, heat: 0, dry: false,
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
  ws.dry = false;
  const pressed = input.fire && !ws.held;
  ws.held = input.fire;

  if (input.select && input.select !== ws.current && ws.owned[input.select]) {
    ws.current = input.select;
    ws.reloadT = 0;
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
  // reload on R, or automatically when trying to fire an empty gun (only if there are spare rounds)
  if (isGun(w) && ws.ammo[w] < def.mag && ws.reserve[w] > 0 && (input.reload || (input.fire && ws.ammo[w] === 0))) {
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

/** Bullet resistance of materials: m/s of speed lost per metre. Map concrete / brick is not shot through. */
export const PENETRATION = { wood: 1600, stone: 9000, metal: 22000 } as const;
