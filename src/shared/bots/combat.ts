import { Vector3 } from 'three';
import { Target } from '../combat';
import { DEFAULT_MOVEMENT, EYE_OFFSET } from '../constants';
import { upOf } from '../math';
import { emptyInput, moveBasis } from '../movement';
import { crossbowSpec, hasAmmo, isGun, KICK, refillAmmo, reloadProgressOf, WeaponId, WEAPONS } from '../weapons';
import type { BotNav } from './nav';
import type { BotTasks } from './tasks';
import { BED_AIM, Bot, BotCtx, Ground, isArmed, lob, Loc, TASK_LABEL, Thought } from './types';

const _v = new Vector3();
const _l = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();

/** Bot enemy perception, weapon selection, raid crystal/breach targeting, and per-tick steering decisions. */
export class BotCombat {
  constructor(private ctx: BotCtx, private nav: BotNav, private tasks: BotTasks) {}

  findEnemy(bot: Bot, eye: Vector3, raiding: boolean): Target | null {
    const { map, combat, match } = this.ctx;
    let best: Target | null = null;
    const baseRange = map.mode === 'skirmish' ? Math.max(bot.tune.sightRange, 62) : bot.tune.sightRange;
    let bestD = baseRange;
    const up = bot.target.up;
    const prey = bot.task.kind === 'hunt' ? bot.task.target : null;
    for (const t of combat.targets) {
      if (!t.alive || t.guard || t.team === bot.team) continue; // spawn protection: no point shooting
      const d = eye.distanceTo(t.center);
      // city NPCs: the hunted bandit and those who go for this bot (a bum walking past is left alone)
      if (t.npc) { if (t !== prey && t.aggro !== bot.id) continue; }
      // not on a raid: enemies on this face (no sniping at other faces' walls), except in compact Skirmish where islands face each other 45m apart
      else if (map.mode !== 'skirmish' && !raiding && d > bot.tune.defendRadius && t.up.dot(up) < 0.9) continue;
      if (d > bestD || !combat.lineOfSight(eye, t.center)) continue;
      best = t;
      bestD = d;
    }
    // shot at by someone it does not see in its sector: turn to them
    if (!best && match.time - bot.hurtT < 2) {
      const a = combat.target(bot.hurtBy);
      if (a && a.alive && !a.guard && a.team !== bot.team && eye.distanceTo(a.center) < baseRange * 1.3
        && combat.lineOfSight(eye, a.center)) best = a;
    }
    if (best && !best.npc) {
      this.ctx.reportTarget(bot.team, best, bot.id);
    } else if (!best) {
      // Check shared team intelligence from teammates
      const intel = this.ctx.teamIntel.get(bot.team);
      if (intel && intel.by !== bot.id && match.time - intel.time < 6.0 && intel.target.alive && !intel.target.guard) {
        const d = eye.distanceTo(intel.target.center);
        if (d < bot.tune.sightRange * 1.35 && combat.lineOfSight(eye, intel.target.center)) {
          best = intel.target;
        } else if (bot.searchT <= 0 && intel.face && this.nav.face(intel.face).up.dot(up) > 0.9 && eye.distanceTo(intel.pos) < 34) {
          bot.searchPos = intel.pos.clone();
          bot.searchT = 4.5;
        }
      }
    }
    return best;
  }

  /** Weapon for the moment: the one it picked (grenade, rocket), else by the distance; fists when out of ammo. */
  arm(bot: Bot, d: number): WeaponId {
    const ws = bot.weapons;
    const ok = (w: WeaponId) => hasAmmo(ws, w);
    if (bot.pick && ok(bot.pick)) return bot.pick;
    // a drunk bum is not worth a bullet: fists and boots
    if (bot.enemy?.npc === 'bum') return 'fists';
    if (ok('shotgun') && (d < 8 || (ws.current === 'shotgun' && d < 11))) return 'shotgun';
    if (ok('crossbow') && (d > 22 || !ok('rifle'))) return 'crossbow';
    if (ok('revolver') && (bot.likes.revolver || !ok('rifle')) && d >= 7 && d <= 24) return 'revolver';
    if (ok('rifle')) return 'rifle';
    if (ok('revolver')) return 'revolver';
    if (ok('shotgun') && d < 16) return 'shotgun';
    if (ok('pistol')) return 'pistol';
    if (ok('shotgun')) return 'shotgun';
    return 'fists';
  }

  /** How far a weapon is worth using. */
  range(bot: Bot, w: WeaponId): number {
    if (w === 'fists') return WEAPONS.fists.reach;
    if (w === 'shotgun') return 22;
    if (w === 'grenade') return 24;
    return bot.tune.sightRange;
  }

  think(bot: Bot, dt: number): Thought {
    const { rng, match, blocks, combat } = this.ctx;
    const sim = bot.sim;
    const s = sim.state;
    const ws = bot.weapons;
    const input = emptyInput();
    input.yaw = s.yaw;
    input.pitch = s.pitch;
    if (bot.target.stun && bot.target.stun > 0) {
      bot.progressT = 0;
      bot.status = 'оглушён';
      return { input, fire: false, aim: null, kick: null, reload: false, select: ws.current };
    }
    const up = upOf(s.frame, new Vector3());
    const eye = s.pos.clone().addScaledVector(up, EYE_OFFSET);
    const loc = this.nav.locate(sim);

    // the plan: what to do now
    bot.taskT += dt;
    bot.planT -= dt;
    if (bot.planT <= 0 || bot.done) {
      bot.planT = 0.5;
      this.tasks.plan(bot, loc);
    }
    const raiding = bot.task.kind === 'raid';

    // perception
    bot.scanT -= dt;
    if (bot.scanT <= 0) {
      bot.scanT = 0.15;
      bot.enemy = this.findEnemy(bot, eye, raiding);
    }
    if (bot.enemy && !bot.enemy.alive) bot.enemy = null;
    const fresh = !!bot.enemy && bot.seenT === 0;
    bot.seenT = bot.enemy ? bot.seenT + dt : 0;
    bot.calmT = bot.enemy ? 0 : bot.calmT + dt;
    bot.searchT = Math.max(0, bot.searchT - dt);
    if (bot.enemy && !bot.enemy.npc) {
      bot.searchPos = bot.enemy.center.clone();
      bot.searchT = 5.0;
    }
    bot.pauseT = Math.max(0, bot.pauseT - dt);
    bot.pickT -= dt;
    if (bot.pickT <= 0) bot.pick = null;

    let aimAt: Vector3 | null = null;
    let wantFire = false;
    let reload = false;
    let label: string = TASK_LABEL[bot.task.kind];
    bot.fishing = false;
    let onLane = false;
    let atBed = false;
    let escape = false;
    /** Standing still on purpose (at the spot, waiting at a bridge end, shooting from the doorway). */
    let idle = false;
    let far = false;
    const wish = new Vector3();

    // lost: wedged on a ledge, or standing on something that is no known surface: hop, then give up and go home
    const lost = loc.kind === 'air' && (s.onGround || s.vel.lengthSq() < 0.36);
    bot.wedgeT = lost ? bot.wedgeT + dt : 0;
    if (bot.wedgeT > 0.5) bot.jumpT = 0.1;
    if (bot.wedgeT > 3) { bot.wedgeT = 0; this.ctx.placeAtSpawn(bot); }
    if (loc.kind === 'air') label = 'в полёте';
    else {
      const d = this.tasks.dest(bot);
      const r = this.nav.route(bot, loc, d);
      if (r.key !== bot.routeKey) {
        bot.breach = null;
        bot.route = r;
        bot.routeKey = r.key;
        bot.routePts = r.pts.slice();
        bot.strictAt = r.strict;
        bot.wp = 0;
        bot.detour = null;
        bot.checkT = 0;
        bot.bestDist = Infinity;
        bot.progressT = 0;
        // a mistake: the wrong way at the first crossing (and back)
        if (r.wrong && rng.chance(bot.tune.mistakes * 0.35)) {
          bot.routePts.unshift(r.wrong);
          if (bot.strictAt !== undefined) bot.strictAt++;
        }
        // a mistake: opens fire at the crystal from the doorway, out of range
        if (r.key.startsWith('bed:') && rng.chance(bot.tune.mistakes)) bot.farT = rng.range(1.2, 2.6);
      }
      const pts = bot.routePts;
      const goalXZ = pts[Math.min(bot.wp, pts.length - 1)];
      // a long way to go on solid ground: run (the stamina rules are the player's)
      const endXZ = pts[pts.length - 1];
      far = r.lane === undefined && !loc.lane && Math.hypot(endXZ[0] - loc.x, endXZ[1] - loc.z) + (pts.length - 1 - bot.wp) * 10 > 14;
      const goal = this.nav.toWorld(loc, goalXZ);
      const strictFrom = bot.strictAt;
      // on a lane: follow the line between its points (a point 2 m ahead on it), not a cut from where the bot stands
      // (a cut runs along the next face's wall, and touching that wall turns the gravity)
      let carrot: [number, number] | null = null;
      if (strictFrom !== undefined && bot.wp > strictFrom && bot.wp < pts.length) {
        const a = pts[bot.wp - 1], b = pts[bot.wp];
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz) || 1;
        const k = Math.max(0, Math.min(1, ((loc.x - a[0]) * dx + (loc.z - a[1]) * dz) / (len * len) + 2 / len));
        carrot = [a[0] + dx * k, a[1] + dz * k];
      }
      const planar = (p: Vector3) => { _v.copy(p).sub(s.pos); return _v.addScaledVector(up, -_v.dot(up)); };
      const dist = planar(goal).length();
      const last = bot.wp >= pts.length - 1;
      const strict = strictFrom !== undefined && bot.wp >= strictFrom;
      onLane = strict || !!loc.lane;
      const advance = !last && dist < (strict ? 0.5 : 0.9);
      if (advance) bot.wp++;
      // reached the end of a 'go' route but nothing happened (the gravity did not turn): re-plan
      if (last && r.end === 'go' && dist < 0.6) bot.routeKey = '';
      const arrived = last && r.end !== 'go' && dist < (r.arrive ?? 0.6);
      atBed = arrived && r.end === 'bed';
      idle = arrived;

      // Active target search: if we lost sight of an enemy (or a teammate shared target intel on this face), pursue their last known spot
      const searching = !bot.enemy && bot.searchT > 0 && !!bot.searchPos && !onLane && !atBed && !r.lane && r.end !== 'bed' && !loc.hall
        && Math.abs(_l.copy(bot.searchPos).sub(this.nav.face(loc.face).origin).dot(up)) < 6;
      const navGoal = searching && bot.searchPos ? bot.searchPos : goal;

      // local planner: if the straight line is blocked, pick a detour point that sees both ends
      const push = !!r.push && last && !searching;
      bot.checkT -= dt;
      if (push || strict) bot.detour = null;
      else if ((!arrived || searching) && bot.checkT <= 0) {
        bot.checkT = 0.4;
        if (bot.detour) {
          const dp = this.nav.toWorld(loc, bot.detour);
          if (planar(dp).length() < 0.9 || this.nav.clear(sim, s.pos, navGoal)) bot.detour = null;
        } else if (!this.nav.clear(sim, s.pos, navGoal)) bot.detour = this.nav.findDetour(bot, loc, navGoal);
      }
      const steerTo = bot.detour ? this.nav.toWorld(loc, bot.detour) : carrot ? this.nav.toWorld(loc, carrot) : navGoal;
      if (searching && bot.searchPos) {
        const sd = planar(bot.searchPos).length();
        if (sd > 2.0) {
          wish.copy(planar(steerTo)).normalize();
          label = 'ищет цель';
        } else {
          bot.searchT = 0;
          bot.searchPos = null;
        }
      } else if (!arrived) wish.copy(planar(steerTo)).normalize();
      this.nav.bridge(bot, r.lane, dt, steerTo);
      // out of wood on a bridge: stop at the edge, then go back for more (or try another way)
      let still = false;
      if (r.lane && bot.blocked) {
        wish.set(0, 0, 0);
        still = true;
        bot.strandT += dt;
        label = 'нет дерева';
        if (bot.strandT > 2) this.tasks.stranded(bot, loc);
      } else bot.strandT = 0;
      if (r.lane && !still && match.time - bot.builtAt < 1) label = 'строит мост';

      // the task's own business on the spot
      const a = this.tasks.act(bot, arrived, dt);
      if (a?.aim) { aimAt = a.aim; wantFire = !!a.fire; }
      if (a?.label) label = a.label;

      if (r.end === 'bed') {
        const bedAim = this.raidCrystal(bot, loc, eye, arrived, dt, wish);
        if (bedAim.aimAt) aimAt = bedAim.aimAt;
        if (bedAim.wantFire !== undefined) wantFire = bedAim.wantFire;
        if (bedAim.reload) reload = true;
        if (bedAim.still) still = true;
        if (bedAim.label) label = bedAim.label;
      }

      if (still) idle = true;
      // stuck: jump, then give up the task (a spot it cannot reach) or, at worst, go home
      const d2 = planar(carrot && !bot.detour ? goal : steerTo).length();
      if (still || arrived) bot.progressT = 0;
      else if (d2 < bot.bestDist - 0.25) { bot.bestDist = d2; bot.progressT = 0; }
      else bot.progressT += dt;
      // a new point: progress is measured afresh (or the bot would think it is stuck and jump / skip points)
      if (advance) { bot.bestDist = Infinity; bot.progressT = 0; }
      if (bot.progressT > 1.2) {
        bot.jumpT = 0.25; bot.bestDist = d2; bot.progressT = 0; bot.stuckT += 1.2; bot.detour = null; bot.checkT = 0;
        // an intermediate point may sit inside something (a parked car): skip it
        if (!last && !strict && bot.stuckT > 2) { bot.wp++; bot.bestDist = Infinity; }
      }
      if (arrived || bot.progressT === 0) bot.stuckT = Math.max(0, bot.stuckT - dt * 0.5);
      if (d.kind === 'point' && bot.stuckT > 8) {
        bot.avoid.set(d.key, match.time + 60);
        bot.stuckT = 0;
        this.tasks.finish(bot);
      }
      if (bot.stuckT > bot.tune.giveUp) { bot.stuckT = 0; this.ctx.placeAtSpawn(bot); }

      const br = this.updateBreach(bot, eye, steerTo, raiding, arrived, dt, wish);
      if (br) { aimAt = br.aimAt; wantFire = true; label = br.label; }

      if (r.end === 'hold' && arrived) {
        bot.patrolT += dt;
        if (bot.patrolT > 5) { bot.patrolT = 0; bot.patrol++; bot.stand++; }
      }
    }

    // fell into a pond basin (a pit): jump out towards the nearest side, steering in the air too
    const pf = this.nav.faceOfUp(up);
    if (pf) {
      const l = _l.copy(s.pos).sub(pf.origin).applyQuaternion(pf.inv);
      const pit = l.y < 0.6 ? this.nav.wet(pf.id, l.x, l.z, 0) : null;
      if (pit) {
        const ex = l.x - pit.c[0], ez = l.z - pit.c[1];
        const out = pit.h[0] - Math.abs(ex) < pit.h[1] - Math.abs(ez)
          ? new Vector3(pit.c[0] + Math.sign(ex || 1) * (pit.h[0] + 1.2), l.y, l.z) : new Vector3(l.x, l.y, pit.c[1] + Math.sign(ez || 1) * (pit.h[1] + 1.2));
        wish.copy(out.applyQuaternion(pf.q).add(pf.origin)).sub(s.pos);
        wish.addScaledVector(up, -wish.dot(up)).normalize();
        if (s.onGround) bot.jumpT = 0.45;
        escape = true;
        bot.progressT = 0;
        label = 'вылезает из пруда';
      }
    }

    // wedged (on top of a post, between props): no speed although it should be going somewhere. Hop off in a random
    // direction (steering in the air), then give up and go home
    // (measured along the ground: hopping up and down on the spot is no progress)
    _v.copy(s.pos).sub(bot.anchor);
    if (_v.addScaledVector(up, -_v.dot(up)).lengthSq() > 1 || idle || bot.hesitateT > 0 || (bot.enemy && bot.seenT > bot.tune.reaction)) {
      bot.anchor.copy(s.pos);
      bot.frozenT = 0;
    } else if (!escape) bot.frozenT += dt;
    if (bot.frozenT > 0.75 && bot.nudgeT <= -0.45) {
      const a = rng.range(0, Math.PI * 2);
      moveBasis(s.frame, a, _fwd, _right);
      bot.nudge.copy(_fwd);
      bot.nudgeT = 0.65;
      bot.jumpT = 0.14;
    }
    if (bot.frozenT > 7) { bot.frozenT = 0; this.ctx.placeAtSpawn(bot); }
    bot.nudgeT -= dt;
    if (bot.nudgeT > 0) {
      wish.copy(bot.nudge);
      escape = true;
    }

    // a mistake: stops for a moment and looks around
    bot.mistakeT -= dt;
    if (bot.mistakeT <= 0) {
      bot.mistakeT = rng.range(10, 25);
      if (!bot.enemy && !onLane && loc.kind === 'face' && rng.chance(bot.tune.mistakes)) bot.hesitateT = rng.range(0.7, 2);
    }
    if (bot.hesitateT > 0) {
      bot.hesitateT -= dt;
      bot.progressT = 0;
      if (!bot.enemy) {
        wish.set(0, 0, 0);
        input.yaw = s.yaw + dt * 1.8;
        label = 'замешкался';
      }
    }

    // combat overrides the view: shoot the enemy while still walking the route
    let kick: Vector3 | null = null;
    let aimDir: Vector3 | null = null;
    const e = bot.enemy;
    const ed = e ? eye.distanceTo(e.center) : Infinity;
    if (e && bot.seenT > bot.tune.reaction) {
      // a grenade now and then at a fighter at mid range; rockets at fighters in the open
      if (!e.npc && bot.nadeT <= 0 && ws.ammo.grenade > 0 && ed > 7 && ed < 20) {
        bot.nadeT = 5;
        if (rng.chance(0.4)) { bot.pick = 'grenade'; bot.pickT = 0.9; }
      }
      if (!e.npc && !bot.pick && bot.rocketT <= 0 && hasAmmo(ws, 'rocket') && ed > 6 && ed < 24) {
        bot.rocketT = 4;
        if (rng.chance(0.5)) { bot.pick = 'rocket'; bot.pickT = 1.2; }
      }
      const w = this.arm(bot, ed);
      if (ed < this.range(bot, w) + 0.3) {
        aimAt = e.center.clone().addScaledVector(e.up, 0.25);
        if (w === 'grenade') aimDir = lob(eye, aimAt, up, WEAPONS.grenade.speed, DEFAULT_MOVEMENT.gravity * WEAPONS.grenade.gravityScale);
        else {
          // slow bullets: aim ahead of a moving target by the flight time (as well as this bot can judge it)
          const speed = w === 'crossbow' ? crossbowSpec(ws.chargeT).speed : WEAPONS[w].speed;
          if (speed > 0 && e.vel) aimAt.addScaledVector(e.vel, (ed / speed) * bot.tune.lead);
        }
        wantFire = true;
        if (ed < KICK.reach + 0.3) kick = e.center.clone().sub(eye).normalize();
        // close-range weapons: go at them (not on a bridge, not at the crystal)
        if ((w === 'fists' || w === 'shotgun') && ed > 1.4 && ed < 14 && loc.kind === 'face' && !onLane && !atBed) {
          wish.copy(e.center).sub(s.pos);
          wish.addScaledVector(up, -wish.dot(up)).normalize();
        }
        label = e.npc ? 'дерётся с бандитом' : 'в бою';
      }
      // a mistake: reloads a half-full magazine as the fight starts
      if (fresh && isGun(ws.current) && ws.ammo[ws.current] < WEAPONS[ws.current].mag && rng.chance(bot.tune.mistakes * 0.5)) reload = true;
    } else if (bot.calmT > 2 && isGun(ws.current) && ws.ammo[ws.current] < WEAPONS[ws.current].mag * 0.6 && ws.reserve[ws.current] > 0) reload = true;

    // Active reload: if reloading and bot rolled tryActiveReload, press R inside the green zone
    if (ws.reloadT > 0 && bot.tryActiveReload && ws.reloadStatus === 'ready' && ws.reloadZoneWidth > 0) {
      const prog = reloadProgressOf(ws);
      if (prog >= ws.reloadZoneStart + ws.reloadZoneWidth * 0.25 && prog <= ws.reloadZoneStart + ws.reloadZoneWidth * 0.85) {
        reload = true;
        wantFire = false;
        bot.tryActiveReload = false;
      }
    }

    // Use grappling hook occasionally on long flat stretches when not on a bridge lane
    if (far && !onLane && !bot.enemy && bot.eco.has('hook') && !sim.hook && sim.hookCd <= 0 && wish.lengthSq() > 0.5 && rng.chance(0.015)) {
      const hookDir = wish.clone().addScaledVector(up, 0.18).normalize();
      sim.throwHook(eye, hookDir, combat.notCharacter);
    }

    // Personal separation: gently fan bots apart on the same floor so groups stream through doors & shops cleanly
    if (!onLane && loc.kind === 'face') {
      this.applySeparation(bot, up, wish);
    }

    let aim: Vector3 | null = null;
    if (aimAt) {
      const dir = aimDir ?? aimAt.sub(eye).normalize();
      [input.yaw, input.pitch] = this.nav.look(sim, dir);
      aim = dir.clone().add(new Vector3(rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)).multiplyScalar(bot.tune.spread)).normalize();
    } else if (wish.lengthSq() > 0.01) {
      [input.yaw] = this.nav.look(sim, wish);
      input.pitch = 0;
    }
    // movement relative to the view; none in the air (air strafing would bend geyser / drop trajectories)
    moveBasis(s.frame, input.yaw, _fwd, _right);
    if (!s.onGround && !escape) { /* ballistic */ } else if (wish.lengthSq() > 0.01) {
      input.forward = wish.dot(_fwd);
      input.right = wish.dot(_right);
      input.sprint = far && !aimAt && input.forward > 0.7;
    } else if (bot.enemy && bot.seenT > bot.tune.reaction) {
      input.right = Math.sin(match.time * 2.3 + bot.id) > 0 ? 1 : -1; // strafe while holding a position
    }
    if (bot.jumpT > 0) { input.jump = true; bot.jumpT -= dt; }
    bot.status = label;
    // avoid unused-import check if blocks is needed in helpers
    void blocks;
    return { input, fire: wantFire && bot.pauseT <= 0, aim, kick, reload, select: this.arm(bot, ed) };
  }

  /** Shooting at enemy crystal, Stage 1 shield fallback demolition, or rocket/fort clearing. */
  private raidCrystal(bot: Bot, loc: Ground, eye: Vector3, arrived: boolean, dt: number, wish: Vector3): {
    aimAt?: Vector3; wantFire?: boolean; reload?: boolean; still?: boolean; label?: string;
  } {
    const { match, blocks } = this.ctx;
    const ws = bot.weapons;
    const sim = bot.sim;
    const bed = match.bed(this.tasks.raidGoal(bot));
    let aimAt: Vector3 | undefined;
    let wantFire: boolean | undefined;
    let reload = false;
    let still = false;
    let label: string | undefined;

    // a mistake: shooting the crystal from the doorway (out of range: wasted)
    if (bed.alive && !arrived && bot.farT > 0 && loc.hall) {
      bot.farT -= dt;
      if (!match.firstHit(eye, bed.pos, sim.mover.collider)) {
        aimAt = bed.pos.clone();
        wantFire = true;
        wish.set(0, 0, 0);
        still = true;
        label = 'стреляет по кристаллу издалека';
      }
    }
    if (bed.alive && arrived) {
      label = 'ломает кристалл';
      if (bot.rocketFort) {
        const blk = this.nav.fortBlock(bot, loc, bed.pos);
        if (!blk || !hasAmmo(ws, 'rocket') || bot.target.hp < 30) bot.rocketFort = false;
        else {
          aimAt = blk.center.clone();
          wantFire = true;
          bot.pick = 'rocket';
          bot.pickT = 0.3;
          label = 'ракетой по укреплению';
        }
      } else {
        // a gun: at the top of the crystal over the fort; fists: anywhere
        const top = bed.pos.clone().addScaledVector(bed.up, isArmed(bot, 1) ? BED_AIM : 0);
        const hit = match.firstHit(eye, top, sim.mover.collider);
        if (!hit) {
          // shoot it from the stand (within the 5 m of the rule); wait while Stage 1 shield is invulnerable
          aimAt = top;
          if (bed.invulnT > 0) {
            const nearbyFoeBlock = this.nav.enemyStructureTarget(bot, eye, bed.pos);
            if (nearbyFoeBlock) {
              const blk = blocks.byCollider(nearbyFoeBlock);
              if (blk) {
                aimAt = blk.center.clone();
                wantFire = true;
                if (hasAmmo(ws, 'rocket') && blk.center.distanceTo(eye) > 4.2) { bot.pick = 'rocket'; bot.pickT = 0.3; }
                label = 'сносит вражеские постройки';
              }
            } else {
              wantFire = false;
              refillAmmo(ws, 0.5);
              if (isGun(ws.current) && ws.ammo[ws.current] < WEAPONS[ws.current].mag && ws.reserve[ws.current] > 0) reload = true;
              label = 'ждёт уязвимости кристалла';
            }
          } else {
            wantFire = true;
          }
        } else {
          const block = blocks.byCollider(hit.collider.handle);
          const dir = top.clone().sub(eye).normalize();
          if (block && hasAmmo(ws, 'rocket') && bot.target.hp > 40) bot.rocketFort = true;
          else if (block) {
            aimAt = eye.clone().addScaledVector(dir, hit.timeOfImpact + 0.1);
            wantFire = true;
            label = 'ломает укрепление';
          } else {
            bot.standT += dt;
            if (bot.standT > 2) { bot.standT = 0; bot.stand++; }
          }
        }
      }
    }
    return { aimAt, wantFire, reload, still, label };
  }

  /** Demolish enemy walls/doors blocking the path, covering hidden foes, or guarding enemy bases. */
  private updateBreach(bot: Bot, eye: Vector3, steerTo: Vector3, raiding: boolean, arrived: boolean, dt: number, wish: Vector3): {
    aimAt: Vector3; label: string;
  } | null {
    const { match, blocks } = this.ctx;
    const ws = bot.weapons;
    if (bot.breach === null && !bot.enemy) {
      const foeOnWay = this.nav.blockInTheWay(bot.sim, steerTo, bot.team, true);
      if (foeOnWay !== null && (bot.stuckT > 0.35 || arrived === false)) {
        bot.breach = foeOnWay;
        bot.breachT = 0;
      } else if (!arrived && bot.stuckT > 2.2) {
        bot.breach = this.nav.blockInTheWay(bot.sim, steerTo, bot.team, false);
        bot.breachT = 0;
      } else if (raiding || (bot.searchT > 0 && bot.searchPos)) {
        const raidBed = raiding && bot.goal ? match.bed(bot.goal).pos : undefined;
        const enemyStruct = this.nav.enemyStructureTarget(bot, eye, raidBed);
        if (enemyStruct !== null) {
          bot.breach = enemyStruct;
          bot.breachT = 0;
        }
      }
      const b = bot.breach !== null ? blocks.byCollider(bot.breach) : null;
      if (b && b.material !== 'wood' && !isArmed(bot, 1) && !hasAmmo(ws, 'rocket') && b.center.distanceTo(eye) > 3.2) {
        bot.breach = null;
      }
    }
    if (bot.breach !== null) {
      const block = blocks.byCollider(bot.breach);
      bot.breachT += dt;
      const armed = isArmed(bot, 1) || hasAmmo(ws, 'rocket');
      const reachOk = armed ? block && block.center.distanceTo(eye) <= 18 : block && block.center.distanceTo(eye) <= 3.5;
      if (!block || block.team === bot.team) {
        bot.breach = null;
        bot.stuckT = 0;
      } else if (bot.breachT > 16 || (!armed && block.material !== 'wood' && bot.breachT > 4)) {
        bot.breach = null;
        if (!arrived) bot.stuckT = bot.tune.giveUp;
      } else if (reachOk && block.center.distanceTo(eye) > 2.2) {
        if (hasAmmo(ws, 'rocket') && block.center.distanceTo(eye) > 4.2) { bot.pick = 'rocket'; bot.pickT = 0.3; }
        if (block.team && block.team !== bot.team && !bot.enemy) {
          // Hold steady while finishing off an enemy structure so bots reliably demolish builds instead of glancing off
          wish.multiplyScalar(0.35);
        }
        return { aimAt: block.center.clone(), label: 'сносит вражеские постройки' };
      }
    }
    return null;
  }

  /** Gently fan bots apart on the same floor so groups stream through doors & shops cleanly. */
  private applySeparation(bot: Bot, up: Vector3, wish: Vector3) {
    const s = bot.sim.state;
    const sep = new Vector3();
    const diff = new Vector3();
    for (const other of this.ctx.combat.targets) {
      if (!other.alive || other.id === bot.id || other.npc || other.up.dot(up) < 0.9) continue;
      diff.copy(s.pos).sub(other.center);
      const vert = diff.dot(up);
      if (Math.abs(vert) > 1.8) continue;
      diff.addScaledVector(up, -vert);
      const d2 = diff.lengthSq();
      if (d2 > 1e-6 && d2 < 1.45 * 1.45) {
        const d = Math.sqrt(d2);
        sep.addScaledVector(diff, (1.45 - d) / (1.45 * d));
      } else if (d2 <= 1e-6) {
        sep.x += (bot.id % 2 ? 1 : -1) * 0.5;
      }
    }
    if (sep.lengthSq() > 0.002) {
      if (wish.lengthSq() > 0.01) wish.addScaledVector(sep, 0.95).normalize();
      else if (sep.lengthSq() > 0.05) wish.copy(sep).normalize();
    }
  }
}
