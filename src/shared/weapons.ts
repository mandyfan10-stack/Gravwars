/** Weapon definitions + per-player weapon state machine (shared by client prediction and server). */
export type WeaponId = 'fists' | 'pistol' | 'revolver' | 'shotgun' | 'rifle' | 'crossbow' | 'rocket' | 'grenade';
export const WEAPON_ORDER: WeaponId[] = ['fists', 'pistol', 'revolver', 'shotgun', 'rifle', 'crossbow', 'rocket', 'grenade'];

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
/** Seconds of holding LMB to cock and fire the revolver. */
export const REVOLVER_COCK_TIME = 0.22;
/** Damage of a revolver bullet after ricocheting off a living target into the next target. */
export const REVOLVER_RICOCHET_DAMAGE = 20;
/** Max distance (m) a revolver bullet can chain-ricochet to the next living target. */
export const REVOLVER_RICOCHET_RANGE = 28;

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
  /** `damage` is final, not scaled by DAMAGE_SCALE. */
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
  // heavy revolver: hold LMB to cock & fire; ricochets between living targets (25 dmg -> 20 dmg chain); RMB spins
  revolver: {
    ...base, id: 'revolver', name: 'Револьвер', speed: 180, power: 520, gravityScale: 0.18, windScale: 0.25, damage: 25, raw: true,
    blockDamage: 34, headMul: 1.4, interval: 0.48, auto: true, mag: 6, reload: 1.85, reloadEmpty: 2.15, life: 3,
    drag: 0, minEnergy: 1, spread: 0.0018, bloom: 0.0035, moveSpread: 0.014, recoil: 0.048, recoilYaw: 0.009, airPush: 3.6,
  },
  // pump shotgun: 8 pellets in a fixed cone, shell-by-shell reload, damage 11, +50% owner pushback
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
  // single-shot rocket launcher: 90 player damage, +50% radius (6.75 m)
  rocket: {
    ...base, id: 'rocket', name: 'Ракетница', speed: 36, gravityScale: 0.18, windScale: 0, damage: 90, raw: true, explodeOnHit: true,
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
export const isGun = (w: WeaponId) => w === 'pistol' || w === 'revolver' || w === 'rifle' || w === 'shotgun' || w === 'crossbow' || w === 'rocket';
/** Guns that have the active reload green zone (pistol, shotgun, rifle). */
export const hasActiveReloadZone = (w: WeaponId) => w === 'pistol' || w === 'shotgun' || w === 'rifle';
/** Guns in the order a fighter prefers them when nothing better is said. */
export const GUNS_BEST_FIRST: WeaponId[] = ['rifle', 'crossbow', 'revolver', 'shotgun', 'pistol', 'rocket'];

export type ActiveReloadStatus = 'none' | 'ready' | 'success' | 'fail';

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
  /** Reload key was held last tick (for active reload edge detection). */
  reloadHeld: boolean;
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
  /** Revolver hammer cock timer while holding LMB (0..REVOLVER_COCK_TIME). */
  revolverCockT: number;
  /** Revolver spin animation timer triggered by RMB. */
  revolverSpinT: number;
  /** Active reload zone start (0.60..0.82) and width (0.08..0.12) in normalized progress [0..1]. */
  reloadZoneStart: number;
  reloadZoneWidth: number;
  /** Active reload state for the current/last reload. */
  reloadStatus: ActiveReloadStatus;
  /** Seconds left of 10s lockout after missing an active reload. */
  reloadLockout: number;
  /** HUD flash timer after hitting (green) or missing (red) an active reload. */
  reloadFlashT: number;
  /** True on the tick an active reload succeeded (plays metallic click audible to everyone nearby). */
  activeReloadClick: boolean;
  /** Shotgun shell-by-shell reload timer and pulse flag when a shell is inserted. */
  shotgunShellT: number;
  shotgunShellInserted: boolean;
}

export interface ShootInput {
  fire: boolean;
  reload: boolean;
  select: WeaponId | null;
  airborne?: boolean;
}

const none = (): Record<WeaponId, number> => ({
  fists: 0, pistol: 0, revolver: 0, shotgun: 0, rifle: 0, crossbow: 0, rocket: 0, grenade: 0,
});

/** Everyone starts with bare fists; guns, grenades and ammo come from the shop. */
export function createWeaponState(): WeaponState {
  return {
    current: 'fists',
    owned: { fists: true, pistol: false, revolver: false, shotgun: false, rifle: false, crossbow: false, rocket: false, grenade: false },
    ammo: none(),
    reserve: none(),
    cooldown: 0,
    reloadT: 0,
    reloadTotal: 0,
    held: false,
    reloadHeld: false,
    heat: 0,
    dry: false,
    kickCd: 0,
    kickCdTotal: 0,
    charging: false,
    chargeT: 0,
    lastChargeT: 0,
    lastChargeLevel: 0,
    revolverCockT: 0,
    revolverSpinT: 0,
    reloadZoneStart: 0,
    reloadZoneWidth: 0,
    reloadStatus: 'none',
    reloadLockout: 0,
    reloadFlashT: 0,
    activeReloadClick: false,
    shotgunShellT: 0,
    shotgunShellInserted: false,
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
  const guns: WeaponId[] = ['pistol', 'revolver', 'shotgun', 'rifle', 'crossbow', 'rocket'];
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

/**
 * Automatically reload all owned weapons in inventory on respawn: fills every owned gun's magazine
 * (using reserve rounds if present, or topping up the magazine so every owned gun starts loaded).
 */
export function reloadAllOwnedWeapons(ws: WeaponState) {
  ws.reloadT = 0;
  ws.reloadTotal = 0;
  ws.cooldown = 0;
  ws.charging = false;
  ws.chargeT = 0;
  ws.revolverCockT = 0;
  ws.reloadZoneStart = 0;
  ws.reloadZoneWidth = 0;
  ws.reloadStatus = 'none';
  ws.shotgunShellT = 0;
  const guns: WeaponId[] = ['pistol', 'revolver', 'shotgun', 'rifle', 'crossbow', 'rocket'];
  for (const g of guns) {
    if (!ws.owned[g]) continue;
    const mag = WEAPONS[g].mag;
    const need = Math.max(0, mag - ws.ammo[g]);
    if (need > 0) {
      const fromRes = Math.min(need, ws.reserve[g]);
      ws.reserve[g] -= fromRes;
      ws.ammo[g] = mag;
    }
  }
}

/** Consume `count` rounds of ammo from any owned gun (reserve first, then magazine) as jetpack fuel. */
export function consumeJetpackFuel(ws: WeaponState, count = 1): boolean {
  const guns: WeaponId[] = ['rifle', 'pistol', 'revolver', 'shotgun', 'crossbow', 'rocket'];
  for (const g of guns) {
    if (!ws.owned[g]) continue;
    if (ws.reserve[g] >= count) {
      ws.reserve[g] -= count;
      return true;
    }
  }
  for (const g of guns) {
    if (!ws.owned[g]) continue;
    if (ws.ammo[g] >= count) {
      ws.ammo[g] -= count;
      return true;
    }
  }
  return false;
}

export function totalFuelAmmo(ws: WeaponState): number {
  const guns: WeaponId[] = ['rifle', 'pistol', 'revolver', 'shotgun', 'crossbow', 'rocket'];
  let sum = 0;
  for (const g of guns) {
    if (ws.owned[g]) sum += ws.reserve[g] + ws.ammo[g];
  }
  return sum;
}

/** Can this weapon be used right now (owned, something to shoot / throw)? */
export function hasAmmo(ws: WeaponState, w: WeaponId) {
  return ws.owned[w] && (WEAPONS[w].mag === 0 || ws.ammo[w] > 0 || (isGun(w) && ws.reserve[w] > 0));
}

/** Bell-shaped random in [0, 1] biased toward the middle (average of 3 uniforms). */
function midRandom(): number {
  return (Math.random() + Math.random() + Math.random()) / 3;
}

function finishMagazineReload(ws: WeaponState, w: WeaponId) {
  const def = WEAPONS[w];
  const tacticalBonus = w !== 'shotgun' && ws.reloadTotal === def.reload && ws.ammo[w] > 0 ? 1 : 0;
  const cap = def.mag + tacticalBonus;
  const take = Math.min(cap - ws.ammo[w], ws.reserve[w]);
  ws.ammo[w] += take;
  ws.reserve[w] -= take;
}

function beginReload(ws: WeaponState, w: WeaponId) {
  const def = WEAPONS[w];
  if (w === 'shotgun') {
    const need = Math.min(def.mag - ws.ammo.shotgun, ws.reserve.shotgun);
    const shellDur = 0.45;
    const emptyRack = ws.ammo.shotgun === 0 ? 0.45 : 0;
    ws.reloadTotal = ws.reloadT = Math.max(shellDur, need * shellDur + emptyRack);
    ws.shotgunShellT = shellDur;
  } else {
    ws.reloadTotal = ws.reloadT = ws.ammo[w] > 0 ? def.reload : def.reloadEmpty;
  }
  ws.heat = 0;
  ws.revolverCockT = 0;
  if (hasActiveReloadZone(w) && ws.reloadLockout <= 0) {
    const width = 0.08 + midRandom() * 0.04; // 8%..12%, centered at 10%
    const minStart = 0.60;
    const maxStart = 0.90 - width;
    const start = minStart + midRandom() * Math.max(0.01, maxStart - minStart);
    ws.reloadZoneWidth = width;
    ws.reloadZoneStart = start;
    ws.reloadStatus = 'ready';
  } else {
    ws.reloadZoneStart = 0;
    ws.reloadZoneWidth = 0;
    ws.reloadStatus = 'none';
  }
}

/** Advances timers; returns the weapon that fires / swings this tick (or null). */
export function weaponTick(ws: WeaponState, input: ShootInput, dt: number): WeaponId | null {
  ws.cooldown = Math.max(0, ws.cooldown - dt);
  ws.reloadLockout = Math.max(0, ws.reloadLockout - dt);
  ws.reloadFlashT = Math.max(0, ws.reloadFlashT - dt);
  ws.revolverSpinT = Math.max(0, ws.revolverSpinT - dt);
  ws.activeReloadClick = false;
  ws.shotgunShellInserted = false;
  if (!input.airborne) ws.kickCd = Math.max(0, ws.kickCd - dt);
  ws.dry = false;
  const pressed = input.fire && !ws.held;
  ws.held = input.fire;
  const reloadPressed = input.reload && !ws.reloadHeld;
  ws.reloadHeld = input.reload;

  if (input.select && input.select !== ws.current && ws.owned[input.select]) {
    ws.current = input.select;
    ws.reloadT = 0;
    ws.reloadTotal = 0;
    ws.reloadZoneWidth = 0;
    ws.reloadStatus = 'none';
    ws.charging = false;
    ws.chargeT = 0;
    ws.revolverCockT = 0;
    ws.cooldown = Math.max(ws.cooldown, 0.25);
  }
  const w = ws.current;
  const def = WEAPONS[w];
  // the gun settles a shot's worth every ~2 intervals without firing
  if (ws.cooldown <= 0) ws.heat = Math.max(0, ws.heat - dt / Math.max(def.interval * 2, 0.15));

  if (ws.reloadT > 0) {
    // Shotgun can interrupt shell-by-shell reload to fire if at least 1 shell is in the tube
    if (w === 'shotgun' && input.fire && ws.ammo.shotgun > 0) {
      ws.reloadT = 0;
      ws.reloadTotal = 0;
      ws.reloadZoneWidth = 0;
      ws.reloadStatus = 'none';
    } else {
      // Check active reload press (R pressed again after reload started)
      const elapsed = ws.reloadTotal - ws.reloadT;
      if (reloadPressed && elapsed > 0.08 && ws.reloadStatus === 'ready' && ws.reloadZoneWidth > 0) {
        const progress = Math.max(0, Math.min(1, 1 - ws.reloadT / Math.max(1e-4, ws.reloadTotal)));
        if (progress >= ws.reloadZoneStart && progress <= ws.reloadZoneStart + ws.reloadZoneWidth) {
          finishMagazineReload(ws, w);
          ws.reloadT = 0;
          ws.reloadStatus = 'success';
          ws.reloadFlashT = 0.55;
          ws.activeReloadClick = true;
          ws.reloadZoneWidth = 0;
          return null;
        } else {
          // Missed the green zone: flash red, slow remaining reload by 50%, lock out active reload for 10s
          ws.reloadStatus = 'fail';
          ws.reloadFlashT = 0.8;
          ws.reloadLockout = 10;
          ws.reloadZoneWidth = 0;
          const elapsedBefore = ws.reloadTotal - ws.reloadT;
          ws.reloadT *= 1.5;
          ws.reloadTotal = elapsedBefore + ws.reloadT;
        }
      }

      // Shotgun shell-by-shell loading
      if (w === 'shotgun' && ws.ammo.shotgun < def.mag && ws.reserve.shotgun > 0) {
        const rateMul = ws.reloadStatus === 'fail' ? (1 / 1.5) : 1;
        ws.shotgunShellT -= dt * rateMul;
        if (ws.shotgunShellT <= 0) {
          ws.shotgunShellT += 0.45;
          ws.ammo.shotgun++;
          ws.reserve.shotgun--;
          ws.shotgunShellInserted = true;
          if (ws.ammo.shotgun >= def.mag || ws.reserve.shotgun <= 0) {
            ws.reloadT = Math.min(ws.reloadT, 0.25);
          }
        }
      }

      ws.reloadT -= dt;
      if (ws.reloadT <= 0) {
        ws.reloadT = 0;
        finishMagazineReload(ws, w);
        ws.reloadZoneWidth = 0;
        if (ws.reloadStatus === 'ready') ws.reloadStatus = 'none';
      }
      return null;
    }
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
  if (isGun(w) && ws.ammo[w] < def.mag && ws.reserve[w] > 0 && (reloadPressed || (input.fire && ws.ammo[w] === 0) || single)) {
    beginReload(ws, w);
    return null;
  }

  if (w === 'revolver') {
    if (!input.fire || ws.cooldown > 0) {
      ws.revolverCockT = Math.max(0, ws.revolverCockT - dt * 3);
      return null;
    }
    if (ws.ammo.revolver <= 0) {
      if (pressed) { ws.dry = true; ws.cooldown = 0.25; }
      ws.revolverCockT = 0;
      return null;
    }
    ws.revolverCockT += dt;
    if (ws.revolverCockT < REVOLVER_COCK_TIME) return null;
    ws.revolverCockT = 0;
    ws.ammo.revolver--;
    ws.cooldown = def.interval;
    ws.heat = Math.min(ws.heat + 1, 30);
    return 'revolver';
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

/** Progress of the current reload in [0..1] (0 when not reloading). */
export function reloadProgressOf(ws: WeaponState): number {
  if (ws.reloadT <= 0 || ws.reloadTotal <= 0) return 0;
  return Math.max(0, Math.min(1, 1 - ws.reloadT / ws.reloadTotal));
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
