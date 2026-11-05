/** Weapon definitions + per-player weapon state machine (shared by client prediction and server). */
export type WeaponId = 'rifle' | 'grenade';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** Muzzle speed, m/s. */
  speed: number;
  /** Share of the shooter's gravity applied to the projectile. */
  gravityScale: number;
  /** Share of the wind applied to the projectile. */
  windScale: number;
  damage: number;
  /** Seconds between shots. */
  interval: number;
  /** Magazine size (rifle) / max carried (grenade). */
  mag: number;
  reload: number;
  /** Max flight time, s. */
  life: number;
  /** Share of the shooter's velocity added to the projectile. */
  inherit: number;
  headMul: number;
  // grenade only
  fuse: number;
  radius: number;
  bounce: number;
  knockback: number;
  selfMul: number;
  /** Seconds to get one grenade back. */
  regen: number;
  /** Damage falloff over the travelled distance: full until `from` m, linearly down to `min`× at `to` m. */
  falloff: { from: number; to: number; min: number } | null;
}

const base = { falloff: null, headMul: 1, fuse: 0, radius: 0, bounce: 0, knockback: 0, selfMul: 0, regen: 0 };

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  rifle: {
    ...base, id: 'rifle', name: 'Винтовка', speed: 160, gravityScale: 0.4, windScale: 0.6, damage: 20, headMul: 1.6,
    interval: 0.11, mag: 30, reload: 1.6, life: 2.5, inherit: 0,
    falloff: { from: 10, to: 45, min: 0.35 },
  },
  grenade: {
    ...base, id: 'grenade', name: 'Граната', speed: 22, gravityScale: 1, windScale: 0.6, damage: 75,
    interval: 0.7, mag: 3, reload: 0, life: 6, inherit: 0.6,
    fuse: 2.5, radius: 5.5, bounce: 0.45, knockback: 16, selfMul: 0.35, regen: 6,
  },
};

export interface WeaponState {
  current: WeaponId;
  ammo: Record<WeaponId, number>;
  cooldown: number;
  /** > 0 while reloading the rifle. */
  reloadT: number;
  regenT: number;
}

export interface ShootInput {
  fire: boolean;
  reload: boolean;
  select: WeaponId | null;
}

export function createWeaponState(): WeaponState {
  return { current: 'rifle', ammo: { rifle: WEAPONS.rifle.mag, grenade: WEAPONS.grenade.mag }, cooldown: 0, reloadT: 0, regenT: 0 };
}

/** Advances timers; returns the weapon that fires this tick (or null). */
export function weaponTick(ws: WeaponState, input: ShootInput, dt: number): WeaponId | null {
  ws.cooldown = Math.max(0, ws.cooldown - dt);
  if (ws.ammo.grenade < WEAPONS.grenade.mag) {
    ws.regenT += dt;
    if (ws.regenT >= WEAPONS.grenade.regen) {
      ws.regenT = 0;
      ws.ammo.grenade++;
    }
  } else ws.regenT = 0;

  if (input.select && input.select !== ws.current) {
    ws.current = input.select;
    ws.reloadT = 0;
    ws.cooldown = Math.max(ws.cooldown, 0.25);
  }
  if (ws.reloadT > 0) {
    ws.reloadT -= dt;
    if (ws.reloadT <= 0) {
      ws.reloadT = 0;
      ws.ammo.rifle = WEAPONS.rifle.mag;
    }
    return null;
  }
  const def = WEAPONS[ws.current];
  if (ws.current === 'rifle' && (input.reload || ws.ammo.rifle === 0) && ws.ammo.rifle < def.mag && (input.reload || input.fire)) {
    ws.reloadT = def.reload;
    return null;
  }
  if (!input.fire || ws.cooldown > 0 || ws.ammo[ws.current] <= 0) return null;
  ws.ammo[ws.current]--;
  ws.cooldown = def.interval;
  return ws.current;
}

/** Damage multiplier after `dist` metres of flight (1 = full damage). */
export function damageFalloff(def: WeaponDef, dist: number): number {
  const f = def.falloff;
  if (!f || dist <= f.from) return 1;
  if (dist >= f.to) return f.min;
  return 1 - (1 - f.min) * (dist - f.from) / (f.to - f.from);
}
