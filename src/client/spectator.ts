import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { Bot, BotManager } from '../shared/bots';
import { Combat, MAX_HP } from '../shared/combat';
import { EYE_OFFSET } from '../shared/constants';
import { BED_HP, Match } from '../shared/match';
import { viewQuat } from '../shared/movement';
import { getTeam, TeamId } from '../shared/teams';
import { WEAPONS } from '../shared/weapons';
import { teamHex } from './hud';
import type { Input } from './input';

export type SpectatorMode = 'player' | 'free' | 'auto';

const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _wantPos = new Vector3();
const _lookAt = new Vector3();
const _tmp = new Vector3();
const _q = new Quaternion();

interface DirectorEvent {
  kind: 'crystal' | 'duel' | 'raid' | 'patrol';
  score: number;
  title: string;
  subtitle: string;
  focusPos: Vector3;
  lookPos: Vector3;
  up: Vector3;
  bot?: Bot;
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

  private livingBots(): Bot[] {
    return this.bots.bots.filter((b) => b.target.alive && !b.out);
  }

  cycleTarget(step: 1 | -1) {
    const list = this.livingBots();
    if (!list.length) return;
    this.targetIdx = (this.targetIdx + step + list.length) % list.length;
    this.htmlKey = '';
  }

  switchToTeam(team: TeamId) {
    const list = this.livingBots();
    const idx = list.findIndex((b) => b.team === team);
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
    _q.setFromEuler(
      new ( camera.rotation.constructor as any )(this.input.pitch, this.input.yaw, 0, 'YXZ'),
    );
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
    const list = this.livingBots();
    if (!list.length) {
      this.updateFreeFlight(dt, camera);
      return;
    }
    this.targetIdx = ((this.targetIdx % list.length) + list.length) % list.length;
    const bot = list[this.targetIdx];
    const up = bot.target.up.clone().normalize();

    if (this.firstPerson) {
      // 1st person: exact position and look from the bot's eyes
      _lookAt.copy(bot.sim.state.pos).addScaledVector(up, EYE_OFFSET);
      camera.position.copy(_lookAt);
      viewQuat(bot.sim.state.frame, bot.sim.state.yaw, bot.sim.state.pitch, camera.quaternion);
      camera.up.copy(up);
      camera.updateMatrixWorld();
    } else {
      // 3rd person: smooth orbital camera around the bot
      this.camUp.lerp(up, Math.min(1, dt * 7)).normalize();

      // Build orbit basis around the bot's local up vector
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

      _lookAt.copy(bot.target.center).addScaledVector(up, 0.75);
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

    const team = getTeam(bot.team);
    const botIndex = this.bots.bots.indexOf(bot) + 1;
    const roleLabel = bot.role === 'defend' ? 'Защитник' : 'Рейдер';
    const hpPct = Math.max(0, Math.round((bot.target.hp / MAX_HP) * 100));
    const wName = WEAPONS[bot.weapons.current].name;
    const viewLabel = this.firstPerson ? '1-Е ЛИЦО' : '3-Е ЛИЦО';
    this.updateTeamsBar(bot);
    this.renderBanner(
      `НАБЛЮДЕНИЕ · ${viewLabel}`,
      `<span style="color:${teamHex(team.color)}">${team.name}</span> · Бот #${botIndex} (${roleLabel}) · <span style="color:#7cf5ff">${bot.wallet.cash}$</span>`,
      `HP: ${hpPct}% · Оружие: ${wName} (${bot.weapons.ammo[bot.weapons.current]}/${bot.weapons.reserve[bot.weapons.current]}) · [V] 1-е/3-е лицо · [ЛКМ/ПКМ] другой бот`,
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
    // Switch immediately if current event ended or a major event (score +25 higher) erupted, or hold timer expired
    if (
      !this.currentEvent ||
      this.directorHoldT <= 0 ||
      (best && best.score > this.currentEvent.score + 22) ||
      (this.currentEvent.bot && !this.currentEvent.bot.target.alive)
    ) {
      if (best) {
        this.currentEvent = best;
        this.directorHoldT = best.kind === 'crystal' ? 5.0 : 4.2;
      }
    } else if (best && best.kind === this.currentEvent.kind && best.bot === this.currentEvent.bot) {
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
    this.updateTeamsBar(ev?.bot);
    this.renderBanner(badge, ev.title, ev.subtitle, color);
  }

  private updateTeamsBar(activeBot?: Bot) {
    if (!this.teamsBarEl) return;
    let html = '';
    for (const bed of this.match.beds) {
      const t = getTeam(bed.team);
      const living = this.bots.bots.filter((b) => b.team === bed.team && b.target.alive && !b.out).length;
      const total = this.bots.bots.filter((b) => b.team === bed.team).length;
      const isOut = !bed.alive && living === 0;
      const isActive = activeBot?.team === bed.team;
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

    // 2. Check bots in active duels or raiding
    const living = this.livingBots();
    for (const b of living) {
      const bTeam = getTeam(b.team);
      // Find closest enemy fighter within 26m
      let nearestEnemy: Bot | null = null;
      let nearestDist = 26;
      for (const other of living) {
        if (other.team === b.team) continue;
        const d = b.target.center.distanceTo(other.target.center);
        if (d < nearestDist) {
          nearestDist = d;
          nearestEnemy = other;
        }
      }
      if (nearestEnemy) {
        const eTeam = getTeam(nearestEnemy.team);
        const mid = b.target.center.clone().lerp(nearestEnemy.target.center, 0.5);
        const lowHpBonus = (200 - b.target.hp - nearestEnemy.target.hp) * 0.25;
        consider({
          kind: 'duel',
          score: 65 + (26 - nearestDist) * 1.4 + lowHpBonus,
          title: `<span style="color:${teamHex(bTeam.color)}">${bTeam.name}</span> vs <span style="color:${teamHex(eTeam.color)}">${eTeam.name}</span>`,
          subtitle: `Дистанция боя: ${Math.round(nearestDist)} м · ${WEAPONS[b.weapons.current].name} против ${WEAPONS[nearestEnemy.weapons.current].name}`,
          focusPos: mid,
          lookPos: mid.clone().addScaledVector(b.target.up, 0.7),
          up: b.target.up.clone(),
          bot: b,
        });
      } else if (b.role === 'attack') {
        consider({
          kind: 'raid',
          score: 35 + (b.weapons.current !== 'fists' ? 12 : 0),
          title: `Рейд: <span style="color:${teamHex(bTeam.color)}">${bTeam.name}</span> (${WEAPONS[b.weapons.current].name})`,
          subtitle: `Задача: ${b.status || 'продвижение к вражеской базе'} · HP ${Math.round(b.target.hp)}%`,
          focusPos: b.target.center.clone(),
          lookPos: b.target.center.clone().addScaledVector(b.target.up, 0.8),
          up: b.target.up.clone(),
          bot: b,
        });
      } else {
        consider({
          kind: 'patrol',
          score: 20,
          title: `Оборона базы: <span style="color:${teamHex(bTeam.color)}">${bTeam.name}</span>`,
          subtitle: `Задача: ${b.status || 'патрулирование'} · HP ${Math.round(b.target.hp)}%`,
          focusPos: b.target.center.clone(),
          lookPos: b.target.center.clone().addScaledVector(b.target.up, 0.8),
          up: b.target.up.clone(),
          bot: b,
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
