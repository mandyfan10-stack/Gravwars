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
import { generateMap } from '../shared/map';
import { activeTeams, botRoster, playerTeam } from '../shared/lobby';
import { NpcManager } from '../shared/npcs';
import { Economy, Pickups } from '../shared/economy';
import { KILL_REWARD, Match } from '../shared/match';
import { upOf } from '../shared/math';
import { moveBasis, viewQuat } from '../shared/movement';
import { buildPhysicsWorld, initRapier } from '../shared/physics';
import { PlayerSim } from '../shared/sim';
import { getTeam, teamByDown, TeamId } from '../shared/teams';
import { Throws } from '../shared/throwables';
import type { WeaponId } from '../shared/weapons';
import { Ambience, Area } from './ambience';
import { GameAudio } from './audio';
import { BlockController } from './blockController';
import { Cursor } from './cursor';
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
import { Intro } from './intro';
import { INTRO_MUSIC_LENGTH, playIntroMusic } from './music';
import { PlayerCombat } from './playerCombat';
import { Pockets } from './pockets';
import { Fx } from './render/fx';
import { GeneratorView } from './render/generatorView';
import { GravityGizmo } from './render/gizmo';
import { Graphics } from './render/graphics';
import { loadAssets } from './render/assets';
import { BotView } from './render/botView';
import { KeeperView } from './render/keeperView';
import { NpcView } from './render/npcView';
import { FishingView, PickupView, ThrownView } from './render/pickupView';
import { buildMapView } from './render/mapView';
import { buildPropView } from './render/propView';
import { ViewModel } from './render/viewmodel';
import { setPixelTextures } from './render/texFilter';
import { loadSettings, saveSettings } from './settings';
import { formatTime, MatchStats } from './stats';

/** Seconds from the start of the intro to the camera landing in the player's eyes (the music's big hit). */
const INTRO_LENGTH = INTRO_MUSIC_LENGTH - 5;

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay')!;
  const start = document.getElementById('start-game') as HTMLButtonElement;

  // --- before the match: menu + lobby while wasm, models and fonts load
  const settings = loadSettings();
  const loading = Promise.all([initRapier(), loadAssets(), document.fonts.load('800 64px Inter', 'МАГАЗИН КРАСНЫЕ')]);
  const gfx = new Graphics(canvas);
  const { renderer, scene, camera } = gfx;
  const input = new Input(canvas, overlay);
  const audio = new GameAudio();
  audio.volume = settings.volume;
  const toggles: DebugToggles = { bloom: true, sensitivity: settings.sensitivity, fov: settings.fov, pixel: settings.pixel };
  let viewModel: ViewModel | null = null;
  const applyToggles = () => {
    gfx.bloom.enabled = toggles.bloom;
    input.sensitivity = toggles.sensitivity;
    camera.fov = toggles.fov;
    camera.updateProjectionMatrix();
    setPixelTextures(toggles.pixel, viewModel ? [scene, viewModel.scene] : [scene]);
  };
  let statsHtml = () => '';
  const menu = setupMenu(input, audio, camera, toggles, settings, { onToggles: applyToggles, statsHtml: () => statsHtml() });
  const lobby = new Lobby(settings.difficulty);
  let loaded = false;
  const syncStart = (problem = lobby.problem) => {
    if (input.armed) return;
    start.disabled = !loaded || !!problem;
    start.textContent = loaded ? 'В бой' : 'Загрузка…';
    start.title = problem ?? '';
  };
  lobby.onChange = syncStart;
  lobby.onLevel = (d) => { settings.difficulty = d; saveSettings(settings); };
  const [R, assets] = await loading;
  loaded = true;
  syncStart();
  // «В бой»: the click unlocks the audio and takes the mouse right away (a user gesture is needed for both)
  await new Promise<void>((resolve) => start.addEventListener('click', function go() {
    if (start.disabled) return;
    start.removeEventListener('click', go);
    lobby.save();
    audio.unlock();
    input.armed = true;
    input.lock();
    resolve();
  }));
  lobby.hidden = true;
  document.body.classList.add('building');
  await new Promise((r) => setTimeout(r, 30)); // let the "building" note paint

  // --- simulation (shared with the future server)
  const cfg = lobby.config;
  const myTeam = playerTeam(cfg)!;
  const map = generateMap(1337, myTeam, activeTeams(cfg));
  const world = buildPhysicsWorld(R, map);
  const sim = new PlayerSim(R, world, map, myTeam);
  const combat = new Combat(R, world, map, [sim.mover.collider]);
  const blocks = new BlockSystem(R, world, sim.mover.collider);
  sim.gravity.blocks = () => blocks.blocks.values(); // built floors (bridges) are gravity surfaces
  combat.onWorldDamage = (handle, damage) => { blocks.damageCollider(handle, damage); };
  combat.onExplosion = (pos, radius, damage) => blocks.explosion(pos, radius, damage);
  combat.materialOf = (handle) => blocks.byCollider(handle)?.material ?? null;
  const match = new Match(R, world, map, blocks, sim.team.id, sim.mover.collider);
  const bots = new BotManager(R, world, map, combat, match, blocks, sim.team.id, 0, botRoster(cfg));
  const pickups = new Pickups(R, world, map);
  const npcs = new NpcManager(R, world, map, combat, pickups);
  const throws = new Throws(combat, pickups);
  blocks.characters.push(...npcs.colliders);
  // the build tool and its blocks come from the shop
  blocks.inventory.wood = 0;

  // --- rendering
  const mapView = buildMapView(map);
  scene.add(mapView.group);
  scene.add(buildPropView(map, assets));
  const fx = new Fx(scene);
  viewModel = new ViewModel(sim.team.color, assets);
  viewModel.environment = scene.environment;
  const gizmo = new GravityGizmo();

  // --- player, UI
  const hud = new Hud();
  const player = new PlayerCombat(sim, combat, hud, fx, audio, viewModel);
  const botView = new BotView(scene, bots, assets);
  const npcView = new NpcView(scene, npcs, assets);
  const build = new BlockController(sim, input, blocks, audio, hud, scene, sim.team.id);
  build.onPlace = () => viewModel.dig();
  const eco = new Economy(match.wallet, blocks, player.weapons);
  const cursor = new Cursor(input);
  const ui = new MatchUi(match, eco, hud, audio, cursor);
  const pockets = new Pockets(eco, pickups, sim, player, hud, audio, map.ponds);
  const hands = new Hands(eco, player, build, pockets, throws, sim, audio, hud, viewModel, cursor);
  const pickupView = new PickupView(scene, pickups);
  const thrownView = new ThrownView(scene, throws);
  const grenadeWarn = new GrenadeWarn(combat);
  const fishingView = new FishingView(scene, pockets.fishing);
  const keepers = new KeeperView(scene, map, assets);
  const generators = new GeneratorView(scene, match);
  const guide = new Guide(match, bots, sim);
  player.canRespawn = () => match.onDeath();
  // killed: the pockets spill out where the body fell
  player.onDeath = (pos, up) => pockets.spill(pos, up, false);
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

  statsHtml = () => stats.teamsHtml(player.me.alive) + stats.personalHtml();
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
  local.onTick = () => {
    // NPCs judge the player by how they move: speed, and whether they sneak (crouch)
    player.me.vel = sim.state.vel;
    player.me.quiet = local.input.crouch;
    player.me.crouched = local.input.crouch;
    if (!match.result) { bots.tick(TICK_DT); npcs.tick(TICK_DT); }
    throws.tick(TICK_DT);
    // LMB fires only with a weapon in hand and no window open
    player.tick(!hands.tool && !cursor.active && input.locked && input.down('Mouse0'));
    match.tick(TICK_DT, sim.state.pos);
  };
  local.onEvent = (e) => {
    if (e.type === 'gravity') {
      const down = sim.gravityDown();
      if (Math.abs(down.z) > 0.9) hud.toast('Гравитация: центр', '#e8e2d0');
      else {
        const t = teamByDown(down);
        hud.toast(`Гравитация: ${t.name}`, teamHex(t.color));
      }
    } else if (e.type === 'respawn' && e.reason === 'manual') player.reset();
    else if (e.type === 'respawn' && e.reason === 'void') {
      stats.deaths++;
      hud.toast('Упал в пустоту', '#ff6b6b');
      pockets.spill(sim.state.pos, upOf(sim.state.frame), true); // the void keeps what you carried
      if (match.onDeath()) player.reset();
      else player.me.alive = false;
    } else if (e.type === 'respawn' && e.reason === 'killed') hud.toast('Ты погиб', '#ff6b6b');
  };

  window.addEventListener('resize', () => gfx.resize());
  const handleKeys = createKeyHandler({
    input, sim, local, build, player, ui, hands, pockets, nearShop: () => match.nearShop(sim.state.pos), camera, hud, toggles, applyToggles, gui,
  });

  // test / debug hook
  const ambient: Area = { base: 0, forest: 0, park: 0, city: 0, water: 0 };
  const ambience = new Ambience(audio);
  (window as unknown as Record<string, unknown>).__game = {
    sim, local, input, camera, renderer, scene, combat, weapons: player.weapons, fx, blocks, match, bots, npcs, map, hud, icon, eco, pockets, pickups, ui, hands, throws, cursor, player, npcView, ambient, ambience, audio, ready: true,
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
      music?.stop(0.2);
    },
    look(yaw: number, pitch: number) {
      input.yaw = yaw;
      input.pitch = pitch;
    },
  };

  // ambience: where the player is, sampled twice a second
  const cityPts = [...map.houses, ...map.buildings];
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

  // --- the intro: a flight over the map to the player's eyes, with music
  local.applyCamera(camera);
  const eye = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
  const roster = botRoster(cfg);
  const botsWord = (n: number) => (n === 1 ? 'бот' : n < 5 ? 'бота' : 'ботов');
  const about = (t: TeamId) => {
    const n = roster[t]?.length ?? 0;
    const who = t === myTeam ? (n ? `ты и ${n} ${botsWord(n)}` : 'ты') : `${n} ${botsWord(n)}`;
    return `${getTeam(t).name} · ${who}`;
  };
  const music = audio.context ? playIntroMusic(audio.context, audio.volume) : null;
  const intro = new Intro(map, activeTeams(cfg), myTeam, eye, about, INTRO_LENGTH);
  const ctx = audio.context;
  if (ctx && ctx.state === 'running') { const t0 = ctx.currentTime + 0.1; intro.clock = () => ctx.currentTime - t0; }
  const fog = scene.fog as FogExp2;
  const FOG = fog.density;
  document.body.classList.remove('building');
  gfx.updateLighting(local.renderFrame);
  /** Intro frame: only the world moves (nothing is simulated), the camera flies. */
  const introFrame = (dt: number, t: number) => {
    if (input.take('Space') || input.take('Enter') || input.take('Mouse0')) { intro.skip(); music?.stop(1.5); }
    intro.update(dt, camera);
    // the far shots need a clearer air
    const d = camera.position.distanceTo(eye.pos);
    fog.density = intro.active ? FOG * Math.min(1, Math.max(0.22, 1 - (d - 40) / 500)) : FOG;
    generators.update(t);
    keepers.update(dt, t);
    botView.update(dt, local.alpha);
    npcView.update(dt, local.alpha, camera);
    mapView.update(t, dt);
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
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    time += dt;
    if (intro.active) { introFrame(dt, time); requestAnimationFrame(frame); return; }
    handleKeys();
    local.update(input.locked ? dt : 0);
    // footsteps and landings
    if (local.landed) { audio.land(local.landed); local.landed = 0; local.stride = 0; }
    if (local.stride > STEP_LEN) {
      local.stride = 0;
      if (!local.input.crouch) audio.step(false);
    }
    ambientT -= dt;
    if (ambientT <= 0) {
      ambientT = 0.5;
      const pos = sim.state.pos;
      const base = clamp01(1 - (nearest(map.statues.map((t) => t.bed), pos) - 14) / 8);
      let trees = 0;
      for (const t of map.trees) if (t.kind === 'tree' && (t.pos[0] - pos.x) ** 2 + (t.pos[1] - pos.y) ** 2 + (t.pos[2] - pos.z) ** 2 < 25 * 25) trees++;
      ambient.base = base;
      ambient.forest = clamp01((trees - 6) / 8) * (1 - base);
      ambient.park = clamp01(1 - nearest(map.trees, pos) / 22) * (1 - ambient.forest) * (1 - base);
      // the central island is the city all over (its plaza is far from the towers but it is still downtown)
      let isl = map.islands[0], bestD = Infinity;
      for (const i of map.islands) {
        const d = (i.origin[0] - pos.x) ** 2 + (i.origin[1] - pos.y) ** 2 + (i.origin[2] - pos.z) ** 2;
        if (d < bestD) { bestD = d; isl = i; }
      }
      ambient.city = Math.max(isl.id === 'center' ? 0.7 : 0, clamp01(1 - (nearest(cityPts, pos) - 15) / 60)) * (1 - base * 0.7);
      ambient.water = clamp01(1 - nearest(map.ponds, pos) / 16);
    }
    if (input.locked) ambience.update(ambient, dt);
    local.applyCamera(camera);
    // windows (shop, inventory) take the mouse: the click goes to them, not to the hands
    const click = cursor.update();
    hands.update(dt, camera, input.locked && !cursor.active && input.down('Mouse0'), click);
    if (cursor.active) build.active = false;
    build.update(dt, camera);
    gfx.updateLighting(local.renderFrame);

    // bedwars: break enemy crystals (hold E), match events, UI
    match.breakTick(dt, camera.position, input.locked && !ui.shopOpen && input.down('KeyE'));
    const reachable = match.breaking ? null : match.reachableBed(camera.position);
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
      if (e.type === 'bedBroken') {
        mapView.setBedAlive(e.team, false);
        fx.handle({ type: 'explode', pos: match.bed(e.team).pos.clone(), radius: 3 });
        audio.explosion();
      }
    }
    // rod: LMB casts / strikes
    if (pockets.rod && input.locked && !cursor.active && input.take('Mouse0')) pockets.useRod(camera);
    const pocketPrompt = pockets.update(dt, camera, () => viewModel.cast());
    ui.update(match.nearShop(sim.state.pos), reachable, pocketPrompt, click);
    // thrown items: a bottle breaks (and dazes an NPC), the rest land
    for (const e of throws.events.splice(0)) {
      if (e.type === 'shatter') {
        audio.shatter(e.pos.distanceTo(sim.state.pos));
        fx.burst(e.pos, null, 16, 3.2, new Color(0.45, 0.9, 0.5), 0.45);
        if (e.stunned) hud.hitmarker(false, false);
      } else if (e.type === 'land') audio.thud(e.pos.distanceTo(sim.state.pos));
    }
    thrownView.update(dt);
    // bandits telegraph: the slide racked before a burst, the pin pulled before a throw
    for (const e of npcs.events.splice(0)) {
      const d = e.pos.distanceTo(sim.state.pos);
      if (e.type === 'windup') { if (e.grenade) audio.pin(d); else audio.cock(d); }
      else if (d < 25) audio.toss();
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
    player.applyCameraKick(camera, dt);

    fishingView.update(time, pockets.rod ? viewModel.rodTipWorld(camera) : null);
    gfx.render(dt);
    const invCam = camera.quaternion.clone().invert();
    const pUp = upOf(sim.state.frame);
    viewModel.update(dt, {
      speed: sim.state.vel.clone().addScaledVector(pUp, -sim.state.vel.dot(pUp)).length(),
      lookDX: lastYaw - input.yaw, lookDY: input.pitch - lastPitch, reload: player.reloadProgress,
      empty: (player.weapons.current === 'pistol' || player.weapons.current === 'rifle') && player.weapons.ammo[player.weapons.current] === 0,
      sunCam: gfx.sunDir.clone().applyQuaternion(invCam), upCam: gfx.upDir.clone().applyQuaternion(invCam),
      aspect: camera.aspect,
    });
    lastYaw = input.yaw;
    lastPitch = input.pitch;
    viewModel.bite = pockets.fishing.phase === 'bite' ? 1 : 0;
    viewModel.render(renderer);

    // HUD wind: what the local player's projectiles feel
    const w = combat.wind.felt(combat.time, pUp.clone().negate());
    moveBasis(sim.state.frame, input.yaw, _wf, _wr);
    hud.setWind(Math.atan2(w.dot(_wr), w.dot(_wf)) - Math.PI / 2, w.length(), 0);
    hud.setWeapon(player.weapons, hands.tool, eco.items);
    viewQuat(local.renderFrame, input.yaw, input.pitch, viewQ);
    const gDown = sim.gravityDown();
    gizmo.render(renderer, viewQ, Math.abs(gDown.z) > 0.9 ? '' : teamByDown(gDown).id);
    hud.setSpread(hands.tool ? null : player.nextSpread, camera.fov);
    hud.setGuard(player.me.guard && player.me.alive ? player.me.guard.t : null);
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
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main().catch((err: unknown) => {
  console.error(err);
  const start = document.getElementById('start-game') as HTMLButtonElement | null;
  if (start) start.textContent = 'Не удалось загрузить игру — обнови страницу';
});
