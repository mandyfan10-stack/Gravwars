/** Simulation tick rate (Source-like 64 tick). Shared by client prediction and the future server. */
export const TICK_RATE = 64;
export const TICK_DT = 1 / TICK_RATE;

/** 1 Source hammer unit (inch) in meters. Movement constants are taken from Source and converted. */
export const HU = 0.0254;

export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.83;
/** Half-length of the capsule's cylindrical segment. */
export const PLAYER_HALF_SEGMENT = PLAYER_HEIGHT / 2 - PLAYER_RADIUS;
/** Eye position relative to capsule center, along the player's up axis. */
export const EYE_OFFSET = 0.71;
/** Crouching lowers the eye by this much, m. */
export const CROUCH_EYE_DROP = 0.5;

export interface MovementConfig {
  gravity: number;
  maxSpeed: number;
  accelerate: number;
  airAccelerate: number;
  /** Source clamps air wish speed to 30 u/s — this is what makes air strafing work. */
  airSpeedCap: number;
  friction: number;
  stopSpeed: number;
  jumpSpeed: number;
  stepHeight: number;
  /** Surfaces with normal·up below this are not ground (Source: 0.7) → you slide / surf. */
  groundCos: number;
  /** If moving up faster than this, you are never grounded (lets you fly off ramps). */
  nonJumpVelocity: number;
  autoBhop: boolean;
  maxVelocity: number;
  noclipSpeed: number;
}

export const DEFAULT_MOVEMENT: MovementConfig = {
  gravity: 800 * HU,
  maxSpeed: 300 * HU,
  accelerate: 10,
  airAccelerate: 12,
  airSpeedCap: 30 * HU,
  // stops in ~0.25 s from a run (Source: 4–6; GravWars is snappier)
  friction: 9,
  stopSpeed: 80 * HU,
  // a tap: ~1.3 m; held: ~3.3 m (JUMP_HOLD in movement.ts)
  jumpSpeed: 286 * HU,
  stepHeight: 18 * HU,
  groundCos: 0.68,
  nonJumpVelocity: 140 * HU,
  autoBhop: true,
  maxVelocity: 3500 * HU,
  noclipSpeed: 14,
};

export const WORLD = {
  /**
   * The world is the inside of a cube: six faces, each a city island that looks at the centre (the sun). Face
   * grounds lie at ±cubeHalf on their axis; a city covers ±faceHalf of its face, the rest up to the cube edge is a
   * 36 m gap (two of them meet at every edge): the way to the next face is a bridge over it and stairs up its wall.
   */
  cubeHalf: 126,
  faceHalf: 90,
  /** Further than this outside the cube (on any axis) = fell into the void. */
  voidMargin: 20,
  /** Projectiles further than this from the centre are dropped. */
  killRadius: 360,
};
