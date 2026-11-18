import { Quaternion, Vector3 } from 'three';
import { lootValue, Needs, nextBuy, shop } from '../botShop';
import { MAX_HP, Target } from '../combat';
import { EAT_COOLDOWN, ITEMS, MAX_MEDKITS, Pickup, PICKUPS } from '../economy';
import { MATCH_RULES } from '../lobby';
import type { FaceId } from '../map';
import { BED_HP, SKIRMISH_WOOD_PER_SEC } from '../match';
import type { TeamId } from '../teams';
import { refillAmmo, totalFuelAmmo } from '../weapons';
import type { BotNav } from './nav';
import {
  Bot, BotCtx, Dest, FaceInfo, fishRound, FortCell, Ground, isArmed, isRaider, Loc, pickMaterial, sameTask, Task, XZ,
} from './types';

/** Bot strategic planning: economy sensing, task selection, on-site actions, upkeep, and base alarms. */
export class BotTasks {
  private watchT = 0;

  constructor(private ctx: BotCtx, private nav: BotNav) {}

  /** Where bots stand at the shop counters, by the ponds and the generators; the forts around the crystals. */
  survey() {
    const { map, match, shops, ponds, gens, forts } = this.ctx;
    for (const b of map.bases) {
      const up = new Vector3(...b.up);
      const f = this.nav.faceOfUp(up);
      if (!f) continue;
      const sPos = new Vector3(...b.shop);
      const out = sPos.clone().sub(new Vector3(...b.keeper.pos));
      out.addScaledVector(up, -out.dot(up)).normalize();
      const xz = this.nav.localXZ(f, sPos.addScaledVector(out, 1.6));
      shops.push({ face: f.id, team: b.team, xz, hall: this.nav.inHall(f, xz) });
    }
    for (const p of map.ponds) {
      const f = this.nav.faceOfUp(new Vector3(...p.up));
      if (!f) continue;
      const q = new Quaternion(...p.quat), water = new Vector3(...p.pos);
      const stands: XZ[] = [];
      for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const w = new Vector3(ax * (p.half[0] + 1.4), 0, az * (p.half[1] + 1.4)).applyQuaternion(q).add(water);
        if (this.nav.spotFree(f, w)) stands.push(this.nav.localXZ(f, w));
      }
      // the basin in face-local axes (a pond turned by 90° swaps its sizes)
      const ax = new Vector3(1, 0, 0).applyQuaternion(q).applyQuaternion(f.inv);
      const h: XZ = Math.abs(ax.x) > 0.7 ? [p.half[0], p.half[1]] : [p.half[1], p.half[0]];
      ponds.push({ face: f.id, water, stands, c: this.nav.localXZ(f, water), h });
    }
    for (const g of match.generators) {
      const f = this.nav.faceOfUp(g.up)!;
      gens.push({ face: f.id, xz: this.nav.localXZ(f, g.pos) });
    }
    for (const s of map.statues) forts.set(s.team as TeamId, s.fort.map((c) => ({ pos: new Vector3(...c.pos), material: c.material })));
  }

  /** Bots no longer place fortification blocks near crystals (returns empty list). */
  fortGap(_team: TeamId): FortCell[] {
    return [];
  }

  /** Wood the bridges between `from` and the raid goal still need (+2 spare), 0 if they are all built. */
  woodNeed(bot: Bot, from = this.nav.teamFace(bot.team).id): number {
    const goal = this.nav.teamFace(this.raidGoal(bot)).id;
    let miss = 0;
    let at = from;
    for (let k = 0; k < 3 && at !== goal; k++) {
      const next = this.nav.nextFace(bot, at, goal);
      const lane = this.nav.laneBetween(at, next, bot.id);
      if (lane) miss += this.nav.missing(lane);
      at = next;
    }
    return miss ? miss + 2 : 0;
  }

  /** Ready to raid: a gun with ammo, and wood for the bridges (or none needed). */
  ready(bot: Bot): boolean {
    const need = this.woodNeed(bot);
    return isArmed(bot, 30) && (need === 0 || (bot.eco.has('builder') && bot.kit.wood >= need));
  }

  needs(bot: Bot): Needs {
    const raider = isRaider(bot, this.ctx.match);
    return {
      raider, wood: raider ? this.woodNeed(bot) : 0, fort: 0,
      shotgun: bot.likes.shotgun, revolver: bot.likes.revolver, fisher: bot.likes.fish, impulse: bot.impulse,
    };
  }

  /** Something at the shop it can afford now (after selling its loot), or loot worth cashing in. */
  worthShopping(bot: Bot): boolean {
    const loot = lootValue(bot.eco);
    return loot >= 30 || nextBuy(bot.eco, this.needs(bot), loot) !== null;
  }

  avoided(bot: Bot, key: string): boolean {
    return (bot.avoid.get(key) ?? -1) > this.ctx.match.time;
  }

  /** A counter the bot may use on this face (its own team's or a neutral one), nearest first; -1 = none. */
  shopOn(bot: Bot, face: FaceId): number {
    let best = -1, bd = Infinity;
    const pos = bot.sim.state.pos;
    this.ctx.shops.forEach((s, i) => {
      if (s.face !== face || (s.team !== bot.team && s.team !== '') || this.avoided(bot, `shop${i}`)) return;
      const d = this.nav.toWorldXZ(s.face, s.xz).distanceTo(pos);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  }

  /** The best thing lying on the own face within `radius` of `from`: worth the walk, not claimed by a team-mate. */
  bestPickup(bot: Bot, from: Vector3, radius: number): Pickup | null {
    if (!this.ctx.loot) return null;
    const f = this.nav.teamFace(bot.team);
    const pos = bot.sim.state.pos;
    // keep away from the bandits (unarmed: well away)
    const gangs = this.gangs(f);
    const keep = isArmed(bot, 1) ? 9 : 16;
    // the player's team-mates leave the apples and bottles to the player once they can fish
    const ally = bot.team === this.ctx.playerTeam && bot.eco.has('rod');
    let best: Pickup | null = null, score = 0;
    for (const it of this.ctx.loot.items) {
      if (!it.alive || it.up.dot(f.up) < 0.99) continue;
      if (it.kind === 'medkit' && bot.eco.items.medkit >= MAX_MEDKITS) continue;
      if (ally && (it.kind === 'apple' || it.kind === 'bottle')) continue;
      if (it.pos.distanceTo(from) > radius || this.avoided(bot, `item${it.id}`)) continue;
      if (gangs.some((g) => g.center.distanceTo(it.pos) < keep)) continue;
      if (this.ctx.bots.some((o) => o !== bot && o.task.kind === 'gather' && o.task.item === it)) continue;
      const value = this.pickupValue(it);
      const sc = value / (it.pos.distanceTo(pos) + 12);
      if (sc > score) { score = sc; best = it; }
    }
    return best;
  }

  pickupValue(it: Pickup): number {
    if (it.kind === 'cash') return it.amount;
    if (it.kind === 'ammo') return 8;
    if (it.kind === 'wood' || it.kind === 'stone' || it.kind === 'metal') return Math.max(1, it.amount);
    return ITEMS[it.kind].sell * Math.max(1, it.amount) || 6;
  }

  /** Bandits alive on a face. */
  gangs(f: FaceInfo): Target[] {
    return this.ctx.combat.targets.filter((t) => t.alive && t.npc === 'gang' && t.up.dot(f.up) > 0.99);
  }

  /** Money per second a pickup is worth, counting the walk there. */
  pickupRate(bot: Bot, it: Pickup): number {
    const value = this.pickupValue(it);
    return value / (it.pos.distanceTo(bot.sim.state.pos) / 6 + 2.5);
  }

  /** A free side of a pond on the own face, nearest to the bot (defenders: also near the hall); null = none. */
  pond(bot: Bot): [number, number] | null {
    const home = this.nav.teamFace(bot.team);
    const pos = bot.sim.state.pos;
    const hall = home.nav.hall ? this.nav.toWorldXZ(home.id, home.nav.hall.c) : pos;
    const stay = !isRaider(bot, this.ctx.match);
    const gangs = this.gangs(home);
    let best: [number, number] | null = null, bd = Infinity;
    this.ctx.ponds.forEach((p, i) => {
      if (p.face !== home.id || gangs.some((g) => g.center.distanceTo(p.water) < 14)) return;
      p.stands.forEach((_, j) => {
        if (this.avoided(bot, `pond${i}:${j}`)) return;
        if (this.ctx.bots.some((o) => o !== bot && o.task.kind === 'fish' && o.task.pond === i && o.task.stand === j)) return;
        // the fish are sold in the hall: a pond near it is worth more (defenders stay close anyway)
        const d = p.water.distanceTo(pos) + p.water.distanceTo(hall) * (stay ? 1 : 0.6);
        if (d < bd) { bd = d; best = [i, j]; }
      });
    });
    return best;
  }

  /** A bandit on the own face within `r`: it drops money when killed. */
  bandit(bot: Bot, r: number): Target | null {
    const up = this.nav.teamFace(bot.team).up;
    let best: Target | null = null, bd = r;
    for (const t of this.ctx.combat.targets) {
      if (!t.alive || t.npc !== 'gang' || t.up.dot(up) < 0.99) continue;
      const d = t.center.distanceTo(bot.sim.state.pos);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  /**
   * A generator worth a crystal run (rockets cost crystals): one on the neutral face the bot is crossing, or, while a
   * raider waits for its departure, one on a neutral face next door with a bridge it can afford. -1 = none.
   */
  genRun(bot: Bot, here: FaceId): number {
    const ws = bot.weapons;
    // only once it has its main gun: rockets are a luxury
    if (!bot.likes.crystals || !isRaider(bot, this.ctx.match) || !(ws.owned.rifle || ws.owned.shotgun) || !isArmed(bot, 15) || this.ctx.match.time < 120) return -1;
    if (bot.wallet.crystal >= 5 || (ws.owned.rocket && ws.ammo.rocket + ws.reserve.rocket >= 4)) return -1;
    const home = this.nav.teamFace(bot.team).id;
    let best = -1, bs = 0;
    this.ctx.gens.forEach((g, i) => {
      if (this.avoided(bot, `gen${i}`)) return;
      const stored = this.ctx.match.generators[i].stored;
      let w = 0;
      if (g.face === here && here !== home && stored > 0) w = stored + 1;
      else if (here === home && this.ctx.match.time < bot.departAt && stored >= 2 && this.nav.adjacent(home, g.face)) {
        const miss = this.nav.missing(this.nav.laneBetween(home, g.face));
        if (miss === 0 || (bot.eco.has('builder') && bot.kit.wood >= miss + 2)) w = stored * 0.5;
      }
      if (w > bs) { bs = w; best = i; }
    });
    return best;
  }

  /** Per team: is the base attacked (crystal hit, enemy fighters close to it)? Checked four times a second. */
  watch(dt: number) {
    this.watchT -= dt;
    if (this.watchT > 0) return;
    this.watchT = 0.25;
    const now = this.ctx.match.time;
    for (const team of this.ctx.teams) {
      const bed = this.ctx.match.bed(team);
      if (!bed.alive) continue;
      const f = this.nav.teamFace(team);
      let by: Target | null = null, bd = 30;
      for (const t of this.ctx.combat.targets) {
        if (!t.alive || t.npc || t.team === team || t.up.dot(f.up) < 0.9) continue;
        const d = t.center.distanceTo(bed.pos);
        if (d < bd) { bd = d; by = t; }
      }
      const hit = bed.hp < BED_HP && bed.calm < 1;
      const a = this.ctx.alarms.get(team) ?? { until: -1, by: null, serial: 0 };
      if (hit || by) {
        if (a.until < now) a.serial++;
        a.until = now + 8;
        if (by) a.by = by;
      }
      if (a.by && !a.by.alive) a.by = null;
      this.ctx.alarms.set(team, a);
    }
  }

  alarmed(team: TeamId): boolean {
    const a = this.ctx.alarms.get(team);
    return !!a && a.until > this.ctx.match.time && this.ctx.match.bed(team).alive;
  }

  setTask(bot: Bot, task: Task) {
    bot.done = false;
    if (sameTask(task, bot.task)) return;
    bot.task = task;
    bot.taskT = 0;
    bot.stuckT = 0;
    if (task.kind === 'fish') { bot.fishT = 0; bot.fishAt = fishRound(this.ctx.rng); bot.caught = 0; }
    if (task.kind === 'shop') bot.impulse = this.ctx.rng.chance(bot.tune.mistakes * 0.5);
    if (task.kind === 'crystals' || task.kind === 'shop') bot.genWait = 0;
  }

  /** The task is over: plan the next one at once. */
  finish(bot: Bot) {
    bot.done = true;
    bot.planT = 0;
  }

  /** Re-plan: the alarm first; otherwise keep the task while it makes sense, then choose the next one. */
  plan(bot: Bot, loc: Loc) {
    const home = this.nav.teamFace(bot.team);
    const a = this.ctx.alarms.get(bot.team);
    if (a && this.alarmed(bot.team) && bot.task.kind !== 'defend') {
      const atHome = loc.kind === 'face' ? loc.face === home.id : bot.target.up.dot(home.up) > 0.99;
      if (atHome) {
        let go = !isRaider(bot, this.ctx.match) || bot.joined;
        if (!go && bot.answered !== a.serial) {
          bot.answered = a.serial;
          go = this.ctx.rng.chance(bot.tune.answer);
        }
        if (go) {
          bot.joined = false;
          this.setTask(bot, { kind: 'defend' });
          return;
        }
      }
    }
    if (loc.kind === 'air' && !bot.done) return;
    if (!this.valid(bot, loc)) this.setTask(bot, this.choose(bot, loc));
  }

  valid(bot: Bot, loc: Loc): boolean {
    if (bot.done) return false;
    const task = bot.task, t = bot.taskT;
    switch (task.kind) {
      case 'defend': return this.alarmed(bot.team);
      case 'gather': return task.item.alive && t < 30;
      case 'fish': return t < 90 && !this.worthShopping(bot);
      case 'hunt': return task.target.alive && t < 40 && bot.target.hp > 35 && isArmed(bot, 1)
        && task.target.center.distanceTo(bot.sim.state.pos) < 70;
      case 'shop': return t < 60;
      case 'crystals': return t < 150 && bot.wallet.crystal < 8 && bot.genWait < 18;
      case 'fortify': return t < 45 && this.fortGap(bot.team).length > 0 && !!pickMaterial(bot, 'stone');
      case 'rally': return t < bot.tune.rally + 3;
      case 'raid': {
        if (!isRaider(bot, this.ctx.match)) return false;
        // nothing left to shoot with, still at home: restock first
        const atHome = loc.kind === 'face' && loc.face === this.nav.teamFace(bot.team).id;
        if (isArmed(bot, 1)) return true;
        if (atHome) return !this.worthShopping(bot);
        const goalBed = this.ctx.match.bed(this.raidGoal(bot));
        return bot.wallet.cash < 6 || (goalBed.alive && goalBed.pos.distanceTo(bot.sim.state.pos) < 20);
      }
      case 'patrol': return t < 5;
    }
  }

  choose(bot: Bot, loc: Loc): Task {
    const t = this.ctx.match.time;
    const home = this.nav.teamFace(bot.team).id;
    const here = loc.kind === 'face' ? loc.face : home;
    const bedAlive = this.ctx.match.bed(bot.team).alive;
    if (isRaider(bot, this.ctx.match)) {
      this.raidGoal(bot);
      const canGo = bot.joined || !bedAlive || t >= bot.departAt;
      if (canGo && here !== home) {
        // out there already: crystals and a counter on a neutral face on the way, then on with the raid
        const gen = this.genRun(bot, here);
        if (gen >= 0) return { kind: 'crystals', gen };
        const s = this.shopOn(bot, here);
        if (s >= 0 && this.worthShopping(bot)) return { kind: 'shop', shop: s };
        // out of ammo but not of money: home for more (unless the crystal is right there)
        const own = this.shopOn(bot, home);
        const goalBed = this.ctx.match.bed(this.raidGoal(bot));
        if (own >= 0 && !isArmed(bot, 1) && bot.wallet.cash >= 6 && !(goalBed.alive && goalBed.pos.distanceTo(bot.sim.state.pos) < 20))
          return { kind: 'shop', shop: own };
        return { kind: 'raid' };
      }
      if (canGo) {
        // geared up, or fed up with waiting (or just rash: a mistake)
        if (!bot.rash && (t >= bot.departAt + bot.tune.patience || !bedAlive || this.ctx.rng.chance(bot.tune.mistakes * 0.15))) bot.rash = true;
        if (this.ready(bot) || bot.rash) {
          const s = this.shopOn(bot, here);
          if (s >= 0 && !bot.rash && this.worthShopping(bot)) return { kind: 'shop', shop: s };
          return this.squad(bot) ? { kind: 'rally' } : { kind: 'raid' };
        }
      }
    }
    const s = this.shopOn(bot, here);
    if (s >= 0 && this.worthShopping(bot)) return { kind: 'shop', shop: s };
    if (!isRaider(bot, this.ctx.match) && bedAlive && here === home && bot.eco.has('builder') && this.fortGap(bot.team).length
      && pickMaterial(bot, 'stone')) return { kind: 'fortify' };
    const gen = this.genRun(bot, here);
    if (gen >= 0) return { kind: 'crystals', gen };
    return this.earn(bot, here);
  }

  /** Make money: a bandit nearby, things lying around, fishing; else back to the hall. */
  earn(bot: Bot, here: FaceId): Task {
    const home = this.nav.teamFace(bot.team);
    if (here !== home.id) return { kind: 'patrol' }; // head home first
    const stay = !isRaider(bot, this.ctx.match);
    const from = stay && home.nav.hall ? this.nav.toWorldXZ(home.id, home.nav.hall.c) : bot.sim.state.pos;
    const radius = stay ? 60 : 140;
    // bandits: only with a gun that kills them before the ammo costs more than they drop
    const ws = bot.weapons;
    if (((ws.owned.rifle && ws.ammo.rifle + ws.reserve.rifle >= 40) || (ws.owned.shotgun && ws.ammo.shotgun + ws.reserve.shotgun >= 12))
      && bot.target.hp > 60) {
      const g = this.bandit(bot, stay ? 35 : 55);
      if (g) return { kind: 'hunt', target: g };
    }
    const it = this.bestPickup(bot, from, radius);
    const p = bot.eco.has('rod') ? this.pond(bot) : null;
    // with a rod, a walk is only worth it for something that pays better than fishing
    const fishing = (ITEMS.fish.sell * bot.tune.fishSkill) / 5.6;
    if (it && (!p || this.pickupRate(bot, it) > fishing * 0.8)) return { kind: 'gather', item: it };
    if (p) return { kind: 'fish', pond: p[0], stand: p[1] };
    return { kind: 'patrol' };
  }

  /** Is a squad mate coming (a ready raider, the defender joining)? Asks the defender along. */
  squad(bot: Bot): boolean {
    if (!this.ctx.match.bed(bot.team).alive) return false;
    const t = this.ctx.match.time;
    let any = false;
    for (const m of this.ctx.bots) {
      if (m === bot || m.team !== bot.team || m.out || !m.target.alive) continue;
      if (m.task.kind === 'rally') { any = true; continue; }
      if (m.task.kind === 'raid' || m.task.kind === 'defend') continue;
      if (m.role === 'attack' && t >= m.departAt - 15 && this.ready(m)) any = true;
      else if (m.role === 'defend' && !m.joined && this.mayJoin(m)) {
        m.joined = true;
        m.goal = bot.goal;
        this.setTask(m, { kind: 'rally' });
        any = true;
      }
    }
    return any;
  }

  /** The defender goes along when the base is calm, the fort holds and it is armed. */
  mayJoin(def: Bot): boolean {
    const a = this.ctx.alarms.get(def.team);
    if (a && a.until > this.ctx.match.time - 30) return false;
    if (!isArmed(def, 30) || def.target.hp < 70 || this.fortGap(def.team).length > 4) return false;
    return this.ctx.rng.chance(def.tune.join + (this.ctx.match.time > 300 ? 0.25 : 0));
  }

  /** Squad meeting point: outside the front door (team-mates side by side). */
  rallyPoint(bot: Bot): XZ {
    const N = this.nav.teamFace(bot.team).nav;
    const o = N.doors![0].out;
    return [o[0] + (bot.slot % 2 ? 2.2 : -2.2), o[1] - 2];
  }

  chooseGoal(bot: Bot): TeamId {
    const alive = this.ctx.teams.filter((t) => t !== bot.team && this.ctx.match.bed(t).alive);
    const fallback = bot.team !== this.ctx.playerTeam ? this.ctx.playerTeam : this.ctx.teams.find((t) => t !== bot.team) ?? bot.team;
    if (!alive.length) return fallback;
    if (alive.includes(this.ctx.playerTeam) && this.ctx.rng.chance(bot.tune.targetPlayerChance)) return this.ctx.playerTeam;
    const others = alive.filter((t) => t !== this.ctx.playerTeam);
    if (!others.length) return fallback;
    // a neighbour (one bridge) rather than the far side; few defenders; a damaged crystal; holes in the fort
    const home = this.nav.teamFace(bot.team);
    const w = others.map((t) => {
      const near = Math.abs(this.nav.teamFace(t).up.dot(home.up)) < 0.5 ? 2 : 1;
      const guards = this.ctx.bots.filter((b) => b.team === t && b.target.alive && !b.out).length;
      const bed = this.ctx.match.bed(t);
      return (near * (1 + (BED_HP - bed.hp) / BED_HP) * (1 + this.fortGap(t).length / 16)) / (1 + guards * 0.5);
    });
    let r = this.ctx.rng.range(0, w.reduce((a, b) => a + b, 0));
    for (let i = 0; i < others.length; i++) if ((r -= w[i]) <= 0) return others[i];
    return others[others.length - 1];
  }

  /** Team whose crystal the raider goes for (a broken one is dropped once another base is worth attacking). */
  raidGoal(bot: Bot): TeamId {
    const enemyBeds = this.ctx.teams.some((t) => t !== bot.team && this.ctx.match.bed(t).alive);
    if (!bot.goal || bot.goal === bot.team || (!this.ctx.match.bed(bot.goal).alive && (enemyBeds || this.ctx.match.isOut(bot.goal)))) bot.goal = this.chooseGoal(bot);
    return bot.goal;
  }

  dest(bot: Bot): Dest {
    const task = bot.task;
    const home = this.nav.teamFace(bot.team).id;
    switch (task.kind) {
      case 'raid': {
        const team = this.raidGoal(bot);
        return { kind: 'bed', face: this.nav.teamFace(team).id, team };
      }
      case 'shop': {
        const s = this.ctx.shops[task.shop];
        const fan = ((bot.id % 5) - 2) * 0.65;
        const depth = (bot.id % 2) * 0.55;
        const pt: XZ = [s.xz[0] + fan, s.xz[1] + (s.hall ? depth : -depth)];
        return { kind: 'point', face: s.face, pt, hall: s.hall, key: `shop${task.shop}:${bot.id % 5}`, end: 'act', arrive: 0.9 };
      }
      case 'gather': {
        const f = this.nav.faceOfUp(task.item.up);
        if (!f) break;
        const pt = this.nav.localXZ(f, task.item.pos);
        return { kind: 'point', face: f.id, pt, hall: this.nav.inHall(f, pt), key: `item${task.item.id}`, end: 'act', arrive: 1.2 };
      }
      case 'fish': {
        const p = this.ctx.ponds[task.pond];
        return { kind: 'point', face: p.face, pt: p.stands[task.stand], hall: false, key: `pond${task.pond}:${task.stand}`, end: 'act', arrive: 0.7 };
      }
      case 'hunt': {
        const f = this.nav.faceOfUp(task.target.up);
        if (!f) break;
        const pt = this.nav.localXZ(f, task.target.center);
        return { kind: 'point', face: f.id, pt, hall: false, key: `hunt${task.target.id}:${Math.round(pt[0] / 5)}:${Math.round(pt[1] / 5)}`, end: 'hold', arrive: 8 };
      }
      case 'crystals': {
        const g = this.ctx.gens[task.gen];
        return { kind: 'point', face: g.face, pt: g.xz, hall: false, key: `gen${task.gen}`, end: 'act', arrive: 1 };
      }
      case 'rally': {
        const pt = this.rallyPoint(bot);
        return { kind: 'point', face: home, pt, hall: false, key: `rally${bot.slot % 2}`, end: 'act', arrive: 1.2 };
      }
    }
    return { kind: 'home', face: home };
  }

  /** The task's own business on the spot (or on the way). */
  act(bot: Bot, arrived: boolean, dt: number): { aim?: Vector3; fire?: boolean; label?: string } | null {
    const task = bot.task;
    const pos = bot.sim.state.pos;
    switch (task.kind) {
      case 'shop': {
        if (!arrived) return null;
        // a moment at the counter (sell, pick, pay)
        bot.genWait += dt;
        if (bot.genWait < 1) return { label: 'покупает' };
        const r = shop(bot.eco, () => this.needs(bot));
        bot.earned += r.sold;
        bot.spent += r.spent;
        bot.bought.push(...r.bought);
        this.finish(bot);
        return { label: 'покупает' };
      }
      case 'gather': {
        if (!task.item.alive) { this.finish(bot); return null; }
        if (pos.distanceTo(task.item.pos) < PICKUPS.reach) {
          this.take(bot, task.item);
          this.finish(bot);
        }
        return null;
      }
      case 'fish': {
        if (!arrived) return null;
        bot.fishT += dt;
        if (bot.fishT >= bot.fishAt) {
          if (this.ctx.rng.chance(bot.tune.fishSkill)) { bot.eco.items.fish++; bot.caught++; }
          bot.fishT = 0;
          bot.fishAt = fishRound(this.ctx.rng);
        }
        bot.fishing = true;
        return { aim: this.ctx.ponds[task.pond].water.clone(), label: 'рыбачит' };
      }
      case 'crystals': {
        if (!arrived) return null;
        const n = this.ctx.match.collect(pos);
        if (n > 0) { bot.wallet.crystal += n; bot.earned += n; bot.genWait = 0; }
        else bot.genWait += dt;
        if (bot.wallet.crystal >= 5) this.finish(bot);
        // empty for long: maybe the other one has some
        if (bot.genWait > 6 && this.ctx.match.generators.some((g, i) => i !== task.gen && g.stored > 0 && this.ctx.gens[i].face === this.ctx.gens[task.gen].face)) {
          bot.avoid.set(`gen${task.gen}`, this.ctx.match.time + 20);
          this.finish(bot);
        }
        return { label: 'ждёт кристаллы' };
      }
      case 'fortify': {
        if (!arrived) return null;
        bot.buildT -= dt;
        if (bot.buildT > 0) return { label: 'чинит укрепление' };
        bot.buildT = 0.4;
        for (const c of this.fortGap(bot.team)) {
          if (c.pos.distanceTo(pos) > 7.5) continue;
          if (this.ctx.combat.targets.some((t) => t.alive && t.center.distanceTo(c.pos) < 1.4)) continue;
          const m = pickMaterial(bot, c.material);
          if (!m) break;
          if (!this.ctx.blocks.isFree(c.pos)) continue;
          this.ctx.blocks.add(c.pos, m, bot.team);
          bot.kit[m]--;
          bot.built++;
          this.ctx.gaps.delete(bot.team);
          return { aim: c.pos.clone(), label: 'чинит укрепление' };
        }
        this.finish(bot);
        return null;
      }
      case 'rally': {
        if (!arrived) return null;
        const mates = this.ctx.bots.filter((m) => m !== bot && m.team === bot.team && m.target.alive && !m.out && m.task.kind === 'rally'
          && m.sim.state.pos.distanceTo(pos) < 10);
        if (mates.length || bot.taskT > bot.tune.rally) {
          for (const m of [bot, ...mates]) {
            m.goal = bot.goal;
            m.trip = bot.trip;
            this.setTask(m, { kind: 'raid' });
          }
        }
        return null;
      }
    }
    return null;
  }

  /** Pick up a pickup within reach. */
  take(bot: Bot, it: Pickup) {
    if (!this.ctx.loot || !it.alive) return;
    if (it.kind === 'medkit' && bot.eco.items.medkit >= MAX_MEDKITS) return;
    this.ctx.loot.take(it);
    if (it.kind === 'cash') { bot.wallet.cash += it.amount; bot.earned += it.amount; }
    else if (it.kind === 'ammo') refillAmmo(bot.weapons, Math.max(1, it.amount));
    else if (it.kind === 'wood' || it.kind === 'stone' || it.kind === 'metal') bot.kit[it.kind] += Math.max(1, it.amount);
    else bot.eco.items[it.kind] += Math.max(1, it.amount);
    bot.taken++;
  }

  /** Every tick, whatever the task: heal (medkit when badly hurt, apples), pick up what lies within reach, refill ammo near own crystal, sync jetpack/armor. */
  upkeep(bot: Bot, dt: number) {
    bot.eatT -= dt;
    bot.lootT -= dt;
    bot.nadeT -= dt;
    bot.rocketT -= dt;
    const tg = bot.target;
    const maxHp = tg.maxHp ?? Math.round(MAX_HP * MATCH_RULES.playerHp);
    bot.sim.hasJetpack = bot.eco.has('jetpack');
    bot.sim.hasJetpackFuel = totalFuelAmmo(bot.weapons) > 0;
    tg.armor = bot.eco.has('armor');
    if (bot.eatT <= 0) {
      if (tg.hp < bot.tune.healAt && bot.eco.take('medkit')) {
        tg.hp = maxHp;
        bot.eatT = 1.5;
        bot.pauseT = Math.max(bot.pauseT, 0.5);
      } else if (tg.hp < maxHp - ITEMS.apple.heal && bot.eco.take('apple')) {
        tg.hp = Math.min(maxHp, tg.hp + ITEMS.apple.heal);
        bot.eatT = EAT_COOLDOWN + 0.4;
      } else if (tg.hp < maxHp * 0.55 && bot.eco.take('fish')) {
        tg.hp = Math.min(maxHp, tg.hp + ITEMS.fish.heal);
        bot.eatT = EAT_COOLDOWN + 0.4;
      }
    }
    if (this.ctx.map.mode === 'skirmish' && this.ctx.match.isInsideBaseHall(bot.sim.state.pos, bot.team)) {
      bot.woodRegenT += dt;
      if (bot.woodRegenT >= 1) {
        const gain = Math.floor(bot.woodRegenT);
        bot.woodRegenT -= gain;
        bot.kit.wood += gain * SKIRMISH_WOOD_PER_SEC;
      }
    } else {
      bot.woodRegenT = 0;
    }
    if (bot.lootT <= 0) {
      bot.lootT = 0.25;
      const bed = this.ctx.match.bed(bot.team);
      if (bed.alive && bot.sim.state.pos.distanceTo(bed.pos) < 8.5) {
        refillAmmo(bot.weapons, 0.25);
      }
      if (this.ctx.loot) {
        const it = this.ctx.loot.nearest(bot.sim.state.pos);
        if (it && it.up.dot(tg.up) > 0.9) this.take(bot, it);
      }
    }
  }

  /** Out of wood at the end of a bridge: home to buy more, or (away from home) another way / another goal. */
  stranded(bot: Bot, loc: Ground) {
    bot.strandT = 0;
    if (bot.route?.lane) {
      bot.laneFailures.set(bot.route.lane.id, (bot.laneFailures.get(bot.route.lane.id) ?? 0) + 1);
    }
    if (loc.face === this.nav.teamFace(bot.team).id) {
      bot.rash = false;
      bot.departAt = Math.max(bot.departAt, this.ctx.match.time + 30);
      const s = this.shopOn(bot, loc.face);
      this.setTask(bot, s >= 0 ? { kind: 'shop', shop: s } : { kind: 'patrol' });
      return;
    }
    bot.strands++;
    bot.trip++;
    if (bot.strands >= 2) bot.goal = this.chooseGoal(bot);
    if (bot.strands > 3) this.ctx.placeAtSpawn(bot);
    bot.routeKey = '';
  }
}
