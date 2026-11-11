import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import './style.css';
import { Color, FogExp2, Quaternion, Vector3 } from 'three';
import { BlockSystem } from '../shared/blocks';
import { BotManager, DIFFICULTY_LABEL } from '../shared/bots';
import { Combat } from '../shared/combat';
import { TICK_DT } from '../shared/constants';
import { faceByUp, faceOfTeam, generateMap, MapData } from '../shared/map';
import { activeTeams, botRoster, playerTeam } from '../shared/lobby';
import { NpcManager } from '../shared/npcs';
import { Economy, Pickups } from '../shared/economy';
import { KILL_REWARD, Match } from '../shared/match';
import { upOf } from '../shared/math';
import { moveBasis, viewQuat } from '../shared/movement';
import { buildPhysicsWorld, initRapier } from '../shared/physics';
import { Props } from '../shared/props';
import { PlayerSim } from '../shared/sim';
import { getTeam, TeamId } from '../shared/teams';
import { Throws } from '../shared/throwables';
import { isGun, refillAmmo, WeaponId, WEAPONS } from '../shared/weapons';
import { Ambience, Area } from './ambience';
import { GameAudio } from './audio';
import { GameMusic } from './music';
import { SpectatorController } from './spectator';
import { BlockController } from './blockController';
import { Cursor } from './cursor';
import { DeathScreen } from './deathScreen';
import { createDebugGui, DebugToggles } from './debugGui';
import { GrenadeWarn } from './grenadeWarn';
import { Hands } from './hands';
import { Hud, teamHex } from './hud';
import { Input } from './input';
import { createKeyHandler } from './keybinds';
import { LocalPlayer } from './localPlayer';
import { Guide } from './guide';
import { icon } from './icons';
import { MatchUi } from './matchUi';
import { setupMenu } from './menu';
import { Lobby } from './lobby';
import { MenuBackdrop } from './menuBackdrop';
import { Intro } from './intro';
import { PlayerCombat } from './playerCombat';
import { Pockets } from './pockets';
import { Fx } from './render/fx';
import { GeneratorView } from './render/generatorView';
import { GravityGizmo } from './render/gizmo';
import { HookView } from './render/hookView';
import { Graphics } from './render/graphics';
import { loadAssets } from './render/assets';
import { BotView } from './render/botView';
import { KeeperView } from './render/keeperView';
import { NpcView } from './render/npcView';
import { CHAR_LOD } from './render/playerModel';
import { FishingView, PickupView, ThrownView } from './render/pickupView';
import { buildMapView } from './render/mapView';
import { buildPropView } from './render/propView';
import { ViewModel } from './render/viewmodel';
import { setPixelTextures } from './render/texFilter';
import { loadSettings, PALETTE_LEVELS, saveSettings } from './settings';
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

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay')!;
  const start = document.getElementById('start-game') as HTMLButtonElement;

  // --- before the match: menu + lobby while wasm, models and fonts load
  const settings = loadSettings();
  const loading = Promise.all([initRapier(), loadAssets(), document.fonts.load('800 64px Inter', 'МАГАЗИН КРАСНЫЕ')]);
  const gfx = new Graphics(canvas);
  const { renderer, scene, camera } = gfx;
  window.addEventListener('resize', () => gfx.resize());
  const input = new Input(canvas, overlay);
  const audio = new GameAudio();
  audio.volume = settings.volume;
  const music = new GameMusic(audio);
  // Start menu music on the first user gesture in the menu
  const startMenuMusicOnce = () => {
    if (!input.armed) {
      audio.unlock();
      music.playMenuMusic();
    }
  };
  overlay.addEventListener('pointerdown', startMenuMusicOnce, { once: true });
  window.addEventListener('keydown', startMenuMusicOnce, { once: true });

  const toggles: DebugToggles = { bloom: settings.bloom, sensitivity: settings.sensitivity, fov: settings.fov, pixel: settings.pixel };
  let viewModel: ViewModel | null = null;
  let spectator: SpectatorController | null = null;
  const applyToggles = () => {
    gfx.bloom.enabled = toggles.bloom;
    input.sensitivity = toggles.sensitivity;
    camera.fov = toggles.fov;
    camera.updateProjectionMatrix();
    setPixelTextures(toggles.pixel, viewModel ? [scene, viewModel.scene] : [scene]);
    gfx.setShadows(settings.shadows);
    const look = { lines: settings.pixels, levels: settings.palette ? PALETTE_LEVELS : 0 };
    if (look.lines !== lastLook.lines || look.levels !== lastLook.levels) gfx.setLook((lastLook = look));
    // people fade out well before the map does: they are small and the most expensive to draw
    CHAR_LOD.far = Math.min(220, Math.max(90, settings.drawDistance * 0.3));
    CHAR_LOD.shadow = settings.shadows === 'off' ? 0 : settings.shadows === 'low' ? 30 : 45;
  };
  let lastLook = { lines: -1, levels: -1 };
  let statsHtml = () => '';
  const menu = setupMenu(input, audio, camera, toggles, settings, {
    onToggles: applyToggles,
    statsHtml: () => statsHtml(),
    onToggleSpectate: () => {
      if (!spectator) return false;
      if (spectator.active) {
        spectator.disable();
        return false;
      } else {
        spectator.enable('auto', camera.position, upOf(sim.state.frame));
        return true;
      }
    },
    onExitToMainMenu: () => {
      if (spectator?.active) spectator.disable();
      music.playMenuMusic();
    },
  });
  const lobby = new Lobby(settings.difficulty);
  let loaded = false;
  const spectateBtn = document.getElementById('spectate-btn') as HTMLButtonElement;
  const params = new URLSearchParams(location.search);
  const autostart = params.get('autostart') === '1';
  let startInSpectator = sessionStorage.getItem('gravwars-start-spectate') === '1' || params.get('spectate') === '1';
  if (startInSpectator) sessionStorage.removeItem('gravwars-start-spectate');
  document.body.dataset.state = 'title';
  const syncStart = (problem = lobby.problem) => {
    if (input.armed) return;
    start.disabled = !loaded || !!problem;
    start.textContent = loaded ? 'В бой' : 'Загрузка…';
    start.title = problem ?? '';
    spectateBtn.disabled = !loaded;
  };
  lobby.onChange = syncStart;
  lobby.onLevel = (d) => { settings.difficulty = d; saveSettings(settings); };
  const [R, assets] = await loading;
  // behind the menu: the default lobby's world, the camera drifting round the inside of the cube
  const backdrop = new MenuBackdrop(gfx);
  backdrop.start(assets, playerTeam(lobby.config) ?? 'red', activeTeams(lobby.config));
  applyToggles();
  (window as unknown as { __menu: MenuBackdrop }).__menu = backdrop;
  loaded = true;
  syncStart();
  // «В бой» or «Режим наблюдателя»: the click unlocks the audio and takes the mouse right away
  if (!startInSpectator && !autostart) {
    await new Promise<void>((resolve) => {
      function goPlay() {
        if (start.disabled) return;
        cleanup();
        lobby.save();
        audio.unlock();
        music.stopMenuMusic();
        input.armed = true;
        input.lock();
        resolve();
      }
      function goSpec() {
        if (spectateBtn.disabled) return;
        cleanup();
        startInSpectator = true;
        lobby.save();
        audio.unlock();
        music.stopMenuMusic();
        input.armed = true;
        input.lock();
        resolve();
      }
      function cleanup() {
        start.removeEventListener('click', goPlay);
        spectateBtn.removeEventListener('click', goSpec);
      }
      start.addEventListener('click', goPlay);
      spectateBtn.addEventListener('click', goSpec);
    });
  } else {
    input.armed = true;
    if (autostart) input.setLocked(true);
  }
  document.body.dataset.state = 'playing';
  lobby.hidden = true;
  const cfg = lobby.config;
  const myTeam = playerTeam(cfg)!;
  // the menu's world when the lobby still matches it (no second build): its last frame stays up while the rest is
  // built and the start flight leaves from the menu's camera; else a black "building" note
  const menuEye = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
  const built = backdrop.take(myTeam, activeTeams(cfg));
  if (!built) document.body.classList.add('building');
  await new Promise((r) => setTimeout(r, 30)); // let the hidden menu / the "building" note paint

  // --- simulation (shared with the future server)
  const map = built?.map ?? generateMap(1337, myTeam, activeTeams(cfg));
  const world = buildPhysicsWorld(R, map);
  const sim = new PlayerSim(R, world, map, myTeam);
  const combat = new Combat(R, world, map, [sim.mover.collider]);
  const blocks = new BlockSystem(R, world, sim.mover.collider);
  sim.gravity.blocks = () => blocks.blocks.values(); // built floors (bridges) are gravity surfaces
  combat.onWorldDamage = (handle, damage) => { blocks.damageCollider(handle, damage); };
  combat.onExplosion = (pos, radius, damage) => blocks.explosion(pos, radius, damage);
  combat.materialOf = (handle) => blocks.byCollider(handle)?.material ?? null;
  // crates and barrels are physics bodies: kicks, blasts and bullets move them
  const props = new Props(world, map);
  combat.props = props;
  const match = new Match(R, world, map, blocks, sim.team.id, sim.mover.collider);
  match.attach(combat); // crystals take damage from shots / blows (only from close up)
  const bots = new BotManager(R, world, map, combat, match, blocks, sim.team.id, 0, botRoster(cfg, startInSpectator));
  const pickups = new Pickups(R, world, map);
  bots.pickups = pickups; // bots pick up and sell what lies around, like the player
  const npcs = new NpcManager(R, world, map, combat, pickups);
  const throws = new Throws(combat, pickups);
  blocks.characters.push(...npcs.colliders);
  // the build tool and its blocks come from the shop
  blocks.inventory.wood = 0;

  // --- rendering
  const mapView = built?.mapView ?? buildMapView(map);
  if (!built) scene.add(mapView.group, buildPropView(map, assets));
  const fx = new Fx(scene);
  // blood stains land on the ground under the spray
  fx.ground = (pos, down) => {
    const hit = combat.rayWorld(pos, pos.clone().addScaledVector(down, 4));
    return hit ? { pos: pos.clone().addScaledVector(down, 4 * hit.t), normal: hit.normal } : null;
  };
  viewModel = new ViewModel(sim.team.color, assets);
  viewModel.environment = scene.environment;
  // the hands are drawn into the same small frame as the world (same pixels and palette)
  gfx.overlay.scene = viewModel.scene;
  gfx.overlay.camera = viewModel.camera;
  const gizmo = new GravityGizmo(map);

  // --- player, UI
  const hud = new Hud();
  const player = new PlayerCombat(sim, combat, hud, fx, audio, viewModel);
  const botView = new BotView(scene, bots, assets);
  // a killed fighter bursts into blood
  botView.onDeath = (pos) => {
    fx.blood(pos);
    const audioPos = spectator?.active ? camera.position : sim.state.pos;
    audio.gore(pos.distanceTo(audioPos));
  };
  fx.bleeds = (id) => {
    const n = combat.target(id)?.npc;
    return n === 'car' ? 0 : n ? 0.45 : 1;
  };
  blocks.onBreak = (b) => {
    fx.blockBreak(b);
    const audioPos = spectator?.active ? camera.position : sim.state.pos;
    audio.blockBreak(b.material, b.center.distanceTo(audioPos));
  };
  props.onBreak = (_i, pos, up, kind) => {
    pickups.dropCrateLoot(pos, up);
    fx.crateBreak(pos, kind);
    const audioPos = spectator?.active ? camera.position : sim.state.pos;
    audio.blockBreak(kind === 'crate' ? 'wood' : 'metal', pos.distanceTo(audioPos));
  };
  const npcView = new NpcView(scene, npcs, assets);
  const build = new BlockController(sim, input, blocks, audio, hud, scene, sim.team.id);
  build.onPlace = () => viewModel.dig();
  const eco = new Economy(match.wallet, blocks, player.weapons);
  const cursor = new Cursor(input);
  const ui = new MatchUi(match, eco, hud, audio, cursor);
  const pockets = new Pockets(eco, pickups, sim, player, hud, audio, map.ponds);
  const hands = new Hands(eco, player, build, pockets, throws, sim, audio, hud, viewModel, cursor);
  // grappling hook: bites the world (not people); the throw has its sound and kick in the hands
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
  spectator = new SpectatorController(input, combat, match, bots);
  if (startInSpectator) {
    player.me.alive = false;
    player.me.guard = { t: Infinity, from: new Vector3() };
    const pIdx = combat.targets.indexOf(player.me);
    if (pIdx >= 0) combat.targets.splice(pIdx, 1);
    sim.state.noclip = true;
    spectator.enable('auto', camera.position, upOf(sim.state.frame));
    spectateBtn.textContent = 'Вернуться в тело игрока';
  }
  match.onReviveAll = () => {
    bots.reviveAll();
    if (!player.me.alive) {
      sim.respawn('manual');
      player.reset();
      hud.toast('Кристалл воскресил всех павших!', '#7cf5ff', 2.4);
    }
  };
  player.canRespawn = () => match.onDeath();
  // killed: the pockets spill out where the body fell, and death music plays
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
  player.onFrag = (killer, victim, head) => stats.frag(killer, victim, head);
  player.onKill = (tg) => {
    if (tg.npc) return; // city NPCs pay with what they drop
    match.wallet.cash += KILL_REWARD;
  };

  // the bots of the player's team: what they are up to (Tab)
  const allies = bots.bots.filter((b) => b.team === myTeam);
  const alliesNow = () => allies.map((b, i) => ({
    name: `Бот ${i + 1}`, role: b.role === 'defend' ? 'защитник' : 'рейдер', status: b.status || '—',
    weapon: WEAPONS[b.weapons.current].name, cash: b.wallet.cash, alive: b.target.alive && !b.out,
  }));
  statsHtml = () => stats.teamsHtml(player.me.alive) + stats.alliesHtml(alliesNow()) + stats.personalHtml();
  // the debug panel (G) tunes the same values: keep them saved too
  const gui = createDebugGui(sim.cfg, sim.mover, toggles, () => {
    applyToggles();
    Object.assign(settings, { sensitivity: toggles.sensitivity, fov: toggles.fov, pixel: toggles.pixel });
    saveSettings(settings);
  });
  applyToggles();
  const scoreEl = document.getElementById('scoreboard')!;
  // scoreboard header: the bots' difficulty (one word if they are all the same)
  const levels = [...new Set(Object.values(botRoster(cfg)).flat())];
  const botsLabel = !levels.length ? 'без ботов' : levels.length === 1 ? `боты: ${DIFFICULTY_LABEL[levels[0]].toLowerCase()}` : 'боты: разные';
  let scoreT = 0;

  const local = new LocalPlayer(sim, input);
  let crystalAmmoT = 0;
  local.onTick = () => {
    // NPCs judge the player by how they move: speed, and whether they sneak (crouch)
    player.me.vel = sim.state.vel;
    player.me.quiet = local.input.crouch;
    player.me.crouched = local.input.crouch;
    if (cfg.infiniteMoney) { match.wallet.cash = 99999; match.wallet.crystal = 99999; }
    if (!match.result) { bots.tick(TICK_DT); npcs.tick(TICK_DT); }
    throws.tick(TICK_DT);
    props.tick(TICK_DT);
    // LMB fires only with a weapon in hand and no window open
    player.tick(!hands.tool && !cursor.active && !spectator?.active && input.locked && input.down('Mouse0'));
    match.tick(TICK_DT, sim.state.pos);
    // Replenish ammo near own living crystal
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
  };
  local.onEvent = (e) => {
    if (e.type === 'land') { if (player.me.alive) combat.fall(player.me, e.speed); return; }
    if (e.type === 'gravity') {
      const face = faceByUp(map, upOf(sim.state.frame));
      if (!face?.team) hud.toast('Гравитация: нейтральная грань', '#e8e2d0');
      else {
        const t = getTeam(face.team as TeamId);
        hud.toast(`Гравитация: ${t.name}`, teamHex(t.color));
      }
    } else if (e.type === 'respawn' && e.reason === 'manual') player.reset();
    else if (e.type === 'respawn' && e.reason === 'void') {
      if (player.death) return; // already dead (a body thrown off by the blast): the death screen is on
      stats.deaths++;
      pockets.spill(sim.state.pos, upOf(sim.state.frame), true); // the void keeps what you carried
      player.die('void');
      music.playDeathMusic();
    } else if (e.type === 'hook') {
      if (e.what === 'attach') audio.hookBite(sim.hook ? sim.hook.anchor.distanceTo(sim.state.pos) : 0);
      else if (e.what === 'release') audio.hookRelease();
    }
  };

  const handleKeys = createKeyHandler({
    input, sim, local, build, player, ui, hands, pockets, nearShop: () => match.nearShop(sim.state.pos), camera, hud, toggles, applyToggles, gui,
  });

  // test / debug hook
  const ambient: Area = { base: 0, forest: 0, park: 0, city: 0, water: 0 };
  const ambience = new Ambience(audio);
  (window as unknown as Record<string, unknown>).__game = {
    sim, local, input, camera, renderer, scene, gfx, combat, props, deathScreen, weapons: player.weapons, fx, blocks, match, bots, npcs, map, hud, icon, eco, pockets, pickups, ui, hands, throws, cursor, player, npcView, ambient, ambience, audio, spectator, music, ready: true,
    shoot(ticks = 1, weapon?: WeaponId) {
      if (weapon) player.pendingSelect = weapon;
      player.forceFire = ticks;
    },
    /** Start / resume without pointer lock (screenshots). */
    play() {
      input.setLocked(true);
    },
    /** Skip the match intro (screenshots, tests). */
    skipIntro() {
      intro.skip();
    },
    look(yaw: number, pitch: number) {
      input.yaw = yaw;
      input.pitch = pitch;
    },
  };

  // ambience: where the player is, sampled twice a second
  // downtown: near the glazed facades of the towers and offices
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
  // sprint feel: wider view, speed lines at the edges, wind in the ears
  const speedEl = document.getElementById('speedlines')!;
  let sprintT = 0;
  let zoomT = 0;
  let fovNow = 0;

  // --- the start: the camera flies from the menu's shot (or from above the base) in through the hall door behind the
  // player into the player's eyes
  local.applyCamera(camera);
  const eye = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
  const intro = new Intro(eye, upOf(sim.state.frame), built ? INTRO_LENGTH + 1.2 : INTRO_LENGTH + 0.4, {
    start: built ? menuEye : undefined, door: doorBehind(map, myTeam, eye) ?? undefined,
  });
  if (startInSpectator || autostart) intro.skip();
  else audio.whoosh();
  const fog = scene.fog as FogExp2;
  const FOG = fog.density;
  document.body.classList.remove('building');
  gfx.updateLighting(local.renderFrame);
  /** Intro frame: only the world moves (nothing is simulated), the camera flies. */
  const introFrame = (dt: number, t: number) => {
    if (input.take('Space') || input.take('Enter') || input.take('Mouse0')) intro.skip();
    intro.update(dt, camera);
    CHAR_LOD.eye.copy(camera.position);
    mapView.cull(camera.position, intro.active ? Infinity : settings.drawDistance);
    // the far shots need a clearer air
    const d = camera.position.distanceTo(eye.pos);
    fog.density = intro.active ? FOG * Math.min(1, Math.max(0.22, 1 - (d - 40) / 500)) : FOG;
    generators.update(t);
    keepers.update(dt, t);
    botView.update(dt, local.alpha);
    npcView.update(dt, local.alpha, camera);
    mapView.update(t, dt);
    gfx.overlay.enabled = false; // no hands while the camera flies in
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
  const frame = (now: number) => {
    // the first callback after the long synchronous build can carry a time stamp from before it: never step back
    const dt = Math.max(0, Math.min((now - last) / 1000, 0.1));
    last = Math.max(last, now);
    time += dt;
    if (intro.active) { introFrame(dt, time); gfx.scheduleFrame(frame); return; }
    const specActive = !!spectator?.active;
    if (!specActive) handleKeys();
    // the world never stops: with the menu open the player just stands (no input), everything else goes on
    local.frozen = !!player.death || specActive;
    local.update(dt);
    // footsteps and landings
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
      // a neutral face is the city all over (its square is far from the towers but it is still downtown)
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

      // Smooth 2x camera zoom on holding X or holding RMB with Crossbow
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
    // dead: the death camera has the view (unless spectator mode is active)
    const dead = specActive ? false : deathScreen.update(player.death, camera, dt);
    if (specActive) spectator!.update(dt, camera);
    else spectator?.update(dt, camera);

    // Hold E: pick up everything within a 1m radius in front of the player
    if (input.locked && !ui.shopOpen && !dead && !specActive && input.down('KeyE')) {
      pockets.pickupFrontRadius(camera);
    }

    CHAR_LOD.eye.copy(camera.position);
    mapView.cull(camera.position, settings.drawDistance);
    // windows (shop) take the mouse: the click goes to them, not to the hands
    const click = cursor.update();
    hands.update(dt, camera, input.locked && !cursor.active && !dead && !specActive && input.down('Mouse0'), click);
    if (cursor.active || specActive) build.active = false;
    build.update(dt, camera);
    gfx.updateLighting(local.renderFrame, time);

    // Sync two-stage crystal visuals & handle match events
    for (const b of match.beds) mapView.setBedStage(b.team, b.stage, b.invulnT);
    const sight = dead || specActive ? null : match.bedInSight(camera.position, camera.getWorldDirection(_wf));
    for (const e of match.events.splice(0)) {
      ui.onEvent(e);
      if (e.type === 'bedBroken' && e.byPlayer) stats.crystals++;
      if (e.type === 'win' || e.type === 'lose') {
        // let the banner play, then hand the mouse back for the summary and "New match"
        const title = e.type === 'win' ? `Победа · ${formatTime(e.time)}` : 'Поражение';
        setTimeout(() => {
          menu.showResult(title);
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
    // rod: LMB casts / strikes
    if (pockets.rod && input.locked && !cursor.active && !specActive && input.take('Mouse0')) pockets.useRod(camera);
    const pocketPrompt = pockets.update(dt, camera, () => viewModel!.cast());
    const actionProgress = hands.appleEatProgress > 0
      ? hands.appleEatProgress
      : player.weapons.current === 'crossbow' && player.weapons.chargeT > 0
      ? Math.min(1, player.weapons.chargeT / 3)
      : 0;
    const actionColor = hands.appleEatProgress > 0 ? '#7dff8a' : '#66f7ff';
    ui.update(match.nearShop(sim.state.pos), sight, pocketPrompt, click, actionProgress, actionColor);
    // thrown items: a bottle breaks (and dazes an NPC), the rest land
    for (const e of throws.events.splice(0)) {
      if (e.type === 'shatter') {
        audio.shatter(e.pos.distanceTo(camera.position));
        fx.burst(e.pos, null, 16, 3.2, new Color(0.45, 0.9, 0.5), 0.45);
        if (e.stunned) hud.hitmarker(false, false);
      } else if (e.type === 'land') audio.thud(e.pos.distanceTo(camera.position));
    }
    thrownView.update(dt);
    // bandits telegraph & exploding cars
    for (const e of npcs.events.splice(0)) {
      const d = e.pos.distanceTo(camera.position);
      if (e.type === 'windup') { if (e.grenade) audio.pin(d); else audio.cock(d); }
      else if (e.type === 'throw') { if (d < 25) audio.toss(); }
      else if (e.type === 'meleeSpark') { fx.meleeSpark(e.pos); audio.spark(d); }
      else if (e.type === 'meleeStrike') { fx.meleeStrike(e.pos, e.dir); audio.meleeDash(d); }
      else if (e.type === 'carExplode') { audio.carExplode(d); }
      else if (e.type === 'carAlarm') { audio.carAlarm(d); }
    }
    generators.update(time);
    pickupView.update(time, pockets.near);
    keepers.update(dt, time);
    guide.update(camera);

    botView.update(dt, local.alpha);
    npcView.update(dt, local.alpha, camera);
    grenadeWarn.update(camera, sim.state.pos);
    fx.down.copy(gfx.upDir).negate();
    fx.update(dt, combat, time);
    mapView.update(time, dt);
    if (!dead && !specActive) player.applyCameraKick(camera, dt);
    // crates and barrels that moved this tick
    for (const i of props.moved) mapView.setCrate(i, props.pos(i), props.quat(i), props.present(i));
    props.moved.clear();

    fishingView.update(time, pockets.rod && !specActive ? viewModel!.rodTipWorld(camera) : null);
    viewModel!.hookOut = !!sim.hook;
    hookView.update(sim.hook && !dead && !specActive ? viewModel!.hookClawWorld(camera) : null, fx.down);
    const invCam = camera.quaternion.clone().invert();
    const pUp = upOf(sim.state.frame);
    viewModel!.update(dt, {
      speed: sim.state.vel.clone().addScaledVector(pUp, -sim.state.vel.dot(pUp)).length(),
      lookDX: lastYaw - input.yaw, lookDY: input.pitch - lastPitch, reload: player.reloadProgress,
      empty: isGun(player.weapons.current) && player.weapons.ammo[player.weapons.current] === 0,
      charge: player.weapons.current === 'crossbow' ? Math.min(1, player.weapons.chargeT / 3) : 0,
      eatProgress: hands.appleEatProgress,
      sunCam: gfx.sunDir.clone().applyQuaternion(invCam), upCam: gfx.upDir.clone().applyQuaternion(invCam),
      aspect: camera.aspect,
    });
    lastYaw = input.yaw;
    lastPitch = input.pitch;
    viewModel!.bite = pockets.fishing.phase === 'bite' ? 1 : 0;
    gfx.overlay.enabled = !dead && !specActive;
    gfx.render(dt);

    // HUD wind: what the local player's projectiles feel
    const w = combat.wind.felt(combat.time, pUp.clone().negate());
    moveBasis(sim.state.frame, input.yaw, _wf, _wr);
    hud.setWind(Math.atan2(w.dot(_wr), w.dot(_wf)) - Math.PI / 2, w.length(), 0);
    hud.setWeapon(player.weapons, hands.tool, eco.items);
    hud.setKick(player.kickCooldown);
    viewQuat(local.renderFrame, input.yaw, input.pitch, viewQ);
    gizmo.render(renderer, viewQ, faceByUp(map, pUp)?.id ?? '');
    hud.setSpread(hands.tool ? null : player.nextSpread, camera.fov);
    hud.setGuard(player.me.guard && player.me.alive ? player.me.guard.t : null);
    hud.setHp(player.me.hp); // regen ticks it up between hits
    hud.update(dt, sim, `${(Math.hypot(...sim.state.pos.toArray())).toFixed(0)} м от центра`);
    stats.trackCash(match.wallet.cash);
    // scoreboard: hold Tab (in the shop Tab switches the tab)
    const showScore = input.locked && !ui.shopOpen && input.down('Tab');
    scoreEl.hidden = !showScore;
    scoreT -= dt;
    if (showScore && scoreT <= 0) {
      scoreT = 0.25;
      scoreEl.innerHTML = `<h3>Счёт<span>${botsLabel}</span></h3>${statsHtml()}`;
    }
    input.endFrame();
    gfx.scheduleFrame(frame);
  };
  gfx.scheduleFrame(frame);
}

main().catch((err: unknown) => {
  console.error(err);
  const start = document.getElementById('start-game') as HTMLButtonElement | null;
  if (start) start.textContent = 'Не удалось загрузить игру — обнови страницу';
});
