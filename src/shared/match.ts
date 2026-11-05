import { Vector3 } from 'three';
import { BlockSystem } from './blocks';
import type { Currency } from './economy';
import type { MapData } from './map';
import type { PhysicsWorld, Rapier } from './physics';
import { TeamId } from './teams';

/** Crystal generators on the middle islands: one unit every `interval` s, up to `cap` waiting to be picked up. */
export const GENERATORS: Record<'crystal', { interval: number; cap: number }> = {
  crystal: { interval: 15, cap: 4 },
};
/** Walk this close (player centre → generator pad) to collect. */
export const PICKUP_RADIUS = 2.4;
/** Reach to the enemy crystal (eye → crystal centre) and hold time to break it. */
export const BED_REACH = 4.5;
export const BED_BREAK_TIME = 1.5;
export const SHOP_RADIUS = 4.5;
/** Money for killing an enemy. */
export const KILL_REWARD = 3;

export interface Generator { currency: 'crystal'; pos: Vector3; up: Vector3; stored: number; timer: number }
export interface Bed { team: TeamId; pos: Vector3; up: Vector3; alive: boolean }

export type MatchEvent =
  | { type: 'pickup'; currency: 'crystal'; amount: number }
  | { type: 'bedBroken'; team: TeamId }
  | { type: 'win'; time: number }
  | { type: 'lose' };

/**
 * Bedwars rules for one player's team: crystal generators, wallet, beds, win / lose. Shop and items: economy.ts.
 * Enemy beds start fortified with blocks.
 */
export class Match {
  readonly beds: Bed[];
  readonly generators: Generator[] = [];
  readonly wallet: Record<Currency, number> = { cash: 0, crystal: 0 };
  readonly events: MatchEvent[] = [];
  time = 0;
  result: 'win' | 'lose' | null = null;
  /** Optional ray filter so that character capsules (bots) do not block crystals. */
  characterFilter?: (collider: { handle: number }) => boolean;
  /** Living members of a team other than the local player (bots). Set by the bot manager. */
  membersAlive: (team: TeamId) => number = () => 0;
  /** Bed currently being broken and progress 0..1. */
  breaking: { bed: Bed; progress: number } | null = null;

  /** Own shop kiosk, if the team has a base. */
  readonly shop: Vector3 | null;

  constructor(private R: Rapier, private world: PhysicsWorld, map: MapData, readonly blocks: BlockSystem, readonly team: TeamId,
    /** The local player's capsule: ignored by line-of-sight rays that start at the eye. */
    private playerCollider?: ReturnType<PhysicsWorld['createCollider']>) {
    const base = map.bases.find((b) => b.team === team);
    this.shop = base ? new Vector3(...base.shop) : null;
    this.beds = map.statues.map((s) => ({ team: s.team as TeamId, pos: new Vector3(...s.bed), up: new Vector3(...s.up), alive: true }));
    for (const c of map.crystalSpots) this.generators.push({ currency: 'crystal', pos: new Vector3(...c.pos), up: new Vector3(...c.up), stored: 0, timer: 0 });
    // fortify enemy beds
    for (const s of map.statues) {
      if (s.team === team) continue;
      for (const f of s.fort) {
        const p = new Vector3(...f.pos);
        if (blocks.isFree(p)) blocks.add(p, f.material, s.team as TeamId, false);
      }
    }
    blocks.refresh();
  }

  bed(team: TeamId) {
    return this.beds.find((b) => b.team === team)!;
  }

  get ownBedAlive() {
    return this.bed(this.team).alive;
  }

  /** A team is out when its bed is gone and nobody of it is alive. */
  isOut(team: TeamId) {
    if (team === this.team) return this.result === 'lose';
    return !this.bed(team).alive && this.membersAlive(team) === 0;
  }

  /** Enemy teams still in the game. */
  get enemiesLeft() {
    return this.beds.filter((b) => b.team !== this.team && !this.isOut(b.team)).length;
  }

  private checkWin() {
    if (!this.result && this.enemiesLeft === 0) {
      this.result = 'win';
      this.events.push({ type: 'win', time: this.time });
    }
  }

  /** Generators + pickup. Runs at the simulation tick. */
  tick(dt: number, playerPos: Vector3) {
    if (!this.result) this.time += dt;
    this.checkWin();
    for (const g of this.generators) {
      const def = GENERATORS[g.currency];
      if (g.stored >= def.cap) g.timer = 0;
      else {
        g.timer += dt;
        if (g.timer >= def.interval) {
          g.timer -= def.interval;
          g.stored++;
        }
      }
      if (g.stored > 0 && playerPos.distanceTo(g.pos) < PICKUP_RADIUS) {
        this.wallet[g.currency] += g.stored;
        this.events.push({ type: 'pickup', currency: g.currency, amount: g.stored });
        g.stored = 0;
      }
    }
  }

  /** Nearest enemy bed within reach and not walled off by blocks / map geometry. */
  reachableBed(eye: Vector3, team: TeamId = this.team, exclude = this.playerCollider): Bed | null {
    let best: Bed | null = null;
    let bestD = BED_REACH;
    for (const b of this.beds) {
      if (!b.alive || b.team === team) continue;
      const d = eye.distanceTo(b.pos);
      if (d > bestD || !this.lineOfSight(eye, b.pos, exclude)) continue;
      best = b;
      bestD = d;
    }
    return best;
  }

  lineOfSight(from: Vector3, to: Vector3, exclude = this.playerCollider) {
    return !this.firstHit(from, to, exclude);
  }

  /** What stands between the eye and a crystal (null = clear). The crystal itself has no collider. */
  firstHit(from: Vector3, to: Vector3, exclude = this.playerCollider) {
    const d = to.clone().sub(from);
    const len = d.length();
    // stop short of the crystal centre so the pedestal top does not count
    return this.world.castRay(new this.R.Ray(from, d.divideScalar(len)), Math.max(0, len - 0.9), true, undefined, undefined, exclude,
      undefined, this.characterFilter);
  }

  /** Hold-to-break the enemy crystal. Returns the bed being broken (for the HUD), if any. */
  breakTick(dt: number, eye: Vector3, holding: boolean): Bed | null {
    const bed = holding && !this.result ? this.reachableBed(eye) : null;
    if (!bed) {
      this.breaking = null;
      return null;
    }
    if (this.breaking?.bed !== bed) this.breaking = { bed, progress: 0 };
    this.breaking.progress += dt / BED_BREAK_TIME;
    if (this.breaking.progress >= 1) {
      this.breaking = null;
      this.destroyBed(bed.team);
    }
    return bed;
  }

  destroyBed(team: TeamId) {
    const bed = this.bed(team);
    if (!bed.alive) return;
    bed.alive = false;
    this.events.push({ type: 'bedBroken', team });
    this.checkWin();
  }

  /** Called when the local player dies. False = eliminated (no bed). */
  onDeath(): boolean {
    if (this.ownBedAlive) return true;
    if (!this.result) {
      this.result = 'lose';
      this.events.push({ type: 'lose' });
    }
    return false;
  }

  nearShop(pos: Vector3) {
    return !!this.shop && pos.distanceTo(this.shop) < SHOP_RADIUS;
  }
}
