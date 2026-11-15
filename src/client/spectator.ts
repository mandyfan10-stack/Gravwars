import { Euler, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { BotManager } from '../shared/bots';
import { Combat, MAX_HP } from '../shared/combat';
import { EYE_OFFSET } from '../shared/constants';
import { escapeHtml } from '../shared/escape';
import { BED_HP, Match } from '../shared/match';
import { viewQuat } from '../shared/movement';
import { getTeam, TeamId } from '../shared/teams';
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
  name: string;
  weapon: string;
}

interface ActorView {
  team: TeamId;
  titleHtml: string;
  pos: Vector3;
  up: Vector3;
  frame: Quaternion;
  yaw: number;
  pitch: number;
  hp: number;
  weapon: WeaponId;
  ammoText: string;
  status: string;
  attacking: boolean;
}

const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _wantPos = new Vector3();
const _lookAt = new Vector3();
const _tmp = new Vector3();
const _q = new Quaternion();
const _euler = new Euler();

interface DirectorEvent {
  kind: 'crystal' | 'duel' | 'raid' | 'patrol';
  score: number;
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
 * 1. `player` — Follow living players/bots (third-person orbit camera, switch with LMB/RMB or Q/E).
 * 2. `free`   — Free flight (6-DOF camera movement with WASD + Space/Ctrl + Shift boost).
 * 3. `auto`   — Esports Auto-Director that detects live combat, crystal attacks, and duels on the map and switches between them automatically.
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
  private readonly freeVel = new Vector3();
  private directorHoldT = 0;
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
      if (startUp) this.camUp.copy(startUp);
      this.directorHoldT = 0;
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
    for (const h of humans) {
      if (!h.alive) continue;
      const t = getTeam(h.team);
      const w: WeaponId = h.weapon in WEAPONS ? (h.weapon as WeaponId) : 'fists';
      out.push({
        team: h.team,
        titleHtml: `<span style="color:${teamHex(t.color)}">${t.name}</span> · ${escapeHtml(h.name)}`,
        pos: h.pos,
        up: h.up,
        frame: h.frame,
        yaw: h.yaw,
        pitch: h.pitch,
        hp: h.hp,
        weapon: w,
        ammoText: '',
        status: 'в бою',
        attacking: true,
      });
    }
    this.bots.bots.forEach((b, idx) => {
      if (!b.target.alive || b.out) return;
      const t = getTeam(b.team);
      const roleLabel = b.role === 'defend' ? 'Защитник' : 'Рейдер';
      out.push({
        team: b.team,
        titleHtml: `<span style="color:${teamHex(t.color)}">${t.name}</span> · Бот #${idx + 1} (${roleLabel}) · <span style="color:#7cf5ff">${b.wallet.cash}$</span>`,
        pos: b.sim.state.pos,
        up: b.target.up,
        frame: b.sim.state.frame,
        yaw: b.sim.state.yaw,
        pitch: b.sim.state.pitch,
        hp: b.target.hp,
        weapon: b.weapons.current,
        ammoText: ` (${b.weapons.ammo[b.weapons.current]}/${b.weapons.reserve[b.weapons.current]})`,
        status: b.status || 'продвижение',
        attacking: b.role === 'attack',
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

    // Mode hotkeys while spectating
    if (this.input.locked) {
      if (this.input.take('Digit1')) this.setMode('player');
      if (this.input.take('Digit2')) this.setMode('free');
      if (this.input.take('Digit3')) this.setMode('auto');
      if (this.input.take('KeyV')) {
        this.firstPerson = !this.firstPerson;
        this.htmlKey = '';
      }
      const teamKeys: TeamId[] = ['red', 'blue', 'green', 'yellow'];
      for (let i = 0; i < teamKeys.length; i++) {
        if (this.input.take(`Digit${4 + i}`)) this.switchToTeam(teamKeys[i]);
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

  private updateFreeFlight(dt: number, camera: PerspectiveCamera) {
    // Orient camera from mouse yaw/pitch in world space
    _euler.set(this.input.pitch, this.input.yaw, 0, 'YXZ');
    _q.setFromEuler(_euler);
    camera.quaternion.copy(_q);
    camera.up.set(0, 1, 0);

    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    _up.set(0, 1, 0);

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
      `Скорость: ${Math.round(this.freeVel.length())} м/с (Базовая: ${Math.round(this.freeSpeed)} м/с, Колёсико: настроить) · WASD + Shift/Ctrl`,
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
    const hpPct = Math.max(0, Math.round((actor.hp / MAX_HP) * 100));
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
    this.orbitAngle += dt * 0.32;

    const best = this.pickBestEvent();
    const livingKeys = this.currentEvent?.actorKey ? new Set(this.livingActors().map((a) => a.titleHtml)) : null;
    // Switch immediately if current event ended or a major event (score +22 higher) erupted, or hold timer expired
    if (
      !this.currentEvent ||
      this.directorHoldT <= 0 ||
      (best && best.score > this.currentEvent.score + 22) ||
      (this.currentEvent.actorKey && !livingKeys?.has(this.currentEvent.actorKey))
    ) {
      if (best) {
        this.currentEvent = best;
        this.directorHoldT = best.kind === 'crystal' ? 5.0 : 4.2;
      }
    } else if (best && best.kind === this.currentEvent.kind && best.actorKey === this.currentEvent.actorKey) {
      // Refresh live coordinates of the same event
      this.currentEvent.focusPos.copy(best.focusPos);
      this.currentEvent.lookPos.copy(best.lookPos);
      this.currentEvent.up.copy(best.up);
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

    const dist = ev.kind === 'crystal' ? 9.5 : ev.kind === 'duel' ? 7.2 : 6.0;
    const height = ev.kind === 'crystal' ? 4.2 : 2.8;
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

    const badge = ev.kind === 'crystal' ? '🔥 LIVE · АТАКА КРИСТАЛЛА'
      : ev.kind === 'duel' ? '⚔️ LIVE · СХВАТКА НА КАРТЕ'
      : ev.kind === 'raid' ? '🚀 LIVE · ПРОРЫВ РЕЙДЕРА'
      : '🎥 АВТОРЕЖИССЁР · ОБЗОР МАТЧА';
    const color = ev.kind === 'crystal' ? '#ff5a5a' : ev.kind === 'duel' ? '#ffd23b' : '#2ff3e0';
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
      const bedText = !bed.alive
        ? '❌ Разрушен'
        : bed.invulnT > 0
        ? `💥 ${Math.ceil(bed.invulnT)}с`
        : `💎 ${Math.ceil((bed.hp / BED_HP) * 100)}%`;
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
    const consider = (ev: DirectorEvent) => {
      if (!best || ev.score > best.score) best = ev;
    };

    // 1. Check crystals in invulnerability stage (about to explode!) or taking damage
    for (const bed of this.match.beds) {
      if (!bed.alive) continue;
      const t = getTeam(bed.team);
      if (bed.invulnT > 0) {
        consider({
          kind: 'crystal',
          score: 120 + (10 - bed.invulnT) * 3,
          title: `Кристалл команды <span style="color:${teamHex(t.color)}">${t.name}</span> детонирует!`,
          subtitle: `Стадия I разрушена · Неуязвимость и взрыв через ${Math.ceil(bed.invulnT)} с (воскрешение павших)`,
          focusPos: bed.pos.clone(),
          lookPos: bed.pos.clone().addScaledVector(bed.up, 1.5),
          up: bed.up.clone(),
        });
      } else if (bed.calm < 2.2) {
        const pct = Math.ceil((bed.hp / BED_HP) * 100);
        consider({
          kind: 'crystal',
          score: 95 + (1 - bed.hp / BED_HP) * 25,
          title: `Штурм кристалла: <span style="color:${teamHex(t.color)}">${t.name}</span>!`,
          subtitle: `Стадия ${bed.stage === 1 ? 'I' : 'II'} · Осталось ${pct}% прочности`,
          focusPos: bed.pos.clone(),
          lookPos: bed.pos.clone().addScaledVector(bed.up, 1.2),
          up: bed.up.clone(),
        });
      }
    }

    // 2. Check fighters (humans + bots) in active duels or raiding
    const living = this.livingActors();
    for (const b of living) {
      const bTeam = getTeam(b.team);
      // Find closest enemy fighter within 26m
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
      if (nearestEnemy) {
        const eTeam = getTeam(nearestEnemy.team);
        const mid = b.pos.clone().lerp(nearestEnemy.pos, 0.5);
        const lowHpBonus = (200 - b.hp - nearestEnemy.hp) * 0.25;
        consider({
          kind: 'duel',
          score: 65 + (26 - nearestDist) * 1.4 + lowHpBonus,
          title: `<span style="color:${teamHex(bTeam.color)}">${bTeam.name}</span> vs <span style="color:${teamHex(eTeam.color)}">${eTeam.name}</span>`,
          subtitle: `Дистанция боя: ${Math.round(nearestDist)} м · ${WEAPONS[b.weapon].name} против ${WEAPONS[nearestEnemy.weapon].name}`,
          focusPos: mid,
          lookPos: mid.clone().addScaledVector(b.up, 0.7),
          up: b.up.clone(),
          team: b.team,
          actorKey: b.titleHtml,
        });
      } else if (b.attacking) {
        consider({
          kind: 'raid',
          score: 35 + (b.weapon !== 'fists' ? 12 : 0),
          title: `Рейд: <span style="color:${teamHex(bTeam.color)}">${bTeam.name}</span> (${WEAPONS[b.weapon].name})`,
          subtitle: `Задача: ${b.status} · HP ${Math.round(b.hp)}%`,
          focusPos: b.pos.clone(),
          lookPos: b.pos.clone().addScaledVector(b.up, 0.8),
          up: b.up.clone(),
          team: b.team,
          actorKey: b.titleHtml,
        });
      } else {
        consider({
          kind: 'patrol',
          score: 20,
          title: `Оборона базы: <span style="color:${teamHex(bTeam.color)}">${bTeam.name}</span>`,
          subtitle: `Задача: ${b.status} · HP ${Math.round(b.hp)}%`,
          focusPos: b.pos.clone(),
          lookPos: b.pos.clone().addScaledVector(b.up, 0.8),
          up: b.up.clone(),
          team: b.team,
          actorKey: b.titleHtml,
        });
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
