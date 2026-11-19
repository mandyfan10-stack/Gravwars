import { Color, FogExp2, Object3D, Quaternion, Vector3 } from 'three';
import { BlockSystem } from '../shared/blocks';
import { BotManager, DIFFICULTY_LABEL } from '../shared/bots';
import { Combat, MAX_HP } from '../shared/combat';
import { TICK_DT } from '../shared/constants';
import { Economy, Pickups } from '../shared/economy';
import { activeTeams, applyMatchRules, botRoster, humanTeams, LobbyConfig, MATCH_RULES, playerTeam } from '../shared/lobby';
import { faceByUp, faceOfTeam, generateMap, MapData } from '../shared/map';
import { killRewardFor, Match } from '../shared/match';
import { upOf } from '../shared/math';
import { moveBasis, viewQuat } from '../shared/movement';
import { NpcManager } from '../shared/npcs';
import { buildPhysicsWorld, PhysicsWorld, Rapier } from '../shared/physics';
import { Props } from '../shared/props';
import { JETPACK, PlayerSim } from '../shared/sim';
import { getTeam, TeamId } from '../shared/teams';
import { Throws } from '../shared/throwables';
import { consumeJetpackFuel, isGun, refillAmmo, REVOLVER_COCK_TIME, totalFuelAmmo, WeaponId, WEAPONS } from '../shared/weapons';
import { Ambience, Area } from './ambience';
import { GameAudio } from './audio';
import { BlockController } from './blockController';
import { GameChat } from './chat';
import { Cursor } from './cursor';
import { DeathScreen } from './deathScreen';
import { createDebugGui, DebugToggles } from './debugGui';
import { GrenadeWarn } from './grenadeWarn';
import { Guide } from './guide';
import { Hands } from './hands';
import { Hud, teamHex } from './hud';
import { icon } from './icons';
import { Input } from './input';
import { Intro } from './intro';
import { InventoryUi } from './inventoryUi';
import { createKeyHandler, KeyHandler } from './keybinds';
import { LocalPlayer } from './localPlayer';
import { gameLog } from './logger';
import { MatchUi } from './matchUi';
import { backdropKey, BuiltWorld, freeSceneObject, MenuBackdrop } from './menuBackdrop';
import { GameMusic } from './music';
import { NetMatchController } from './net/netMatch';
import { P2PTransport } from './net/p2p';
import { RemotePlayerManager } from './net/remotePlayerManager';
import { PlayerCombat } from './playerCombat';
import { Pockets } from './pockets';
import { GameAssets } from './render/assets';
import { BotView } from './render/botView';
import { Fx } from './render/fx';
import { GeneratorView } from './render/generatorView';
import { GravityGizmo } from './render/gizmo';
import { Graphics } from './render/graphics';
import { HookView } from './render/hookView';
import { KeeperView } from './render/keeperView';
import { buildMapView, MapView } from './render/mapView';
import { NpcView } from './render/npcView';
import { OutlineSystem } from './render/outline';
import { FishingView, PickupView, ThrownView } from './render/pickupView';
import { CHAR_LOD } from './render/playerModel';
import { buildPropView } from './render/propView';
import { ViewModel } from './render/viewmodel';
import { Settings } from './settings';
import { SpectatorController } from './spectator';
import { formatTime, MatchStats } from './stats';

/** Seconds of the start flight: from above the base into the player's eyes. */
const INTRO_LENGTH = 2.6;

/** The door of the team's hall behind `eye` (world points at eye height), for the start flight. */
function doorBehind(map: MapData, team: TeamId, eye: { pos: Vector3; quat: Quaternion }) {
  const face = faceOfTeam(map, team);
  const doors = face && map.nav[face.id]?.doors;
  if (!face || !doors?.length) return null;
  const origin = new Vector3(...face.origin), q = new Quaternion(...face.quat), up = new Vector3(...face.up);
  const h = eye.pos.clone().sub(origin).dot(up);
  const world = ([x, z]: [number, number]) => new Vector3(x, h, z).applyQuaternion(q).add(origin);
  const back = new Vector3(0, 0, 1).applyQuaternion(eye.quat);
  const all = doors.map((d) => ({ out: world(d.out), in: world(d.in) }));
  return all.reduce((a, b) => (b.in.clone().sub(eye.pos).dot(back) > a.in.clone().sub(eye.pos).dot(back) ? b : a));
}

export interface MatchSessionOptions {
  R: Rapier;
  assets: GameAssets;
  gfx: Graphics;
  input: Input;
  audio: GameAudio;
  music: GameMusic;
  chat: GameChat;
  backdrop: MenuBackdrop;
  baseSceneChildren: ReadonlySet<Object3D>;
  settings: Settings;
  toggles: DebugToggles;
  cfg: LobbyConfig;
  startInSpectator: boolean;
  isNetworkMatch: boolean;
  isHostPlayer: boolean;
  myNetworkId: string;
  matchSeed: number;
  canonicalMapTeam: TeamId;
  skipFortTeams: TeamId[];
  transport: P2PTransport | null;
  applyToggles: () => void;
  onShowResult: (title: string) => void;
  onSpectateLabelChange: (spectating: boolean) => void;
}

/**
 * Self-contained live match runtime (simulation, rendering, HUD, network sync, and frame loop)
 * with explicit `dispose()` so matches can exit and restart in-process without reloading the page.
 */
export class MatchSession {
  readonly viewModel: ViewModel;
  readonly spectator: SpectatorController;
  readonly sim: PlayerSim;
  readonly netMatch: NetMatchController | null;
  readonly worldKey: string;
  readonly statsHtml: () => string;

  private readonly world: PhysicsWorld;
  private readonly map: MapData;
  private readonly mapView: MapView;
  private readonly propView: Object3D;
  private readonly outline: OutlineSystem;
  private readonly gizmo: GravityGizmo;
  private readonly gui: ReturnType<typeof createDebugGui>;
  private readonly keys: KeyHandler;
  private readonly ui: MatchUi;
  private readonly invUi: InventoryUi;
  private readonly baseFogDensity: number;
  private readonly debugHandle: Record<string, unknown>;
  private rafId = 0;
  private resultTimer: number | null = null;
  private disposed = false;

  constructor(private readonly opts: MatchSessionOptions, built: BuiltWorld | null, menuEye: { pos: Vector3; quat: Quaternion }) {
    const {
      R, assets, gfx, input, audio, music, chat, settings, toggles, cfg,
      startInSpectator, isNetworkMatch, isHostPlayer, myNetworkId, matchSeed,
      canonicalMapTeam, skipFortTeams, transport, applyToggles, onShowResult, onSpectateLabelChange,
    } = opts;
    const { renderer, scene, camera } = gfx;
    const mode = cfg.mode ?? 'standard';

    applyMatchRules(cfg.multipliers);
    const myTeam = playerTeam(cfg, myNetworkId) || playerTeam(cfg) || 'red';
    const mapTeam = isNetworkMatch ? canonicalMapTeam : myTeam;
    this.worldKey = backdropKey(matchSeed, mapTeam, activeTeams(cfg), mode);

    // --- simulation (shared with headless tests and dedicated server)
    const map = (this.map = built?.map ?? generateMap(matchSeed, mapTeam, activeTeams(cfg), mode));
    gfx.setSunVisible(mode !== 'skirmish');
    const world = (this.world = buildPhysicsWorld(R, map));
    const sim = (this.sim = new PlayerSim(R, world, map, myTeam));
    const combat = new Combat(R, world, map, [sim.mover.collider]);
    const blocks = new BlockSystem(R, world, sim.mover.collider);
    sim.gravity.blocks = () => blocks.blocks.values();
    combat.onWorldDamage = (handle, damage) => { blocks.damageCollider(handle, damage); };
    combat.onExplosion = (pos, radius, damage) => blocks.explosion(pos, radius, damage);
    combat.materialOf = (handle) => blocks.byCollider(handle)?.material ?? null;
    const props = new Props(world, map);
    combat.props = props;
    const fortifySkip = isNetworkMatch ? (skipFortTeams.length ? skipFortTeams : humanTeams(cfg)) : undefined;
    const match = new Match(R, world, map, blocks, sim.team.id, sim.mover.collider, fortifySkip);
    match.attach(combat);
    const bots = new BotManager(R, world, map, combat, match, blocks, sim.team.id, 0, botRoster(cfg, startInSpectator));
    const pickups = new Pickups(R, world, map);
    bots.pickups = pickups;
    const npcs = new NpcManager(R, world, map, combat, pickups);
    const throws = new Throws(combat, pickups);
    blocks.characters.push(...npcs.colliders);
    blocks.inventory.wood = 16;

    // --- rendering
    const mapView = (this.mapView = built?.mapView ?? buildMapView(map));
    const propView = (this.propView = built?.propView ?? buildPropView(map, assets));
    if (!built) scene.add(mapView.group, propView);
    mapView.group.visible = true;
    propView.visible = true;

    const fx = new Fx(scene);
    fx.ground = (pos, down) => {
      const hit = combat.rayWorld(pos, pos.clone().addScaledVector(down, 4));
      return hit ? { pos: pos.clone().addScaledVector(down, 4 * hit.t), normal: hit.normal } : null;
    };
    const viewModel = (this.viewModel = new ViewModel(sim.team.color, assets));
    viewModel.environment = scene.environment;
    gfx.overlay.scene = viewModel.scene;
    gfx.overlay.camera = viewModel.camera;
    const outline = (this.outline = new OutlineSystem(settings.outline));
    gfx.xray.scene = outline.scene;
    gfx.xray.camera = camera;
    const gizmo = (this.gizmo = new GravityGizmo(map));

    // --- player, UI
    const hud = new Hud();
    const player = new PlayerCombat(sim, combat, hud, fx, audio, viewModel);
    const botView = new BotView(scene, bots, assets);
    const remotePlayers = new RemotePlayerManager(scene, assets);
    botView.onDeath = (pos) => {
      fx.blood(pos);
      const audioPos = this.spectator.active ? camera.position : sim.state.pos;
      audio.gore(pos.distanceTo(audioPos));
    };
    fx.bleeds = (id) => {
      const n = combat.target(id)?.npc;
      return n === 'car' ? 0 : n ? 0.45 : 1;
    };
    blocks.onBreak = (b) => {
      fx.blockBreak(b);
      const audioPos = this.spectator.active ? camera.position : sim.state.pos;
      audio.blockBreak(b.material, b.center.distanceTo(audioPos));
    };
    blocks.onRemove = (b) => {
      pickups.wakeNear(b.center, Math.max(b.half.x, b.half.y, b.half.z) + 1.5);
    };
    props.onBreak = (_i, pos, up, kind) => {
      pickups.wakeNear(pos, 2.5);
      pickups.dropCrateLoot(pos, up);
      fx.crateBreak(pos, kind);
      const audioPos = this.spectator.active ? camera.position : sim.state.pos;
      audio.blockBreak(kind === 'crate' ? 'wood' : 'metal', pos.distanceTo(audioPos));
    };
    const npcView = new NpcView(scene, npcs, assets);
    const build = new BlockController(sim, input, blocks, audio, hud, scene, sim.team.id);
    build.onPlace = () => viewModel.dig();
    const eco = new Economy(match.wallet, blocks, player.weapons);
    eco.freeWeapons = map.mode === 'skirmish';
    const cursor = new Cursor(input);
    const ui = (this.ui = new MatchUi(match, eco, hud, audio, cursor));
    const pockets = new Pockets(eco, pickups, sim, player, hud, audio, map.ponds);
    const hands = new Hands(eco, player, build, pockets, throws, sim, audio, hud, viewModel, cursor);
    const invUi = (this.invUi = new InventoryUi(eco, hands, cursor, audio, hud, sim, pickups));
    eco.onArmorChange = () => {
      player.me.armor = eco.has('armor');
      hud.setArmor(eco.has('armor'));
    };
    player.me.onArmorBreak = () => eco.breakArmor();
    blocks.onDoorToggle = (b) => audio.door(b.open, b.center.distanceTo(camera.position));
    hands.hookFilter = combat.notCharacter;
    hands.onHook = (thrown) => {
      if (!thrown) return;
      audio.hookFire();
      viewModel.hookShot();
    };
    const hookView = new HookView(scene, sim);
    const deathScreen = new DeathScreen(combat);
    const pickupView = new PickupView(scene, pickups);
    const thrownView = new ThrownView(scene, throws);
    const grenadeWarn = new GrenadeWarn(combat);
    const fishingView = new FishingView(scene, pockets.fishing);
    const keepers = new KeeperView(scene, map, assets);
    const generators = new GeneratorView(scene, match);
    const guide = new Guide(match, bots, sim);

    this.spectator = new SpectatorController(
      input, combat, match, bots, () => this.netMatch?.getHumanSpectatorTargets() ?? [], npcs,
    );
    if (startInSpectator) {
      player.me.alive = false;
      player.me.guard = { t: Infinity, from: new Vector3() };
      const pIdx = combat.targets.indexOf(player.me);
      if (pIdx >= 0) combat.targets.splice(pIdx, 1);
      sim.state.noclip = true;
      this.spectator.enable('auto', camera.position, upOf(sim.state.frame));
      onSpectateLabelChange(true);
    }

    match.onReviveAll = (crystalTeam) => {
      bots.reviveAll(crystalTeam);
      if (!player.me.alive && crystalTeam === sim.team.id) {
        sim.respawn('manual');
        player.reset();
        hud.toast('Кристалл воскресил всех павших!', '#7cf5ff', 2.4);
      }
    };
    player.canRespawn = () => match.onDeath();
    player.onDeath = (pos, up) => {
      pockets.spill(pos, up, false);
      music.playDeathMusic();
    };
    player.onRespawn = () => {
      music.playRespawnMusic();
    };
    player.onRecoil = (pitch, yaw) => {
      input.pitch = Math.max(-1.55, Math.min(1.55, input.pitch + pitch));
      input.yaw -= yaw;
    };
    const stats = new MatchStats(match);
    player.onFrag = (killer, victim, head) => {
      if (!isNetworkMatch || isHostPlayer) stats.frag(killer, victim, head);
    };
    player.onCombatEvent = (e) => this.netMatch?.onHostCombatEvent(e);
    player.onKill = (tg) => {
      if (tg.npc) return;
      if (isNetworkMatch && !isHostPlayer) return;
      const reward = Math.max(1, Math.round(killRewardFor(map.mode) * MATCH_RULES.reward));
      match.wallet.cash += reward;
      if (map.mode === 'skirmish') hud.toast(`+${reward}$ за убийство`, '#ffd966', 1.2);
    };

    const allies = bots.bots.filter((b) => b.team === myTeam);
    const alliesNow = () => allies.map((b, i) => ({
      name: `Бот ${i + 1}`, role: b.role === 'defend' ? 'защитник' : 'рейдер', status: b.status || '—',
      weapon: WEAPONS[b.weapons.current].name, cash: b.wallet.cash, alive: b.target.alive && !b.out,
    }));
    this.statsHtml = () => stats.teamsHtml(player.me.alive) + stats.alliesHtml(alliesNow()) + stats.personalHtml();

    const gui = (this.gui = createDebugGui(sim.cfg, sim.mover));
    const scoreEl = document.getElementById('scoreboard')!;
    const levels = [...new Set(Object.values(botRoster(cfg)).flat())];
    const botsLabel = !levels.length ? 'без ботов' : levels.length === 1 ? `боты: ${DIFFICULTY_LABEL[levels[0]].toLowerCase()}` : 'боты: разные';
    let scoreT = 0;

    const local = new LocalPlayer(sim, input);
    this.netMatch = isNetworkMatch && transport
      ? new NetMatchController({
          transport,
          lobby: cfg,
          isHost: isHostPlayer,
          myId: myNetworkId || (isHostPlayer ? 'host' : transport.myId),
          R,
          world,
          map,
          sim,
          local,
          combat,
          blocks,
          props,
          match,
          bots,
          npcs,
          throws,
          pickups,
          eco,
          pockets,
          player,
          hands,
          build,
          ui,
          invUi,
          stats,
          hud,
          fx,
          audio,
          mapView,
          remotePlayers,
          camera,
          onHostDisconnect: () => {
            if (document.pointerLockElement) document.exitPointerLock();
            else input.setLocked(false);
            onShowResult('Соединение с хостом потеряно');
            hud.toast('Хост отключился — матч прерван', '#ff8080', 5);
          },
          onChat: (sender, text, team) => chat.pushMatchMessage(sender, text, team),
        })
      : null;

    chat.onSendMatch = (text) => {
      if (this.netMatch) this.netMatch.sendChat(text);
      else chat.pushMatchMessage('Ты', text, sim.team.id);
    };

    let crystalAmmoT = 0;
    local.onTick = () => {
      player.me.vel = sim.state.vel;
      player.me.quiet = local.input.crouch;
      player.me.crouched = local.input.crouch;
      sim.hasJetpack = eco.has('jetpack');
      sim.hasJetpackFuel = totalFuelAmmo(player.weapons) > 0;
      if (cfg.infiniteMoney && (!isNetworkMatch || isHostPlayer)) {
        match.wallet.cash = 99999;
        match.wallet.crystal = 99999;
      }
      if (!match.result) {
        if (!isNetworkMatch || isHostPlayer) {
          gameLog.setStage('tick:bots');
          bots.tick(TICK_DT);
          gameLog.setStage('tick:npcs');
          npcs.tick(TICK_DT);
        }
      }
      gameLog.setStage('tick:net');
      this.netMatch?.tickHostClients(TICK_DT);
      this.netMatch?.onLocalTick();
      gameLog.setStage('tick:throws');
      throws.tick(TICK_DT);
      if (!isNetworkMatch || isHostPlayer) {
        gameLog.setStage('tick:props');
        props.tick(TICK_DT);
      }
      gameLog.setStage('tick:player');
      player.tick(!hands.tool && !cursor.active && !this.spectator.active && input.locked && input.down('Mouse0'));
      gameLog.setStage('tick:match');
      match.tick(TICK_DT, sim.state.pos, player.me.alive);
      if ((!isNetworkMatch || isHostPlayer) && !match.result) {
        match.checkCoopEliminated(player.me.alive);
      }
      if (!isNetworkMatch || isHostPlayer) {
        crystalAmmoT -= TICK_DT;
        if (crystalAmmoT <= 0 && player.me.alive) {
          const ownBed = match.bed(sim.team.id);
          if (ownBed.alive && sim.state.pos.distanceTo(ownBed.pos) < 8.5) {
            crystalAmmoT = 1.4;
            if (refillAmmo(player.weapons, 0.35)) {
              audio.pickup();
              hud.toast('Патроны пополнены у кристалла', '#ffe082', 0.9);
            }
          } else {
            crystalAmmoT = 0.25;
          }
        }
      }
    };

    local.onEvent = (e) => {
      if (e.type === 'land') { if (player.me.alive) combat.fall(player.me, e.speed); return; }
      if (e.type === 'splash') { audio.splash(); fx.waterSplash(e.pos, e.speed); return; }
      if (e.type === 'jetpackFuel') { consumeJetpackFuel(player.weapons, 1); return; }
      if (e.type === 'jetpackExplode') {
        if (isNetworkMatch && !isHostPlayer) return; // Host authoritatively resolves jetpack overheat explosions
        audio.explosion();
        fx.handle({ type: 'explode', pos: e.pos.clone(), radius: JETPACK.explodeRadius });
        hud.toast('Перегрев ранца! Взрыв!', '#ff7050', 2.2);
        const selfDmg = (player.me.maxHp ?? MAX_HP) * JETPACK.explodeSelfFrac;
        combat.damage(player.me, selfDmg, 0, false, e.pos, { raw: true, noPush: true, cause: 'jetpack', weapon: 'jetpack' });
        combat.triggerExplosion(e.pos, 0, player.me.team, JETPACK.explodeRadius, JETPACK.explodeDamageOther, 12, 60, 0, true, 'jetpack', e.pos);
        return;
      }
      if (e.type === 'gravity') {
        const face = faceByUp(map, upOf(sim.state.frame));
        if (!face?.team) hud.toast('Гравитация: нейтральная грань', '#e8e2d0');
        else {
          const t = getTeam(face.team as TeamId);
          hud.toast(`Гравитация: ${t.name}`, teamHex(t.color));
        }
      } else if (e.type === 'respawn' && e.reason === 'manual') player.reset();
      else if (e.type === 'respawn' && e.reason === 'void') {
        if (isNetworkMatch && !isHostPlayer) return;
        if (player.death) return;
        stats.deaths++;
        pockets.spill(sim.state.pos, upOf(sim.state.frame), true);
        player.die('void', undefined, undefined, false, !match.bed(sim.team.id).alive);
        music.playDeathMusic();
      } else if (e.type === 'hook') {
        if (e.what === 'attach') audio.hookBite(sim.hook ? sim.hook.anchor.distanceTo(sim.state.pos) : 0);
        else if (e.what === 'release') audio.hookRelease();
      }
    };

    const keys = (this.keys = createKeyHandler({
      input, sim, local, build, player, ui, inv: invUi, hands, pockets,
      nearShop: () => match.nearShop(sim.state.pos), camera, hud, toggles, applyToggles, gui,
      onOpenChat: () => chat.openMatchInput(),
    }));

    const ambient: Area = { base: 0, forest: 0, park: 0, city: 0, water: 0 };
    const ambience = new Ambience(audio);

    // --- intro flight
    local.applyCamera(camera);
    const eye = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
    const intro = new Intro(eye, upOf(sim.state.frame), built ? INTRO_LENGTH + 1.2 : INTRO_LENGTH + 0.4, {
      start: built ? menuEye : undefined, door: doorBehind(map, myTeam, eye) ?? undefined,
    });
    if (startInSpectator) intro.skip();
    else audio.whoosh();

    this.debugHandle = {
      sim, local, input, camera, renderer, scene, gfx, combat, props, deathScreen, weapons: player.weapons, fx,
      blocks, build, match, bots, npcs, map, hud, icon, eco, pockets, pickups, ui, hands, throws, cursor, player,
      npcView, ambient, ambience, audio, spectator: this.spectator, music, reusedBackdrop: !!built, ready: true,
      shoot(ticks = 1, weapon?: WeaponId) {
        if (weapon) player.pendingSelect = weapon;
        player.forceFire = ticks;
      },
      play() { input.setLocked(true); },
      skipIntro() { intro.skip(); },
      look(yaw: number, pitch: number) { input.yaw = yaw; input.pitch = pitch; },
    };
    (window as unknown as Record<string, unknown>).__game = this.debugHandle;

    const fog = scene.fog as FogExp2;
    const FOG = (this.baseFogDensity = fog.density);

    gameLog.setStage('prewarm-shaders');
    if (!navigator.webdriver) {
      try {
        renderer.compile(scene, camera);
        renderer.compile(outline.scene, camera);
        renderer.compile(viewModel.scene, viewModel.camera);
      } catch (err) {
        gameLog.error('prewarm', err);
      }
    }
    gameLog.setStage('match-ready', { mode: startInSpectator ? 'spectator' : 'play' });
    document.body.classList.remove('building');
    gfx.updateLighting(local.renderFrame);

    const cityPts = map.boxes.filter((b) => b.mat === 'window' && b.half[1] > 4);
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    let ambientT = 0;
    const nearest = (pts: ArrayLike<number>[] | { pos: ArrayLike<number> }[], p: Vector3) => {
      let best = Infinity;
      for (const it of pts) {
        const a = 'pos' in it ? it.pos : it;
        const d = (a[0] - p.x) ** 2 + (a[1] - p.y) ** 2 + (a[2] - p.z) ** 2;
        if (d < best) best = d;
      }
      return Math.sqrt(best);
    };
    const STEP_LEN = 2.3;
    const speedEl = document.getElementById('speedlines')!;
    let sprintT = 0;
    let zoomT = 0;
    let fovNow = 0;

    const introFrame = (dt: number, t: number) => {
      gameLog.setStage('intro', { mode: 'intro' });
      if (input.take('Space') || input.take('Enter') || input.take('Mouse0')) intro.skip();
      intro.update(dt, camera);
      CHAR_LOD.eye.copy(camera.position);
      mapView.cull(camera.position, intro.active ? Infinity : settings.drawDistance);
      const d = camera.position.distanceTo(eye.pos);
      fog.density = intro.active ? FOG * Math.min(1, Math.max(0.22, 1 - (d - 40) / 500)) : FOG;
      generators.update(t);
      keepers.update(dt, t);
      botView.update(dt, local.alpha);
      npcView.update(dt, local.alpha, camera);
      mapView.update(t, dt);
      gfx.overlay.enabled = false;
      gfx.render(dt);
      input.endFrame();
    };

    let last = performance.now();
    let time = 0;
    const viewQ = new Quaternion();
    let lastYaw = input.yaw;
    let lastPitch = input.pitch;
    const _wf = new Vector3();
    const _wr = new Vector3();
    let frameErrors = 0;
    const frameParts: Record<string, number> = { local: 0, ui: 0, views: 0, outline: 0, render: 0, hud: 0 };

    const frame = (now: number) => {
      if (this.disposed) return;
      const fStart = performance.now();
      let keepRunning = true;
      try {
        const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
        last = Math.max(last, now);
        time += dt;
        const sp = sim.state.pos;
        gameLog.setStage('frame:start', {
          mode: this.spectator.active ? 'spectator' : 'play',
          pos: `${sp.x.toFixed(1)},${sp.y.toFixed(1)},${sp.z.toFixed(1)}`,
          bots: bots.bots.length,
          npcs: npcs.npcs.length,
          fps: dt > 0.0001 ? Math.round(1 / dt) : 60,
        });
        if (intro.active) {
          introFrame(dt, time);
          gameLog.heartbeat(now);
          return;
        }
        const specActive = this.spectator.active;
        if (!specActive) keys.update();
        local.frozen = !!player.death || specActive;
        const t0 = performance.now();
        gameLog.setStage('frame:local');
        local.update(dt);
        const t1 = performance.now();
        frameParts.local = t1 - t0;

        if (!specActive && local.landed) { audio.land(local.landed); local.landed = 0; local.stride = 0; }
        if (!specActive && local.stride > STEP_LEN) {
          local.stride = 0;
          if (!local.input.crouch) audio.step(false);
        }
        ambientT -= dt;
        if (ambientT <= 0) {
          ambientT = 0.5;
          const pos = specActive ? camera.position : sim.state.pos;
          const base = clamp01(1 - (nearest(map.statues.map((t) => t.bed), pos) - 14) / 8);
          let trees = 0;
          for (const t of map.trees) if (t.kind === 'tree' && (t.pos[0] - pos.x) ** 2 + (t.pos[1] - pos.y) ** 2 + (t.pos[2] - pos.z) ** 2 < 25 * 25) trees++;
          ambient.base = base;
          ambient.forest = clamp01((trees - 6) / 8) * (1 - base);
          ambient.park = clamp01(1 - nearest(map.trees, pos) / 22) * (1 - ambient.forest) * (1 - base);
          const face = faceByUp(map, upOf(sim.state.frame));
          ambient.city = Math.max(face && !face.team ? 0.7 : 0, clamp01(1 - (nearest(cityPts, pos) - 15) / 60)) * (1 - base * 0.7);
          ambient.water = clamp01(1 - nearest(map.ponds, pos) / 16);
        }
        ambience.update(ambient, dt);
        {
          const st = sim.state, upv = upOf(st.frame);
          const planar = Math.sqrt(Math.max(0, st.vel.lengthSq() - st.vel.dot(upv) ** 2));
          const fast = !specActive && st.sprinting && planar > sim.cfg.maxSpeed * 1.1 ? Math.min(1, (planar - sim.cfg.maxSpeed) / (sim.cfg.maxSpeed * 0.5)) : 0;
          sprintT += (fast - sprintT) * Math.min(1, dt * (fast > sprintT ? 6 : 3));
          const fall = specActive ? 0 : Math.max(0, -st.vel.dot(upv));
          audio.loop('wind', Math.min(1, Math.max(0, fall - 9) / 18));
          audio.loop('scrape', !specActive && st.wallSlide ? 1 : 0);
          audio.loop('jetpack', !specActive && !player.death && sim.jetpackActive ? 0.55 + (sim.jetpackHeat / JETPACK.maxFlight) * 0.45 : 0);

          const wantZoom = input.locked && !cursor.active && !player.death && !specActive
            && (input.down('KeyX') || (hands.held === 'crossbow' && input.down('Mouse2')));
          zoomT += ((wantZoom ? 1 : 0) - zoomT) * Math.min(1, dt * 10);
          input.sensitivity = toggles.sensitivity * (1 - 0.45 * zoomT);

          const fov = (toggles.fov + 12 * sprintT) * (1 - 0.5 * zoomT);
          if (Math.abs(fov - fovNow) > 0.05) { fovNow = fov; camera.fov = fov; camera.updateProjectionMatrix(); }
          speedEl.style.opacity = (sprintT * 0.9).toFixed(3);
          if (sprintT > 0.01) speedEl.style.transform = `rotate(${(Math.random() * 6).toFixed(2)}deg) scale(${(1.02 + Math.random() * 0.04).toFixed(3)})`;
        }
        local.applyCamera(camera);
        const dead = specActive ? false : deathScreen.update(player.death, camera, dt);
        this.spectator.update(dt, camera);

        if (input.locked && !ui.shopOpen && !dead && !specActive && input.down('KeyE')) {
          pockets.pickupFrontRadius(camera);
        }

        CHAR_LOD.eye.copy(camera.position);
        mapView.cull(camera.position, settings.drawDistance);
        if (!input.locked || dead || specActive) invUi.close();
        const click = cursor.update();
        if (!build.active && !cursor.active && !dead && !specActive && !hands.tool && player.weapons.current === 'revolver' && input.locked && input.take('Mouse2')) {
          player.spinRevolver();
        }
        hands.update(dt, camera, input.locked && !cursor.active && !dead && !specActive && input.down('Mouse0'), click);
        invUi.update(click, camera.getWorldDirection(_wf));
        if (cursor.active || specActive) build.active = false;
        build.update(dt, camera);
        gfx.updateLighting(local.renderFrame, time);

        for (const b of match.beds) mapView.setBedStage(b.team, b.stage, b.invulnT);
        const sight = dead || specActive ? null : match.bedInSight(camera.position, camera.getWorldDirection(_wf));
        for (const e of match.events.splice(0)) {
          if (!isNetworkMatch || isHostPlayer) this.netMatch?.onHostMatchEvent(e);
          ui.onEvent(e);
          if (e.type === 'bedBroken' && e.byPlayer) stats.crystals++;
          if (e.type === 'win' || e.type === 'lose') {
            const title = e.type === 'win' ? `Победа · ${formatTime(e.time)}` : 'Поражение';
            if (this.resultTimer !== null) clearTimeout(this.resultTimer);
            this.resultTimer = window.setTimeout(() => {
              this.resultTimer = null;
              if (this.disposed) return;
              onShowResult(title);
              if (document.pointerLockElement) document.exitPointerLock();
              else input.setLocked(false);
            }, 2500);
          }
          if (e.type === 'bedStageBlast') {
            const bedPos = match.bed(e.team).pos;
            fx.handle({ type: 'explode', pos: bedPos.clone(), radius: 10 });
            audio.crystalBlast(bedPos.distanceTo(camera.position));
          }
          if (e.type === 'bedBroken') {
            mapView.setBedAlive(e.team, false);
            fx.handle({ type: 'explode', pos: match.bed(e.team).pos.clone(), radius: 3 });
            audio.explosion();
          }
        }
        if (pockets.rod && input.locked && !cursor.active && !specActive && input.take('Mouse0')) pockets.useRod(camera);
        const pocketPrompt = pockets.update(dt, camera, () => viewModel.cast());
        let extraPrompt = pocketPrompt;
        if (!extraPrompt && !dead && !specActive) {
          const door = blocks.aimedDoor(camera.position, camera.getWorldDirection(_wf), 4.2);
          if (door && (door.block.team === sim.team.id || door.block.team === null)) {
            const what = door.block.kind === 'floor' ? 'люк' : 'дверь';
            extraPrompt = `<b>E</b> ${door.block.open ? 'закрыть' : 'открыть'} ${what}`;
          }
        }
        const actionProgress = hands.appleEatProgress > 0
          ? hands.appleEatProgress
          : player.weapons.current === 'crossbow' && player.weapons.chargeT > 0
          ? Math.min(1, player.weapons.chargeT / 3)
          : 0;
        const actionColor = hands.appleEatProgress > 0 ? '#7dff8a' : '#66f7ff';
        const tUi0 = performance.now();
        gameLog.setStage('frame:ui');
        ui.update(match.nearShop(sim.state.pos), sight, extraPrompt, click, actionProgress, actionColor);
        const tUi1 = performance.now();
        frameParts.ui = tUi1 - tUi0;

        for (const e of throws.events.splice(0)) {
          if (e.type === 'shatter') {
            audio.shatter(e.pos.distanceTo(camera.position));
            fx.burst(e.pos, null, 16, 3.2, new Color(0.45, 0.9, 0.5), 0.45);
            if (e.stunned) hud.hitmarker(false, false);
          } else if (e.type === 'land') audio.thud(e.pos.distanceTo(camera.position));
        }
        thrownView.update(dt);
        for (const e of npcs.events.splice(0)) {
          const d = e.pos.distanceTo(camera.position);
          if (e.type === 'windup') { if (e.grenade) audio.pin(d); else audio.cock(d); }
          else if (e.type === 'throw') { if (d < 25) audio.toss(); }
          else if (e.type === 'meleeSpark') { fx.meleeSpark(e.pos); audio.spark(d); }
          else if (e.type === 'meleeStrike') { fx.meleeStrike(e.pos, e.dir); audio.meleeDash(d); }
          else if (e.type === 'carExplode') { audio.carExplode(d); }
          else if (e.type === 'carAlarm') { audio.carAlarm(d); }
          else if (e.type === 'carVanish') { fx.carVanish(e.pos); }
        }
        generators.update(time);
        pickupView.update(time, pockets.near);
        keepers.update(dt, time);
        guide.update(camera);

        this.netMatch?.updateFrame(dt, time);
        botView.update(dt, local.alpha);
        npcView.update(dt, local.alpha, camera);
        grenadeWarn.update(camera, sim.state.pos);
        fx.down.copy(gfx.upDir).negate();
        if (!specActive && !dead && sim.jetpackActive) {
          fx.jetpackThrust(sim.state.pos, fx.down, sim.state.vel, sim.jetpackHeat / JETPACK.maxFlight, dt);
        }
        fx.update(dt, combat, time);
        mapView.update(time, dt);
        if (!dead && !specActive) player.applyCameraKick(camera, dt);
        for (const i of props.moved) mapView.setCrate(i, props.pos(i), props.quat(i), props.present(i));
        props.moved.clear();

        fishingView.update(time, pockets.rod && !specActive ? viewModel.rodTipWorld(camera) : null);
        viewModel.hookOut = !!sim.hook;
        hookView.update(sim.hook && !dead && !specActive ? viewModel.hookClawWorld(camera) : null, fx.down);
        const invCam = camera.quaternion.clone().invert();
        const pUp = upOf(sim.state.frame);
        viewModel.update(dt, {
          speed: sim.state.vel.clone().addScaledVector(pUp, -sim.state.vel.dot(pUp)).length(),
          lookDX: lastYaw - input.yaw, lookDY: input.pitch - lastPitch, reload: player.reloadProgress,
          empty: isGun(player.weapons.current) && player.weapons.ammo[player.weapons.current] === 0,
          charge: player.weapons.current === 'crossbow' ? Math.min(1, player.weapons.chargeT / 3) : 0,
          cock: player.weapons.current === 'revolver' ? player.weapons.revolverCockT / REVOLVER_COCK_TIME : 0,
          spin: player.weapons.revolverSpinT > 0 ? player.weapons.revolverSpinT / 0.65 : 0,
          shell: player.weapons.current === 'shotgun' && player.weapons.reloadT > 0 ? 1 - player.weapons.shotgunShellT / 0.45 : undefined,
          eatProgress: hands.appleEatProgress,
          sunCam: gfx.sunDir.clone().applyQuaternion(invCam), upCam: gfx.upDir.clone().applyQuaternion(invCam),
          aspect: camera.aspect,
        });
        lastYaw = input.yaw;
        lastPitch = input.pitch;
        viewModel.bite = pockets.fishing.phase === 'bite' ? 1 : 0;
        const tViews1 = performance.now();
        frameParts.views = tViews1 - tUi1;
        gfx.overlay.enabled = !dead && !specActive;
        gameLog.setStage('frame:outline');
        outline.update({
          playerTeam: sim.team.id,
          spectator: specActive,
          match,
          bots,
          npcs,
          pickups,
          remotePlayers: remotePlayers.getSnapshots(),
        }, camera, time);
        const tOut1 = performance.now();
        frameParts.outline = tOut1 - tViews1;
        gameLog.setStage('frame:render');
        gfx.render(dt);
        const tRen1 = performance.now();
        frameParts.render = tRen1 - tOut1;

        const w = combat.wind.felt(combat.time, pUp.clone().negate());
        moveBasis(sim.state.frame, input.yaw, _wf, _wr);
        hud.setWind(Math.atan2(w.dot(_wr), w.dot(_wf)) - Math.PI / 2, w.length(), 0);
        hud.setWeapon(player.weapons, hands.tool, eco.items);
        hud.setKick(player.kickCooldown);
        viewQuat(local.renderFrame, input.yaw, input.pitch, viewQ);
        gizmo.render(renderer, viewQ, faceByUp(map, pUp)?.id ?? '');
        hud.setSpread(hands.tool ? null : player.nextSpread, camera.fov);
        hud.setGuard(player.me.guard && player.me.alive ? player.me.guard.t : null);
        hud.setHp(player.me.hp, player.me.maxHp ?? MAX_HP);
        hud.setArmor(eco.has('armor'));
        const ownBed = match.bed(sim.team.id);
        hud.setCrystalZone(!specActive && !dead && player.me.alive && ownBed.alive && sim.state.pos.distanceTo(ownBed.pos) < 8.5);
        const jetpackFlying = !specActive && !dead && player.me.alive && sim.jetpackActive;
        hud.setJetpack(eco.has('jetpack'), jetpackFlying, sim.jetpackHeat / JETPACK.maxFlight, totalFuelAmmo(player.weapons), sim.jetpackOverheatCd);
        hud.update(dt, sim, `${(Math.hypot(...sim.state.pos.toArray())).toFixed(0)} м от центра`);
        stats.trackCash(match.wallet.cash);

        const showScore = input.locked && !ui.shopOpen && !invUi.open && input.down('Tab');
        scoreEl.hidden = !showScore;
        scoreT -= dt;
        if (showScore && scoreT <= 0) {
          scoreT = 0.25;
          scoreEl.innerHTML = `<h3>Счёт<span>${botsLabel}</span></h3>${this.statsHtml()}`;
        }
        frameParts.hud = performance.now() - tRen1;
        frameErrors = 0;
        const totalMs = performance.now() - fStart;
        gameLog.recordFrameTiming(totalMs, frameParts);
        gameLog.heartbeat(now);
      } catch (err) {
        frameErrors++;
        gameLog.error('frame', err);
        if (frameErrors >= 20) {
          keepRunning = false;
          gameLog.error('frame', new Error('Aborting frame loop after 20 consecutive frame errors'));
        }
      } finally {
        input.endFrame();
        if (keepRunning && !this.disposed) this.rafId = requestAnimationFrame(frame);
      }
    };
    this.rafId = requestAnimationFrame(frame);
  }

  toggleSpectate(): boolean {
    if (this.spectator.active) {
      this.spectator.disable();
      return false;
    }
    this.spectator.enable('auto', this.opts.gfx.camera.position, upOf(this.sim.state.frame));
    return true;
  }

  /**
   * Release all match resources (RAF, listeners, Rapier world, Three.js scene objects, HUD DOM, lil-gui).
   * When `preserveWorld` is true, keeps `mapView`/`propView` attached so `MenuBackdrop` can orbit them smoothly.
   */
  dispose(preserveWorld = false): BuiltWorld | null {
    if (this.disposed) return null;
    this.disposed = true;

    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    if (this.resultTimer !== null) { clearTimeout(this.resultTimer); this.resultTimer = null; }

    const { gfx, input, audio, chat, baseSceneChildren } = this.opts;
    if (this.spectator.active) this.spectator.disable();
    this.invUi.close();
    if (this.ui.shopOpen) this.ui.toggleShop();
    this.keys.dispose();
    this.gui.destroy();

    audio.loop('wind', 0);
    audio.loop('scrape', 0);
    audio.loop('jetpack', 0);

    input.mouseHooks.length = 0;
    input.onWheel = () => false;
    input.typing = false;
    chat.onSendMatch = undefined;
    chat.clearMatch();

    // Reset HUD & transient DOM elements
    for (const id of ['markers', 'feed', 'result', 'toast', 'prompt', 'objective']) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '';
    }
    for (const id of ['scoreboard', 'shop', 'inv', 'build-radial', 'cursor', 'intro-cap', 'spectator-hud', 'jetpack-center', 'zone-badge', 'guard', 'armor-badge', 'jp-row']) {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    }
    const buildHud = document.getElementById('build-hud');
    if (buildHud) buildHud.style.display = 'none';
    const speedEl = document.getElementById('speedlines');
    if (speedEl) { speedEl.style.opacity = '0'; speedEl.style.transform = ''; }
    const resultEl = document.getElementById('result');
    if (resultEl) resultEl.className = '';
    document.body.classList.remove('spectating', 'playing', 'intro', 'dead', 'debug', 'building');
    document.getElementById('hud')?.setAttribute('style', '');

    // Detach overlays & restore fog
    gfx.overlay.enabled = false;
    gfx.overlay.scene = null;
    gfx.overlay.camera = null;
    gfx.xray.scene = null;
    gfx.xray.camera = null;
    (gfx.scene.fog as FogExp2).density = this.baseFogDensity;

    // Free Three.js GPU buffers for match-owned objects
    for (const child of [...gfx.scene.children]) {
      if (baseSceneChildren.has(child)) continue;
      if (preserveWorld && (child === this.mapView.group || child === this.propView)) continue;
      gfx.scene.remove(child);
      freeSceneObject(child);
    }
    freeSceneObject(this.viewModel.scene);
    freeSceneObject(this.outline.scene);
    this.gizmo.dispose();

    // Free Rapier WASM physics world
    try { this.world.free(); } catch {}

    const win = window as unknown as Record<string, unknown>;
    if (win.__game === this.debugHandle) delete win.__game;

    if (preserveWorld) {
      this.mapView.group.visible = true;
      this.propView.visible = true;
      return { map: this.map, mapView: this.mapView, propView: this.propView as unknown as BuiltWorld['propView'] };
    }
    return null;
  }
}
