import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { BotManager } from '../shared/bots';
import { Combat, MAX_HP } from '../shared/combat';
import { EYE_OFFSET } from '../shared/constants';
import { escapeHtml } from '../shared/escape';
import { MATCH_RULES } from '../shared/lobby';
import { BED_HP, Match } from '../shared/match';
import { frameForUp } from '../shared/math';
import { viewQuat } from '../shared/movement';
import type { NpcManager } from '../shared/npcs';
import { getTeam, TEAMS, TeamId } from '../shared/teams';
import { WeaponId, WEAPONS } from '../shared/weapons';
import { teamHex } from './hud';
import type { Input } from './input';

export type SpectatorMode = 'player' | 'free' | 'auto';

export interface SpectatorHumanTarget {
  team: TeamId;
  alive: boolean;
  pos: Vector3;
  up: Vector3;
  frame: Quaternion;
  yaw: number;
  pitch: number;
  hp: number;
  maxHp?: number;
  name: string;
  weapon: string;
}

interface ActorView {
  key: string;
  team: TeamId;
  titleHtml: string;
  pos: Vector3;
  up: Vector3;
  frame: Quaternion;
  yaw: number;
  pitch: number;
  hp: number;
  maxHp: number;
  weapon: WeaponId;
  ammoText: string;
  status: string;
  taskKind: string;
  fishing: boolean;
  attacking: boolean;
}

const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _wantPos = new Vector3();
const _lookAt = new Vector3();
const _tmp = new Vector3();
const _q = new Quaternion();

interface DirectorEvent {
  kind: 'crystal' | 'assault' | 'duel' | 'npc' | 'raid' | 'shop' | 'fish' | 'loot';
  score: number;
  rawScore: number;
  title: string;
  subtitle: string;
  focusPos: Vector3;
  lookPos: Vector3;
  up: Vector3;
  team?: TeamId;
  actorKey?: string;
}

/**
 * Spectator system with 3 modes:
 * 1. `player` — Follow living players/bots (1st or 3rd-person orbit camera, switch with LMB/RMB or Q/E, 4–8 for teams).
 * 2. `free`   — Free flight (WASD + Space/Ctrl + Shift boost, [G] aligns gravity to nearest cube face / [R] resets).
 * 3. `auto`   — Weighted priority Esports Auto-Director switching at least every ~10s with real non-phantom events.
 */
export class SpectatorController {
  active = false;
  mode: SpectatorMode = 'auto';
  private targetIdx = 0;
  private firstPerson = false;
  private freeSpeed = 26;
  private readonly camPos = new Vector3(0, 40, 0);
  private readonly camLook = new Vector3(0, 0, 0);
  private readonly camUp = new Vector3(0, 1, 0);
  private readonly freeUp = new Vector3(0, 1, 0);
  private readonly freeFrame = new Quaternion();
  private readonly freeVel = new Vector3();
  private directorHoldT = 0;
  private directorElapsed = 0;
  private specClock = 0;
  private readonly prevActorHp = new Map<string, number>();
  private readonly recentCombatUntil = new Map<string, number>();
  private readonly eventCooldownUntil = new Map<string, number>();
  private currentEvent: DirectorEvent | null = null;
  private orbitAngle = 0;

  private readonly hudEl: HTMLElement;
  private readonly modeBadgeEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly teamsBarEl: HTMLElement | null;
  private htmlKey = '';

  constructor(
    private input: Input,
    private combat: Combat,
    private match: Match,
    private bots: BotManager,
    private getHumanTargets?: () => SpectatorHumanTarget[],
    private npcs?: NpcManager,
  ) {
    this.hudEl = document.getElementById('spectator-hud')!;
    this.modeBadgeEl = document.getElementById('spec-mode-badge')!;
    this.titleEl = document.getElementById('spec-title')!;
    this.subEl = document.getElementById('spec-sub')!;
    this.teamsBarEl = document.getElementById('spec-teams-bar');
  }

  enable(initialMode?: SpectatorMode, startPos?: Vector3, startUp?: Vector3) {
    if (initialMode) this.mode = initialMode;
    if (!this.active) {
      this.active = true;
      if (startPos) this.camPos.copy(startPos);
      if (startUp) {
        this.camUp.copy(startUp).normalize();
        this.freeUp.copy(this.camUp);
        this.freeFrame.copy(frameForUp(this.freeUp));
      }
      this.directorHoldT = 0;
      this.directorElapsed = 0;
    }
    this.input.onWheel = (dy) => {
      if (this.active && this.mode === 'free') {
        this.freeSpeed = Math.max(8, Math.min(120, this.freeSpeed - Math.sign(dy) * 6));
        return true;
      }
      return false;
    };
    document.body.classList.add('spectating');
    this.hudEl.hidden = false;
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    this.input.onWheel = () => false;
    document.body.classList.remove('spectating');
    this.hudEl.hidden = true;
  }

  setMode(m: SpectatorMode) {
    if (this.mode === m) return;
    this.mode = m;
    this.directorHoldT = 0;
    this.htmlKey = '';
  }

  private livingActors(): ActorView[] {
    const out: ActorView[] = [];
    const humans = this.getHumanTargets?.() ?? [];
    const defaultMaxHp = Math.max(10, Math.round(MAX_HP * MATCH_RULES.playerHp));
    for (const h of humans) {
      if (!h.alive) continue;
      const t = getTeam(h.team);
      const w: WeaponId = h.weapon in WEAPONS ? (h.weapon as WeaponId) : 'fists';
      const key = `h:${h.team}:${h.name}`;
      out.push({
        key,
        team: h.team,
        titleHtml: `<span style="color:${teamHex(t.color)}">${t.name}</span> · ${escapeHtml(h.name)}`,
        pos: h.pos,
        up: h.up,
        frame: h.frame,
        yaw: h.yaw,
        pitch: h.pitch,
        hp: h.hp,
        maxHp: h.maxHp ?? defaultMaxHp,
        weapon: w,
        ammoText: '',
        status: 'в бою',
        taskKind: 'fight',
        fishing: false,
        attacking: true,
      });
    }
    this.bots.bots.forEach((b, idx) => {
      if (!b.target.alive || b.out) return;
      const t = getTeam(b.team);
      const roleLabel = b.role === 'defend' ? 'Защитник' : 'Рейдер';
      out.push({
        key: `b:${b.id}`,
        team: b.team,
        titleHtml: `<span style="color:${teamHex(t.color)}">${t.name}</span> · Бот #${idx + 1} (${roleLabel}) · <span style="color:#7cf5ff">${b.wallet.cash}$</span>`,
        pos: b.sim.state.pos,
        up: b.target.up,
        frame: b.sim.state.frame,
        yaw: b.sim.state.yaw,
        pitch: b.sim.state.pitch,
        hp: b.target.hp,
        maxHp: b.target.maxHp ?? defaultMaxHp,
        weapon: b.weapons.current,
        ammoText: ` (${b.weapons.ammo[b.weapons.current]}/${b.weapons.reserve[b.weapons.current]})`,
        status: b.status || 'продвижение',
        taskKind: b.task.kind,
        fishing: b.fishing,
        attacking: b.role === 'attack' || b.task.kind === 'raid',
      });
    });
    return out;
  }

  cycleTarget(step: 1 | -1) {
    const list = this.livingActors();
    if (!list.length) return;
    this.targetIdx = (this.targetIdx + step + list.length) % list.length;
    this.htmlKey = '';
  }

  switchToTeam(team: TeamId) {
    const list = this.livingActors();
    const idx = list.findIndex((a) => a.team === team);
    if (idx >= 0) {
      this.mode = 'player';
      this.targetIdx = idx;
      this.htmlKey = '';
    }
  }

  update(dt: number, camera: PerspectiveCamera) {
    if (!this.active) {
      this.hudEl.hidden = true;
      return;
    }
    this.hudEl.hidden = false;
    this.specClock += dt;

    // Detect real recent damage/skirmishes so Director reacts only to genuine action
    for (const a of this.livingActors()) {
      const prev = this.prevActorHp.get(a.key);
      if (prev !== undefined && a.hp < prev - 0.5) {
        this.recentCombatUntil.set(a.key, this.specClock + 3.2);
      }
      this.prevActorHp.set(a.key, a.hp);
    }

    // Mode hotkeys while spectating
    if (this.input.locked) {
      if (this.input.take('Digit1')) this.setMode('player');
      if (this.input.take('Digit2')) this.setMode('free');
      if (this.input.take('Digit3')) this.setMode('auto');
      if (this.input.take('KeyV')) {
        this.firstPerson = !this.firstPerson;
        this.htmlKey = '';
      }
      if (this.mode === 'free') {
        if (this.input.take('KeyG')) this.alignFreeGravity(camera);
        if (this.input.take('KeyR')) {
          this.freeUp.set(0, 1, 0);
          this.freeFrame.copy(frameForUp(this.freeUp));
        }
      }
      for (let i = 0; i < TEAMS.length; i++) {
        if (this.input.take(`Digit${4 + i}`)) this.switchToTeam(TEAMS[i].id);
      }
      if (this.mode === 'player') {
        if (this.input.take('Mouse0') || this.input.take('KeyE') || this.input.take('ArrowRight')) this.cycleTarget(1);
        if (this.input.take('Mouse2') || this.input.take('KeyQ') || this.input.take('ArrowLeft')) this.cycleTarget(-1);
      }
    }

    if (this.mode === 'free') {
      this.updateFreeFlight(dt, camera);
    } else if (this.mode === 'player') {
      this.updateFollowPlayer(dt, camera);
    } else {
      this.updateAutoDirector(dt, camera);
    }
  }

  /** Align free-flight camera gravity UP vector to the cube face under/ahead of the camera. */
  private alignFreeGravity(camera: PerspectiveCamera) {
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const hit = this.combat.rayWorld(this.camPos, this.camPos.clone().addScaledVector(_fwd, 60));
    const v = hit ? hit.normal.clone() : this.camPos.clone().negate();
    const ax = Math.abs(v.x), ay = Math.abs(v.y), az = Math.abs(v.z);
    if (ax >= ay && ax >= az) this.freeUp.set(Math.sign(v.x) || 1, 0, 0);
    else if (ay >= az) this.freeUp.set(0, Math.sign(v.y) || 1, 0);
    else this.freeUp.set(0, 0, Math.sign(v.z) || 1);
    this.freeFrame.copy(frameForUp(this.freeUp));
  }

  private updateFreeFlight(dt: number, camera: PerspectiveCamera) {
    this.camUp.lerp(this.freeUp, Math.min(1, dt * 8)).normalize();
    viewQuat(frameForUp(this.camUp), this.input.yaw, this.input.pitch, camera.quaternion);
    camera.up.copy(this.camUp);

    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    _up.copy(this.camUp);

    const moveF = this.input.locked ? this.input.axis('KeyW', 'KeyS') : 0;
    const moveR = this.input.locked ? this.input.axis('KeyD', 'KeyA') : 0;
    const moveU = this.input.locked
      ? (this.input.down('Space') || this.input.down('KeyE') ? 1 : 0) - (this.input.down('ControlLeft') || this.input.down('KeyC') ? 1 : 0)
      : 0;
    const boost = this.input.locked && (this.input.down('ShiftLeft') || this.input.down('ShiftRight'))
      ? this.freeSpeed * 2.5
      : this.input.locked && (this.input.down('ControlLeft') || this.input.down('KeyC'))
      ? this.freeSpeed * 0.4
      : this.freeSpeed;

    _wantPos.set(0, 0, 0)
      .addScaledVector(_fwd, moveF * boost)
      .addScaledVector(_right, moveR * boost)
      .addScaledVector(_up, moveU * boost);

    this.freeVel.lerp(_wantPos, Math.min(1, dt * 8));
    this.camPos.addScaledVector(this.freeVel, dt);
    camera.position.copy(this.camPos);
    camera.updateMatrixWorld();

    this.updateTeamsBar();
    this.renderBanner(
      'СВОБОДНЫЙ ПОЛЁТ',
      'Свободная камера обзора арены',
      `Скорость: ${Math.round(this.freeVel.length())} м/с · [G] Гравитация грани · [R] Мир +Y · WASD + Колёсико`,
      '#8af5ff',
    );
  }

  private updateFollowPlayer(dt: number, camera: PerspectiveCamera) {
    const list = this.livingActors();
    if (!list.length) {
      this.updateFreeFlight(dt, camera);
      return;
    }
    this.targetIdx = ((this.targetIdx % list.length) + list.length) % list.length;
    const actor = list[this.targetIdx];
    const up = actor.up.clone().normalize();

    if (this.firstPerson) {
      _lookAt.copy(actor.pos).addScaledVector(up, EYE_OFFSET);
      camera.position.copy(_lookAt);
      viewQuat(actor.frame, actor.yaw, actor.pitch, camera.quaternion);
      camera.up.copy(up);
      camera.updateMatrixWorld();
    } else {
      this.camUp.lerp(up, Math.min(1, dt * 7)).normalize();

      const ref = Math.abs(this.camUp.y) < 0.9 ? _tmp.set(0, 1, 0) : _tmp.set(1, 0, 0);
      _right.crossVectors(ref, this.camUp).normalize();
      _fwd.crossVectors(this.camUp, _right).normalize();

      const yaw = this.input.yaw;
      const pitch = Math.max(-0.9, Math.min(0.85, this.input.pitch));
      const cosP = Math.cos(pitch);
      const dir = new Vector3()
        .addScaledVector(_fwd, Math.cos(yaw) * cosP)
        .addScaledVector(_right, Math.sin(yaw) * cosP)
        .addScaledVector(this.camUp, -Math.sin(pitch))
        .normalize();

      _lookAt.copy(actor.pos).addScaledVector(up, 0.75);
      _wantPos.copy(_lookAt).addScaledVector(dir, -5.2).addScaledVector(up, 1.3);

      const hit = this.combat.rayWorld(_lookAt, _wantPos);
      if (hit && hit.t < 1) {
        _wantPos.lerpVectors(_lookAt, _wantPos, Math.max(0.15, hit.t - 0.15));
      }

      this.camPos.lerp(_wantPos, Math.min(1, dt * 12));
      this.camLook.lerp(_lookAt, Math.min(1, dt * 15));
      camera.position.copy(this.camPos);
      camera.up.copy(this.camUp);
      camera.lookAt(this.camLook);
      camera.updateMatrixWorld();
    }

    const team = getTeam(actor.team);
    const hpPct = Math.max(0, Math.min(100, Math.round((actor.hp / Math.max(1, actor.maxHp)) * 100)));
    const wName = WEAPONS[actor.weapon].name;
    const viewLabel = this.firstPerson ? '1-Е ЛИЦО' : '3-Е ЛИЦО';
    this.updateTeamsBar(actor.team);
    this.renderBanner(
      `НАБЛЮДЕНИЕ · ${viewLabel}`,
      actor.titleHtml,
      `HP: ${hpPct}% · Оружие: ${wName}${actor.ammoText} · [V] 1-е/3-е лицо · [ЛКМ/ПКМ] следующий`,
      teamHex(team.color),
    );
  }

  private updateAutoDirector(dt: number, camera: PerspectiveCamera) {
    if (this.match.result) {
      const winner = this.match.beds.find((b) => b.alive || this.match.membersAlive(b.team) > 0);
      const wTeam = winner ? getTeam(winner.team) : null;
      this.updateTeamsBar();
      this.renderBanner(
        '🏆 МАТЧ ЗАВЕРШЁН',
        wTeam ? `Победа команды <span style="color:${teamHex(wTeam.color)}">${wTeam.name}</span>!` : 'Матч окончен!',
        'Все вражеские кристаллы и бойцы повержены',
        wTeam ? teamHex(wTeam.color) : '#ffd700',
      );
      return;
    }

    this.directorHoldT -= dt;
    this.directorElapsed += dt;
    this.orbitAngle += dt * 0.32;

    const best = this.pickBestEvent();
    const livingKeys = this.currentEvent?.actorKey ? new Set(this.livingActors().map((a) => a.key)) : null;
    const staleSwitch = this.directorElapsed >= 9.5;
    const interrupt = best && this.currentEvent && this.directorElapsed >= 2.2 && best.rawScore >= this.currentEvent.rawScore + 12;
    const targetGone = this.currentEvent?.actorKey && this.currentEvent.kind !== 'npc' && !livingKeys?.has(this.currentEvent.actorKey);

    if (!this.currentEvent || staleSwitch || interrupt || (this.directorHoldT <= 0 && best && best.actorKey !== this.currentEvent.actorKey) || targetGone) {
      if (best) {
        if (this.currentEvent?.actorKey && staleSwitch) {
          this.eventCooldownUntil.set(this.currentEvent.actorKey, this.specClock + 15);
        }
        this.currentEvent = best;
        this.directorHoldT = 4.5;
        this.directorElapsed = 0;
      }
    } else if (best && best.kind === this.currentEvent.kind && best.actorKey === this.currentEvent.actorKey) {
      // Refresh live coordinates of the same event
      this.currentEvent.focusPos.copy(best.focusPos);
      this.currentEvent.lookPos.copy(best.lookPos);
      this.currentEvent.up.copy(best.up);
      this.currentEvent.rawScore = best.rawScore;
      this.currentEvent.title = best.title;
      this.currentEvent.subtitle = best.subtitle;
    }

    const ev = this.currentEvent;
    if (!ev) {
      this.updateFreeFlight(dt, camera);
      return;
    }

    const up = ev.up.clone().normalize();
    this.camUp.lerp(up, Math.min(1, dt * 4.5)).normalize();

    const ref = Math.abs(this.camUp.y) < 0.9 ? _tmp.set(0, 1, 0) : _tmp.set(1, 0, 0);
    _right.crossVectors(ref, this.camUp).normalize();
    _fwd.crossVectors(this.camUp, _right).normalize();

    const dist = ev.kind === 'crystal' || ev.kind === 'assault' ? 9.5 : ev.kind === 'duel' || ev.kind === 'npc' ? 7.2 : 6.0;
    const height = ev.kind === 'crystal' || ev.kind === 'assault' ? 4.2 : 2.8;
    _wantPos.copy(ev.focusPos)
      .addScaledVector(_fwd, Math.cos(this.orbitAngle) * dist)
      .addScaledVector(_right, Math.sin(this.orbitAngle) * dist)
      .addScaledVector(up, height);

    const hit = this.combat.rayWorld(ev.lookPos, _wantPos);
    if (hit && hit.t < 1) {
      _wantPos.lerpVectors(ev.lookPos, _wantPos, Math.max(0.2, hit.t - 0.12));
    }

    this.camPos.lerp(_wantPos, Math.min(1, dt * 4.0));
    this.camLook.lerp(ev.lookPos, Math.min(1, dt * 6.5));

    camera.position.copy(this.camPos);
    camera.up.copy(this.camUp);
    camera.lookAt(this.camLook);
    camera.updateMatrixWorld();

    const pts = Math.round(ev.rawScore);
    const badge = ev.kind === 'crystal' ? `🔥 АТАКА КРИСТАЛЛА · ${pts} б.`
      : ev.kind === 'assault' ? `⚡ ШТУРМ БАЗЫ · ${pts} б.`
      : ev.kind === 'duel' ? `⚔️ ПЕРЕСТРЕЛКА · ${pts} б.`
      : ev.kind === 'npc' ? `💥 СТЫЧКА В ГОРОДЕ · ${pts} б.`
      : ev.kind === 'raid' ? `🚀 РЕЙД · ${pts} б.`
      : ev.kind === 'shop' ? `🛒 ЗАКУПКА · ${pts} б.`
      : ev.kind === 'fish' ? `🎣 РЫБАЛКА · ${pts} б.`
      : `🍎 ЛУТ И ОБЗОР · ${pts} б.`;
    const color = ev.kind === 'crystal' ? '#ff5a5a'
      : ev.kind === 'assault' ? '#ff9248'
      : ev.kind === 'duel' ? '#ffd23b'
      : ev.kind === 'npc' ? '#ff70c0'
      : '#2ff3e0';
    this.updateTeamsBar(ev.team);
    this.renderBanner(badge, ev.title, ev.subtitle, color);
  }

  private updateTeamsBar(activeTeam?: TeamId) {
    if (!this.teamsBarEl) return;
    const humans = this.getHumanTargets?.() ?? [];
    let html = '';
    for (const bed of this.match.beds) {
      const t = getTeam(bed.team);
      const livingBots = this.bots.bots.filter((b) => b.team === bed.team && b.target.alive && !b.out).length;
      const totalBots = this.bots.bots.filter((b) => b.team === bed.team).length;
      const livingHumans = humans.filter((h) => h.team === bed.team && h.alive).length;
      const totalHumans = humans.filter((h) => h.team === bed.team).length;
      const living = livingBots + livingHumans;
      const total = totalBots + totalHumans;
      const isOut = !bed.alive && living === 0;
      const isActive = activeTeam === bed.team;
      const color = teamHex(t.color);
      const maxHp = bed.maxHp ?? BED_HP;
      const bedText = !bed.alive
        ? '❌ Разрушен'
        : bed.invulnT > 0
        ? `💥 ${Math.ceil(bed.invulnT)}с`
        : `💎 ${Math.min(100, Math.ceil((bed.hp / maxHp) * 100))}%`;
      html += `<div class="spec-team-chip ${isActive ? 'active' : ''} ${isOut ? 'out' : ''}" style="--chip-c:${color}" data-team="${bed.team}">
        <span class="dot"></span>
        <span>${t.name}</span>
        <span class="bed-status">${bedText}</span>
        <span style="opacity:0.75">👥${living}/${total}</span>
      </div>`;
    }
    if (this.teamsBarEl.innerHTML !== html) {
      this.teamsBarEl.innerHTML = html;
      this.teamsBarEl.querySelectorAll('.spec-team-chip').forEach((el) => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const team = (el as HTMLElement).dataset.team as TeamId;
          if (team) this.switchToTeam(team);
        });
      });
    }
  }

  private pickBestEvent(): DirectorEvent | null {
    let best: DirectorEvent | null = null;
    const consider = (ev: Omit<DirectorEvent, 'score'> & { score?: number }) => {
      const cooldown = ev.actorKey && (this.eventCooldownUntil.get(ev.actorKey) ?? 0) > this.specClock ? -22 : 0;
      const weighted: DirectorEvent = { ...ev, score: ev.rawScore + cooldown };
      if (!best || weighted.score > best.score) best = weighted;
    };

    const living = this.livingActors();

    // 1. Real crystal attacks / Stage-1 detonation ONLY when crystal actually took damage recently or is detonating (40–65 pts)
    for (const bed of this.match.beds) {
      if (!bed.alive) continue;
      const t = getTeam(bed.team);
      const maxHp = bed.maxHp ?? BED_HP;
      if (bed.invulnT > 0) {
        consider({
          kind: 'crystal',
          rawScore: 52 + (10 - bed.invulnT) * 1.4,
          title: `Кристалл <span style="color:${teamHex(t.color)}">${t.name}</span> детонирует!`,
          subtitle: `Взрыв I стадии и возрождение через ${Math.ceil(bed.invulnT)} с`,
          focusPos: bed.pos.clone(),
          lookPos: bed.pos.clone().addScaledVector(bed.up, 1.5),
          up: bed.up.clone(),
          team: bed.team,
          actorKey: `crystal:${bed.team}`,
        });
      } else if (bed.hp < maxHp - 0.5 && bed.calm < 2.8) {
        const pct = Math.max(1, Math.min(99, Math.ceil((bed.hp / maxHp) * 100)));
        consider({
          kind: 'crystal',
          rawScore: 42 + (1 - bed.hp / maxHp) * 15,
          title: `Урон по кристаллу: <span style="color:${teamHex(t.color)}">${t.name}</span>`,
          subtitle: `Стадия ${bed.stage === 1 ? 'I' : 'II'} · Осталось ${pct}% прочности`,
          focusPos: bed.pos.clone(),
          lookPos: bed.pos.clone().addScaledVector(bed.up, 1.2),
          up: bed.up.clone(),
          team: bed.team,
          actorKey: `crystal:${bed.team}`,
        });
      }

      // 2. Genuine Base Storm (20 pts): enemy ACTUALLY inside 15 m of a living enemy crystal! (Never phantom!)
      for (const a of living) {
        if (a.team === bed.team) continue;
        if (a.pos.distanceTo(bed.pos) < 15) {
          const aTeam = getTeam(a.team);
          consider({
            kind: 'assault',
            rawScore: 20 + (this.recentCombatUntil.get(a.key) ?? 0 > this.specClock ? 4 : 0),
            title: `<span style="color:${teamHex(aTeam.color)}">${aTeam.name}</span> штурмует базу <span style="color:${teamHex(t.color)}">${t.name}</span>`,
            subtitle: `Атакующий в ${Math.round(a.pos.distanceTo(bed.pos))} м от кристалла · ${WEAPONS[a.weapon].name}`,
            focusPos: a.pos.clone(),
            lookPos: bed.pos.clone().addScaledVector(bed.up, 1.0),
            up: bed.up.clone(),
            team: bed.team,
            actorKey: `assault:${bed.team}:${a.key}`,
          });
        }
      }
    }

    // 3. Firefights / Duels (15–30 pts) & Raiders / Shops / Fishing (2 pts) / Looting (1 pt)
    for (const b of living) {
      const bTeam = getTeam(b.team);
      let nearestEnemy: ActorView | null = null;
      let nearestDist = 26;
      for (const other of living) {
        if (other.team === b.team) continue;
        const d = b.pos.distanceTo(other.pos);
        if (d < nearestDist) {
          nearestDist = d;
          nearestEnemy = other;
        }
      }
      const inActiveShot = (this.recentCombatUntil.get(b.key) ?? 0) > this.specClock;
      if (nearestEnemy) {
        const eTeam = getTeam(nearestEnemy.team);
        const mid = b.pos.clone().lerp(nearestEnemy.pos, 0.5);
        const enemyHurt = (this.recentCombatUntil.get(nearestEnemy.key) ?? 0) > this.specClock;
        const lowHpBonus = (200 - b.hp - nearestEnemy.hp) * 0.04;
        const fireBonus = inActiveShot || enemyHurt ? 6 : 0;
        const rawScore = Math.min(30, 15 + (26 - nearestDist) * 0.35 + fireBonus + lowHpBonus);
        consider({
          kind: 'duel',
          rawScore,
          title: `<span style="color:${teamHex(bTeam.color)}">${bTeam.name}</span> vs <span style="color:${teamHex(eTeam.color)}">${eTeam.name}</span>`,
          subtitle: `Перестрелка (${Math.round(nearestDist)} м) · ${WEAPONS[b.weapon].name} и ${WEAPONS[nearestEnemy.weapon].name}`,
          focusPos: mid,
          lookPos: mid.clone().addScaledVector(b.up, 0.7),
          up: b.up.clone(),
          team: b.team,
          actorKey: b.key,
        });
      } else if (b.attacking) {
        consider({
          kind: 'raid',
          rawScore: b.weapon !== 'fists' ? 8 : 6,
          title: `Рейд: <span style="color:${teamHex(bTeam.color)}">${bTeam.name}</span> (${WEAPONS[b.weapon].name})`,
          subtitle: `${b.status} · HP ${Math.round(b.hp)}%`,
          focusPos: b.pos.clone(),
          lookPos: b.pos.clone().addScaledVector(b.up, 0.8),
          up: b.up.clone(),
          team: b.team,
          actorKey: b.key,
        });
      } else if (b.taskKind === 'shop') {
        consider({
          kind: 'shop',
          rawScore: 3,
          title: `Лавка команды <span style="color:${teamHex(bTeam.color)}">${bTeam.name}</span>`,
          subtitle: `${b.status} · ${WEAPONS[b.weapon].name}`,
          focusPos: b.pos.clone(),
          lookPos: b.pos.clone().addScaledVector(b.up, 0.8),
          up: b.up.clone(),
          team: b.team,
          actorKey: b.key,
        });
      } else if (b.fishing) {
        consider({
          kind: 'fish',
          rawScore: 2,
          title: `Рыбалка: <span style="color:${teamHex(bTeam.color)}">${bTeam.name}</span>`,
          subtitle: 'Ловля рыбы на берегу для заработка',
          focusPos: b.pos.clone(),
          lookPos: b.pos.clone().addScaledVector(b.up, 0.7),
          up: b.up.clone(),
          team: b.team,
          actorKey: b.key,
        });
      } else {
        consider({
          kind: 'loot',
          rawScore: 1,
          title: `<span style="color:${teamHex(bTeam.color)}">${bTeam.name}</span> · Сбор и разведка`,
          subtitle: `${b.status} · HP ${Math.round(b.hp)}%`,
          focusPos: b.pos.clone(),
          lookPos: b.pos.clone().addScaledVector(b.up, 0.8),
          up: b.up.clone(),
          team: b.team,
          actorKey: b.key,
        });
      }
    }

    // 4. City bandit / street skirmishes (10–13 pts)
    if (this.npcs) {
      for (const n of this.npcs.npcs) {
        if (!n.target.alive || n.state !== 'combat' || !n.foe?.alive) continue;
        const pos = n.sim.state.pos;
        const up = new Vector3(0, 1, 0).applyQuaternion(n.sim.state.frame);
        consider({
          kind: 'npc',
          rawScore: 12,
          title: 'Зачистка в городе · Бандиты в бою',
          subtitle: 'Уличная перестрелка с вооружённой бандой',
          focusPos: pos.clone(),
          lookPos: pos.clone().addScaledVector(up, 0.8),
          up,
          actorKey: `npc:${n.target.id}`,
        });
        break;
      }
    }

    return best;
  }

  private renderBanner(badge: string, titleHtml: string, subText: string, accent: string) {
    const key = `${this.mode}|${badge}|${titleHtml}|${subText}|${accent}`;
    if (key === this.htmlKey) return;
    this.htmlKey = key;
    this.modeBadgeEl.textContent = badge;
    this.modeBadgeEl.style.setProperty('--spec-c', accent);
    this.titleEl.innerHTML = titleHtml;
    this.subEl.textContent = subText;
  }
}
