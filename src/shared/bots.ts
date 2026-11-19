import { Quaternion, Vector3 } from 'three';
import { BlockMaterial, BlockSystem, PiecePlan } from './blocks';
import { BotCombat } from './bots/combat';
import { BotNav } from './bots/nav';
import { BotTasks } from './bots/tasks';
import {
  Alarm, BOT, Bot, BotCtx, BotRole, BotRoster, Difficulty, FaceInfo, FortCell, GenSpot, Loc, PondSpot, ShopSpot, TeamIntel, tuning,
} from './bots/types';
import { Combat, MAX_HP, NOISE, Target } from './combat';
import { EYE_OFFSET } from './constants';
import { Economy, Pickups } from './economy';
import { MATCH_RULES } from './lobby';
import { MapData } from './map';
import { killRewardFor, Match, scaleReward } from './match';
import { Rng, upOf } from './math';
import type { PhysicsWorld, Rapier } from './physics';
import { JETPACK, PlayerSim } from './sim';
import { TeamId } from './teams';
import {
  consumeJetpackFuel, crossbowSpec, createWeaponState, kicked, kickReady, reloadAllOwnedWeapons, WeaponId, WEAPONS, weaponTick,
} from './weapons';

export * from './bots/types';

/**
 * Bots: same movement / physics / weapons / shop rules as the player. Every bot always has a task: earn money
 * (pick up apples / bottles / dropped cash, fish, hunt bandits, crystals from the neutral generators), shop, patch
 * its crystal's fort, defend the base when it is attacked, gather a squad and raid an enemy crystal (paying for the
 * bridges with its own wood). Navigation follows the map: hall → door → roads to a bridge lane at the rim → along
 * the lane (laying its missing pieces) to the corner, up the next face's wall, off the landing onto that face →
 * (the opposite face: through a neighbour) → door → crystal. A cheap local planner (line-of-sight detours) gets
 * around obstacles on each surface.
 */
export class BotManager {
  readonly bots: Bot[] = [];
  private readonly rng = new Rng(4242);
  private readonly faces: FaceInfo[];
  /** Lane pieces as build plans (bots lay the missing ones as they walk a lane). */
  private readonly lanePlans = new Map<string, PiecePlan[]>();
  /** Teams with a face (the others do not play). */
  private readonly teams: TeamId[];
  private readonly byId = new Map<number, Bot>();
  /** Where to stand at every shop counter, by the ponds, at the generators; the forts around the crystals. */
  private readonly shops: ShopSpot[] = [];
  private readonly ponds: PondSpot[] = [];
  private readonly gens: GenSpot[] = [];
  private readonly forts = new Map<TeamId, FortCell[]>();
  private readonly alarms = new Map<TeamId, Alarm>();
  /** Shared team target intelligence: teammates broadcast spotted or attacking enemies. */
  readonly teamIntel = new Map<TeamId, TeamIntel>();
  private readonly keys = { version: -1, set: new Set<string>() };
  private readonly gaps = new Map<TeamId, { t: number; cells: FortCell[] }>();
  private readonly ctx: BotCtx;
  private readonly nav: BotNav;
  private readonly tasks: BotTasks;
  private readonly botCombat: BotCombat;
  /** Called on the authoritative host when a bot fires a weapon/grenade or lands a kick. */
  onShot?: (botId: number, weapon: WeaponId, origin: Vector3, dir: Vector3, chargeT: number) => void;
  onKick?: (botId: number, eye: Vector3, dir: Vector3) => void;

  constructor(R: Rapier, world: PhysicsWorld, map: MapData, combat: Combat,
    private match: Match, blocks: BlockSystem, readonly playerTeam: TeamId, perTeam = BOT.perTeam, roster?: BotRoster) {
    this.teams = map.teams as TeamId[];
    this.faces = map.faces.map((f) => {
      const q = new Quaternion(...f.quat);
      return { id: f.id, team: f.team, up: new Vector3(...f.up), q, inv: q.clone().invert(), origin: new Vector3(...f.origin), half: f.half, nav: map.nav[f.id] };
    });
    for (const l of map.lanes) this.lanePlans.set(l.id, l.pieces.map((p) => ({
      kind: p.kind, center: new Vector3(...p.center), half: new Vector3(...p.half), quat: new Quaternion(...p.quat), key: p.key, level: p.level,
    })));
    this.ctx = {
      R, world, map, combat, match, blocks, playerTeam, rng: this.rng,
      faces: this.faces, lanePlans: this.lanePlans, teams: this.teams, bots: this.bots, byId: this.byId,
      shops: this.shops, ponds: this.ponds, gens: this.gens, forts: this.forts, alarms: this.alarms,
      teamIntel: this.teamIntel, keys: this.keys, gaps: this.gaps, loot: null,
      placeAtSpawn: (b) => this.placeAtSpawn(b),
      reportTarget: (team, target, by) => this.reportTarget(team, target, by),
    };
    this.nav = new BotNav(this.ctx);
    this.tasks = new BotTasks(this.ctx, this.nav);
    this.botCombat = new BotCombat(this.ctx, this.nav, this.tasks);

    match.membersAlive = (team) => this.bots.filter((b) => b.team === team && !b.out).length;
    match.characterFilter = combat.notCharacter;
    const prevRevive = match.onReviveAll;
    match.onReviveAll = (crystalTeam) => {
      prevRevive?.(crystalTeam);
      this.reviveAll(crystalTeam);
    };
    match.attach(combat);
    this.tasks.survey();
    // a bot that kills a fighter of another team earns the same reward as the player
    const prevKill = combat.onKill;
    combat.onKill = (victim, owner) => {
      prevKill(victim, owner);
      const b = this.byId.get(owner);
      if (b && !victim.npc && victim.team !== b.team) {
        const reward = scaleReward(killRewardFor(map.mode));
        b.wallet.cash += reward;
        b.earned += reward;
      }
    };
    let id = 100;
    let wave = 0;
    for (const tid of this.teams) {
      // no roster: the old setup, `perTeam` bots with the shared tuning in every team but the player's
      const levels: (Difficulty | null)[] = roster ? roster[tid] ?? [] : tid === playerTeam ? [] : Array(perTeam).fill(null);
      for (let slot = 0; slot < levels.length; slot++) {
        const level = levels[slot];
        const tune = level ? tuning(level) : BOT;
        // the first bot of every team (allies too) stays home, the rest go on the attack
        const role: BotRole = slot === 0 ? 'defend' : 'attack';
        const sim = new PlayerSim(R, world, map, tid);
        sim.spawnSlot = slot + 1;
        sim.gravity.blocks = () => blocks.blocks.values();
        blocks.characters.push(sim.mover.collider); // building must not trap it (nor measure the ground on it)
        combat.addCharacter(sim.mover.collider);
        const maxHp = Math.max(10, Math.round(MAX_HP * MATCH_RULES.playerHp));
        const target: Target = {
          id: id++, team: tid, center: sim.state.pos, up: upOf(sim.state.frame), vel: sim.state.vel, hp: maxHp, maxHp, alive: true, respawnIn: -1, regen: true,
          airborne: () => !sim.state.onGround,
          onImpulse: (v) => sim.applyImpulse(v),
        };
        combat.targets.push(target);
        const weapons = createWeaponState();
        const wallet = { cash: 0, crystal: 0 };
        const kit: Record<BlockMaterial, number> = { wood: 0, stone: 0, metal: 0 };
        const eco = new Economy(wallet, { inventory: kit }, weapons);
        eco.freeWeapons = map.mode === 'skirmish';
        eco.onArmorChange = (has) => { target.armor = has; };
        target.onArmorBreak = () => { eco.breakArmor(); };
        const bot: Bot = {
          id: target.id, team: tid, role, slot, tune, sim, target, weapons, wallet, kit, eco,
          likes: { shotgun: this.rng.chance(0.35), revolver: this.rng.chance(0.45), fish: role === 'defend' || this.rng.chance(0.65), crystals: this.rng.chance(0.55) },
          task: { kind: 'patrol' }, taskT: 0, planT: this.rng.range(0, 0.5), done: true, joined: false, rash: false, impulse: false, answered: 0,
          goal: null, trip: slot, departAt: role === 'attack' ? tune.firstAttack + tune.attackStagger * wave++ : Infinity,
          respawnT: 0, out: false, enemy: null, seenT: 0, scanT: this.rng.range(0, 0.15), calmT: 0, shots: 0, shotsTotal: 0, kicksTotal: 0, pauseT: 0,
          route: null, routeKey: '', routePts: [], strictAt: undefined, wp: 0, detour: null, checkT: 0, progressT: 0, bestDist: Infinity, stuckT: 0,
          jumpT: 0, breach: null, breachT: 0, wedgeT: 0, frozenT: 0, anchor: new Vector3(), nudgeT: 0, nudge: new Vector3(), buildT: 0, blocked: false, strandT: 0, strands: 0, stand: slot, standT: 0, patrol: slot, patrolT: 0,
          rocketFort: false, farT: 0, hesitateT: 0, mistakeT: this.rng.range(8, 20), fishT: 0, fishAt: 0, caught: 0, fishing: false, genWait: 0, eatT: 0, lootT: 0,
          nadeT: 0, rocketT: 0, woodRegenT: 0, pick: null, pickT: 0, hurtBy: -1, hurtT: -99, searchPos: null, searchT: 0, avoid: new Map(), laneFailures: new Map(), tryActiveReload: false,
          earned: 0, spent: 0, built: 0, builtAt: -99, taken: 0, bought: [],
          prevPos: new Vector3(), status: '',
        };
        target.onHit = (owner) => {
          bot.hurtBy = owner;
          bot.hurtT = this.match.time;
          const att = combat.target(owner);
          if (att && att.alive && att.team !== tid && !att.npc) {
            this.reportTarget(tid, att, bot.id);
          }
        };
        this.placeAtSpawn(bot);
        this.bots.push(bot);
        this.byId.set(bot.id, bot);
      }
    }
  }

  /** Pickups on the map (apples, bottles, dropped money): bots collect and sell them. Set by the game. */
  get pickups() {
    return this.ctx.loot;
  }
  set pickups(p: Pickups | null) {
    this.ctx.loot = p;
    if (p) p.passThrough ??= this.ctx.combat.notCharacter;
  }

  /** Re-plan the attack waves from the current BOT tuning (difficulty changed before the match started). */
  retime() {
    let wave = 0;
    for (const b of this.bots) if (b.role === 'attack') b.departAt = b.tune.firstAttack + b.tune.attackStagger * wave++;
  }

  /** Broadcast a spotted or attacking enemy target to all teammates of `team`. */
  reportTarget(team: TeamId, target: Target, by = 0) {
    if (!target.alive || target.team === team || target.npc) return;
    const f = this.nav.faceOfUp(target.up);
    this.teamIntel.set(team, {
      target,
      pos: target.center.clone(),
      face: f ? f.id : null,
      time: this.match.time,
      by,
    });
  }

  /** Resurrect dead or eliminated bots of `crystalTeam` immediately (triggered by Crystal Stage 1 blast). */
  reviveAll(crystalTeam?: TeamId) {
    for (const bot of this.bots) {
      if (crystalTeam && bot.team !== crystalTeam) continue;
      if (!bot.target.alive || bot.out) {
        bot.out = false;
        bot.respawnT = 0;
        this.placeAtSpawn(bot);
      }
    }
  }

  /** Where the bot is (see Loc). */
  locate(sim: PlayerSim): Loc {
    return this.nav.locate(sim);
  }

  /** (Re)spawn: gear, money and tools stay with the bot (the pockets were spilled where it died). */
  private placeAtSpawn(bot: Bot) {
    const sim = bot.sim;
    if (bot.route?.lane) {
      bot.laneFailures.set(bot.route.lane.id, (bot.laneFailures.get(bot.route.lane.id) ?? 0) + 1);
    }
    sim.respawn('spawn');
    sim.events.length = 0;
    sim.mover.place(sim.state);
    bot.prevPos.copy(sim.state.pos);
    const maxHp = Math.max(10, Math.round(MAX_HP * MATCH_RULES.playerHp));
    bot.target.maxHp = maxHp;
    bot.target.hp = maxHp;
    bot.target.alive = true;
    bot.target.armor = bot.eco.has('armor');
    this.ctx.combat.guard(bot.target);
    reloadAllOwnedWeapons(bot.weapons);
    bot.routeKey = '';
    bot.route = null;
    bot.enemy = null;
    bot.trip++;
    // Dynamic role switching: occasionally swap role after a death to adapt to match flow
    if (this.match.time > 90 && this.rng.chance(0.22)) {
      bot.role = bot.role === 'defend' ? 'attack' : 'defend';
    }
    bot.task = { kind: 'patrol' };
    bot.done = true;
    bot.joined = false;
    bot.rash = false;
    bot.rocketFort = false;
    bot.farT = 0;
    bot.strands = 0;
    bot.blocked = false;
    bot.pick = null;
    bot.breach = null;
    bot.stuckT = 0;
    bot.frozenT = 0;
    bot.nudgeT = 0;
  }

  /** Dead bots wait far away so their capsule does not block anybody. */
  private park(bot: Bot) {
    bot.sim.state.pos.set(0, 5000 + bot.id * 5, 0);
    bot.sim.state.vel.set(0, 0, 0);
    bot.sim.mover.place(bot.sim.state);
    bot.prevPos.copy(bot.sim.state.pos);
  }

  /** Death: the items and half of the cash fall out where the body is (`drop` false: lost in the void). */
  private spill(bot: Bot, drop: boolean) {
    const piles = bot.eco.spill();
    if (!drop || !this.ctx.loot) return;
    for (const p of piles) this.ctx.loot.drop(p.kind, bot.sim.state.pos, bot.target.up, p.amount);
  }

  /** One simulation tick for every bot. */
  tick(dt: number) {
    const { combat } = this.ctx;
    this.tasks.watch(dt);
    for (const bot of this.bots) {
      if (bot.out) continue;
      if (!bot.target.alive) {
        if (bot.respawnT <= 0) {
          bot.respawnT = bot.tune.respawnDelay;
          this.spill(bot, true);
          this.park(bot);
        }
        bot.respawnT -= dt;
        bot.status = 'мёртв';
        if (bot.respawnT <= 0) {
          if (this.match.bed(bot.team).alive) {
            this.placeAtSpawn(bot);
            if (bot.role === 'attack') bot.departAt = this.match.time + bot.tune.reattack;
          } else {
            bot.out = true;
            bot.status = 'выбыл';
          }
        }
        continue;
      }
      bot.prevPos.copy(bot.sim.state.pos);
      this.tasks.upkeep(bot, dt);
      const th = this.botCombat.think(bot, dt);
      bot.sim.tick(th.input, dt);
      for (const e of bot.sim.events.splice(0)) {
        if (e.type === 'land') combat.fall(bot.target, e.speed);
        if (e.type === 'jetpackFuel') consumeJetpackFuel(bot.weapons, 1);
        if (e.type === 'jetpackExplode') {
          const maxHp = bot.target.maxHp ?? Math.round(MAX_HP * MATCH_RULES.playerHp);
          combat.triggerExplosion(
            e.pos, bot.id, bot.team, JETPACK.explodeRadius, JETPACK.explodeDamageOther,
            14, 90, (maxHp * JETPACK.explodeSelfFrac) / JETPACK.explodeDamageOther, true, 'jetpack', e.pos,
          );
        }
        if (e.type === 'respawn' && e.reason === 'void') {
          this.spill(bot, false); // the void keeps what it carried
          bot.prevPos.copy(bot.sim.state.pos);
          if (this.match.bed(bot.team).alive) this.placeAtSpawn(bot);
          else {
            bot.target.alive = false;
            bot.respawnT = 0.01;
          }
        }
      }
      upOf(bot.sim.state.frame, bot.target.up);
      // an enemy right in its face: a kick shoves it away (and off a bridge, with luck)
      if (th.kick && kickReady(bot.weapons)) {
        const eye = bot.sim.state.pos.clone().addScaledVector(bot.target.up, EYE_OFFSET);
        kicked(bot.weapons, combat.kick(bot.id, eye, th.kick, bot.target.up) > 0);
        bot.kicksTotal++;
        this.onKick?.(bot.id, eye, th.kick);
      }
      const wasReloading = bot.weapons.reloadT > 0;
      // semi-automatic guns fire on the press: release the trigger every other tick; crossbow charges to level 1+ then releases
      const isXbow = bot.weapons.current === 'crossbow';
      const pull = isXbow
        ? (th.fire && bot.weapons.chargeT < 1.05)
        : bot.weapons.current === 'revolver'
        ? th.fire
        : (th.fire && (WEAPONS[bot.weapons.current].auto || !bot.weapons.held));
      const fired = weaponTick(bot.weapons, { fire: pull, reload: th.reload && !th.fire, select: th.select }, dt);
      if (!wasReloading && bot.weapons.reloadT > 0) {
        // Rarely attempt active reload (~22% chance on normal, higher on hard)
        bot.tryActiveReload = this.rng.chance(Math.max(0.1, 0.32 - bot.tune.mistakes));
      }
      if (bot.weapons.activeReloadClick) {
        combat.noises.push({ pos: bot.sim.state.pos.clone(), radius: NOISE.click, owner: bot.id });
      }
      if (fired && th.aim) {
        const eye = bot.sim.state.pos.clone().addScaledVector(bot.target.up, EYE_OFFSET);
        if (fired === 'crossbow') {
          const spec = crossbowSpec(bot.weapons.lastChargeT);
          const xbowRecoil = 2.0 + spec.level * 2.8;
          bot.sim.applyImpulse(th.aim.clone().normalize().multiplyScalar(-xbowRecoil));
        } else if (!bot.sim.state.onGround && WEAPONS[fired].airPush) {
          bot.sim.applyImpulse(th.aim.clone().normalize().multiplyScalar(-WEAPONS[fired].airPush));
        }
        combat.use(fired, bot.id, eye, th.aim, bot.sim.state.vel, bot.target.up.clone().negate(), bot.weapons.lastChargeT, bot.team);
        this.onShot?.(bot.id, fired, eye, th.aim, bot.weapons.lastChargeT);
        bot.shotsTotal++;
        if (fired === 'grenade') { bot.pick = null; bot.nadeT = 14; }
        if (++bot.shots >= bot.tune.burst) {
          bot.shots = 0;
          bot.pauseT = bot.tune.burstPause;
        }
      }
    }
  }
}
