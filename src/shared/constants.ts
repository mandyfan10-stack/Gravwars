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
  friction: 5,
  stopSpeed: 80 * HU,
  jumpSpeed: 301.993 * HU,
  stepHeight: 18 * HU,
  groundCos: 0.7,
  nonJumpVelocity: 140 * HU,
  autoBhop: true,
  maxVelocity: 3500 * HU,
  noclipSpeed: 14,
};

export const WORLD = {
  /**
   * Distance from the world centre to the ground of each team base island (doubled in v2). Bases sit in a ring in
   * the XY plane, each facing the centre; the centre is a flat city in that plane, top face +Z.
   */
  islandDistance: 432,
  /** Half extent of a base island (5×5 city tiles of 32 m). */
  islandHalf: 80,
  /** Half extent of the central city (7×7 tiles). */
  centerHalf: 112,
  /** Further than this from the centre = fell into the void = death. */
  killRadius: 700,
};
