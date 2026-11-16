import { Quaternion, Vector3 } from 'three';
import { BlockSystem } from './blocks';
import { Combat, CRYSTAL, MAX_HP } from './combat';
import type { Currency } from './economy';
import { GameMode, MATCH_RULES } from './lobby';
import { HALL_H, HALL_HALF, MapData } from './map';
import type { PhysicsWorld, Rapier } from './physics';
import { TeamId } from './teams';

/** Crystal generators on the squares of the neutral faces: one unit every `interval` s, up to `cap` waiting to be picked up. */
export const GENERATORS: Record<'crystal', { interval: number; cap: number }> = {
  crystal: { interval: 15, cap: 4 },
};
/** Walk this close (player centre → generator pad) to collect. */
export const PICKUP_RADIUS = 2.4;
/**
 * Team crystal: 250 HP, healed back at 2.5 HP/s once nobody has hit it for 15 s.
 * Only shots from within CRYSTAL.range hurt it.
 */
export const BED_HP = 250;
export const BED_REGEN = { delay: 15, rate: 2.5 };
/** Respawn time for players and bots, s. */
export const RESPAWN_DELAY = 8;
/** Passive healing rate inside a team base hall, HP/s. */
export const BASE_HEAL_RATE = 2;
/** Stage 1 -> Stage 2 transition: 10 s invulnerability, then a 10 m explosion stunning & hurting enemies (100%) and reviving the crystal's dead team members. */
export const CRYSTAL_INVULN_TIME = 10;
export const CRYSTAL_BLAST_RADIUS = 10;
export const CRYSTAL_STUN_TIME = 3.5;
/** The UI points at an enemy crystal you look at from this far (and says to come closer beyond CRYSTAL.range). */
export const BED_SIGHT = 40;
export const SHOP_RADIUS = 4.5;
/** Money for killing an enemy. */
export const KILL_REWARD = 3;
/** Money for killing an enemy in Skirmish mode. */
export const SKIRMISH_KILL_REWARD = 25;
/** Wood regenerated per second while standing inside own base hall in Skirmish mode. */
export const SKIRMISH_WOOD_PER_SEC = 1;

export function killRewardFor(mode?: GameMode): number {
  return mode === 'skirmish' ? SKIRMISH_KILL_REWARD : KILL_REWARD;
}

export function maxCrystalHp(): number {
  return Math.max(10, Math.round(BED_HP * MATCH_RULES.crystalHp));
}

export interface Generator { currency: 'crystal'; pos: Vector3; up: Vector3; stored: number; timer: number }
export interface Bed {
  team: TeamId;
  pos: Vector3;
  up: Vector3;
  alive: boolean;
  hp: number;
  maxHp?: number;
  calm: number;
  /** Two-stage crystal: Stage 1 breaks into a 10 s invulnerable shield, then explodes into Stage 2. */
  stage: 1 | 2;
  /** Seconds of invulnerability remaining before the Stage 1 -> 2 explosion (0 = vulnerable). */
  invulnT: number;
}

export type MatchEvent =
  | { type: 'pickup'; currency: 'crystal'; amount: number }
  | { type: 'bedStage1Broken'; team: TeamId; byPlayer: boolean }
  | { type: 'bedStageBlast'; team: TeamId; pos: Vector3 }
  | { type: 'bedBroken'; team: TeamId; byPlayer: boolean }
  /** A crystal took damage (HP bar, "your crystal is under attack"). */
  | { type: 'bedHit'; team: TeamId; hp: number; byPlayer: boolean }
  | { type: 'win'; time: number }
  | { type: 'lose' };

interface HallVolume {
  team: TeamId | null;
  origin: Vector3;
  invQ: Quaternion;
  center: [number, number];
  half: number;
}

const _loc = new Vector3();

/**
 * Bedwars rules for one player's team: crystal generators, wallet, beds, win / lose. Shop and items: economy.ts.
 * Enemy beds start fortified with blocks.
 */
export class Match {
  readonly mode: GameMode;
  readonly beds: Bed[];
  readonly generators: Generator[] = [];
  readonly wallet: Record<Currency, number> = { cash: 0, crystal: 0 };
  readonly events: MatchEvent[] = [];
  time = 0;
  result: 'win' | 'lose' | null = null;
  private woodRegenT = 0;
  /** Optional ray filter so that character capsules (bots) do not block crystals. */
  characterFilter?: (collider: { handle: number }) => boolean;
  /** Living members of a team other than the local player (bots + remote humans). */
  membersAlive: (team: TeamId) => number = () => 0;
  /** Other living human players on a team (excluding the local player); keeps co-op alive until all humans fall. */
  otherHumansAlive: (team: TeamId) => number = () => 0;
  /** True on non-host P2P clients: host owns generators, bed damage, and match win/loss transitions. */
  remoteClientMode = false;
  /** Callback fired when a crystal finishes its 10 s Stage 1 invulnerability and revives dead players/bots of `crystalTeam`. */
  onReviveAll?: (crystalTeam: TeamId) => void;
  private combat: Combat | null = null;
  private readonly halls: HallVolume[] = [];

  /** Own shop kiosk, if the team has a base. */
  readonly shop: Vector3 | null;
  /** Every shop you can buy at: your own and the neutral ones in the central city. */
  readonly shops: Vector3[];

  constructor(private R: Rapier, private world: PhysicsWorld, map: MapData, readonly blocks: BlockSystem, readonly team: TeamId,
    /** The local player's capsule: ignored by line-of-sight rays that start at the eye. */
    private playerCollider?: ReturnType<PhysicsWorld['createCollider']>,
    /** Teams whose starter crystal forts should be omitted (humans' teams); defaults to `[team]`. */
    fortifySkipTeams?: TeamId[]) {
    this.mode = map.mode ?? 'standard';
    blocks.cubeHalfY = map.cube.halfY ?? map.cube.half;
    const base = map.bases.find((b) => b.team === team);
    this.shop = base ? new Vector3(...base.shop) : null;
    this.shops = map.bases.filter((b) => b.team === team || b.team === '').map((b) => new Vector3(...b.shop));
    const maxHp = maxCrystalHp();
    this.beds = map.statues.map((s) => ({
      team: s.team as TeamId, pos: new Vector3(...s.bed), up: new Vector3(...s.up),
      alive: true, hp: maxHp, maxHp, calm: 0, stage: 1 as const, invulnT: 0,
    }));
    for (const f of map.faces) {
      const nav = map.nav[f.id];
      if (!nav?.hall) continue;
      this.halls.push({
        team: (f.team as TeamId) || null,
        origin: new Vector3(...f.origin),
        invQ: new Quaternion(...f.quat).invert(),
        center: nav.hall.c,
        half: nav.hall.half ?? HALL_HALF,
      });
    }
    blocks.crystals = this.beds;
    for (const c of map.crystalSpots) this.generators.push({ currency: 'crystal', pos: new Vector3(...c.pos), up: new Vector3(...c.up), stored: 0, timer: 0 });
    // fortify beds of teams without human players so nobody spawns trapped inside fort blocks
    const skipFort = new Set<TeamId>(fortifySkipTeams ?? [team]);
    for (const s of map.statues) {
      if (skipFort.has(s.team as TeamId)) continue;
      for (const f of s.fort) {
        const p = new Vector3(...f.pos);
        if (blocks.isFree(p)) blocks.add(p, f.material, s.team as TeamId, false);
      }
    }
    blocks.refresh();
  }

  /** Is `pos` inside any team base hall (or specifically `team`'s hall if passed)? */
  isInsideBaseHall(pos: Vector3, team?: TeamId | string): boolean {
    for (const h of this.halls) {
      if (team && h.team && h.team !== team) continue;
      _loc.copy(pos).sub(h.origin).applyQuaternion(h.invQ);
      if (_loc.y >= -0.5 && _loc.y <= HALL_H + 0.5
        && Math.abs(_loc.x - h.center[0]) <= h.half
        && Math.abs(_loc.z - h.center[1]) <= h.half) {
        return true;
      }
    }
    return false;
  }

  bed(team: TeamId) {
    return this.beds.find((b) => b.team === team)!;
  }

  /** Shots and blows of `combat` hurt the crystals (it tells who hit and how hard; `owner` 0 = the local player). */
  attach(combat: Combat) {
    this.combat = combat;
    combat.crystals = this.beds;
    combat.onCrystal = (c, damage, owner) => this.damageBed(c.team, damage, owner === 0);
  }

  /** A crystal takes `damage` (final HP); Stage 1 breaks into a 10 s invulnerable phase, Stage 2 breaks for good. */
  damageBed(team: TeamId, damage: number, byPlayer = false) {
    const bed = this.bed(team);
    if (!bed || !bed.alive || bed.invulnT > 0 || this.result) return;
    const maxHp = bed.maxHp ?? maxCrystalHp();
    bed.hp = Math.max(0, bed.hp - damage);
    bed.calm = 0;
    this.events.push({ type: 'bedHit', team, hp: bed.hp, byPlayer });
    if (bed.hp <= 0) {
      if (bed.stage === 1) {
        bed.stage = 2;
        bed.invulnT = CRYSTAL_INVULN_TIME;
        bed.hp = maxHp;
        bed.calm = 0;
        this.events.push({ type: 'bedStage1Broken', team, byPlayer });
      } else {
        this.destroyBed(team, byPlayer);
      }
    }
  }

  get ownBedAlive() {
    return this.bed(this.team)?.alive ?? false;
  }

  /** A team is out when its bed is gone and nobody of it is alive. */
  isOut(team: TeamId) {
    if (team === this.team) return this.result === 'lose';
    const b = this.bed(team);
    return (!b || !b.alive) && this.membersAlive(team) === 0;
  }

  /** Enemy teams still in the game. */
  get enemiesLeft() {
    return this.beds.filter((b) => b.team !== this.team && !this.isOut(b.team)).length;
  }

  private checkWin() {
    if (!this.remoteClientMode && !this.result && this.enemiesLeft === 0) {
      this.result = 'win';
      this.events.push({ type: 'win', time: this.time });
    }
  }

  /** Marks local team lost once its crystal is broken and its last human + bot fighter is down. */
  checkCoopEliminated(localAlive: boolean) {
    if (!this.remoteClientMode && !this.result && !localAlive && !this.ownBedAlive && this.membersAlive(this.team) === 0) {
      this.result = 'lose';
      this.events.push({ type: 'lose' });
    }
  }

  /** Generators + pickup + crystal stage transition + base hall healing + Skirmish base wood regen. Runs at the simulation tick. */
  tick(dt: number, playerPos: Vector3, playerAlive = true) {
    if (!this.result) this.time += dt;
    if (this.remoteClientMode) return;
    this.checkWin();
    // Skirmish mode: 1 wood block per second regenerated while standing inside own base hall
    if (this.mode === 'skirmish' && playerAlive && this.isInsideBaseHall(playerPos, this.team)) {
      this.woodRegenT += dt;
      if (this.woodRegenT >= 1) {
        const gain = Math.floor(this.woodRegenT);
        this.woodRegenT -= gain;
        this.blocks.inventory.wood += gain * SKIRMISH_WOOD_PER_SEC;
      }
    } else {
      this.woodRegenT = 0;
    }
    // +2 HP/s to everyone standing inside a base hall
    if (this.combat) {
      for (const tg of this.combat.targets) {
        if (!tg.alive || tg.npc) continue;
        const maxHp = tg.maxHp ?? MAX_HP * MATCH_RULES.playerHp;
        if (tg.hp < maxHp && this.isInsideBaseHall(tg.center)) {
          tg.hp = Math.min(maxHp, tg.hp + BASE_HEAL_RATE * dt);
        }
      }
    }
    for (const b of this.beds) {
      if (!b.alive) continue;
      const maxHp = b.maxHp ?? maxCrystalHp();
      if (b.invulnT > 0) {
        b.invulnT = Math.max(0, b.invulnT - dt);
        if (b.invulnT === 0) {
          this.triggerCrystalBlast(b);
        }
        continue;
      }
      if (b.hp >= maxHp) continue;
      b.calm += dt;
      if (b.calm >= BED_REGEN.delay) b.hp = Math.min(maxHp, b.hp + BED_REGEN.rate * dt);
    }
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
    }
    const n = this.collect(playerPos);
    if (n > 0) {
      const reward = Math.max(1, Math.round(n * MATCH_RULES.reward));
      this.wallet.crystal += reward;
      this.events.push({ type: 'pickup', currency: 'crystal', amount: reward });
    }
  }

  /** Take everything the generators within reach of `pos` hold (the player through `tick`, bots directly). */
  collect(pos: Vector3): number {
    let n = 0;
    for (const g of this.generators) {
      if (g.stored <= 0 || pos.distanceTo(g.pos) >= PICKUP_RADIUS) continue;
      n += g.stored;
      g.stored = 0;
    }
    return n;
  }

  /**
   * The enemy crystal you look at (within BED_SIGHT, not walled off) and how far it is (to its axis: the 5 m rule).
   */
  bedInSight(eye: Vector3, dir: Vector3, team: TeamId = this.team, exclude = this.playerCollider): { bed: Bed; dist: number } | null {
    let best: { bed: Bed; dist: number } | null = null;
    for (const b of this.beds) {
      if (!b.alive || b.team === team) continue;
      const to = b.pos.clone().sub(eye);
      const along = to.dot(dir);
      if (along <= 0 || along > BED_SIGHT) continue;
      // the view passes close to the crystal (its height counts: it is tall)
      const off = to.clone().addScaledVector(dir, -along);
      const offUp = off.dot(b.up);
      if (off.addScaledVector(b.up, -offUp).length() > CRYSTAL.radius + 0.6 || Math.abs(offUp) > CRYSTAL.half + 0.8) continue;
      if (best && along >= best.dist) continue;
      if (!this.lineOfSight(eye, b.pos, exclude)) continue;
      const k = Math.max(-CRYSTAL.half, Math.min(CRYSTAL.half, eye.clone().sub(b.pos).dot(b.up)));
      best = { bed: b, dist: b.pos.clone().addScaledVector(b.up, k).distanceTo(eye) };
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

  destroyBed(team: TeamId, byPlayer = false) {
    const bed = this.bed(team);
    if (!bed || !bed.alive) return;
    bed.alive = false;
    bed.hp = 0;
    bed.invulnT = 0;
    this.events.push({ type: 'bedBroken', team, byPlayer });
    this.checkWin();
  }

  /**
   * Stage 1 invulnerability ended: explode, deal 100% damage + stun to all enemies within 10 m,
   * and revive ONLY dead fighters belonging to `bed.team`.
   */
  private triggerCrystalBlast(bed: Bed) {
    this.events.push({ type: 'bedStageBlast', team: bed.team, pos: bed.pos.clone() });
    if (this.combat) {
      this.combat.events.push({ type: 'explode', pos: bed.pos.clone(), radius: CRYSTAL_BLAST_RADIUS });
      for (const tg of this.combat.targets) {
        if (tg.alive && tg.team !== bed.team && !tg.npc && tg.center.distanceTo(bed.pos) <= CRYSTAL_BLAST_RADIUS) {
          tg.stun = Math.max(tg.stun ?? 0, CRYSTAL_STUN_TIME);
          const lethal = tg.maxHp ?? MAX_HP * MATCH_RULES.playerHp;
          this.combat.damage(tg, lethal, -1, false, bed.pos, { raw: true, from: bed.pos, weapon: 'crystal', cause: 'crystal' });
        } else if (!tg.npc && !tg.alive && tg.team === bed.team) {
          tg.alive = true;
          tg.hp = tg.maxHp ?? MAX_HP * MATCH_RULES.playerHp;
          tg.respawnIn = -1;
        }
      }
    }
    this.onReviveAll?.(bed.team);
  }

  /** Called when the local player dies. False = eliminated (no bed). */
  onDeath(): boolean {
    if (this.ownBedAlive) return true;
    if (this.otherHumansAlive(this.team) === 0 && !this.result) {
      this.result = 'lose';
      this.events.push({ type: 'lose' });
    }
    return false;
  }

  nearShop(pos: Vector3) {
    return this.shops.some((s) => pos.distanceTo(s) < SHOP_RADIUS);
  }
}
