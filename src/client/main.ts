import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import './style.css';
import { Quaternion, Vector3 } from 'three';
import { BlockSystem } from '../shared/blocks';
import { applyDifficulty, BotManager, DIFFICULTY_LABEL } from '../shared/bots';
import { Combat } from '../shared/combat';
import { TICK_DT } from '../shared/constants';
import { generateMap } from '../shared/map';
import { NpcManager } from '../shared/npcs';
import { Economy, Pickups } from '../shared/economy';
import { KILL_REWARD, Match } from '../shared/match';
import { upOf } from '../shared/math';
import { moveBasis, viewQuat } from '../shared/movement';
import { buildPhysicsWorld, initRapier } from '../shared/physics';
import { PlayerSim } from '../shared/sim';
import { teamByDown } from '../shared/teams';
import type { WeaponId } from '../shared/weapons';
import { GameAudio } from './audio';
import { BlockController } from './blockController';
import { createDebugGui, DebugToggles } from './debugGui';
import { Hud, teamHex } from './hud';
import { Input } from './input';
import { createKeyHandler } from './keybinds';
import { LocalPlayer } from './localPlayer';
import { Guide } from './guide';
import { icon } from './icons';
import { MatchUi } from './matchUi';
import { setupMenu } from './menu';
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
import { FishingView, PickupView } from './render/pickupView';
import { buildMapView } from './render/mapView';
import { buildPropView } from './render/propView';
import { ViewModel } from './render/viewmodel';
import { setPixelTextures } from './render/texFilter';
import { loadSettings, saveSettings } from './settings';
import { formatTime, MatchStats } from './stats';

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay')!;

  // --- simulation (shared with the future server)
  const settings = loadSettings();
  /** Difficulty of the running match (a change mid-match waits for the next one). */
  let difficulty = settings.difficulty;
  applyDifficulty(difficulty);
  const R = await initRapier();
  const map = generateMap();
  const world = buildPhysicsWorld(R, map);
  const sim = new PlayerSim(R, world, map, 'red');
  const combat = new Combat(R, world, map, [sim.mover.collider]);
  const blocks = new BlockSystem(R, world, sim.mover.collider);
  sim.gravity.blocks = () => blocks.blocks.values(); // built floors (bridges) are gravity surfaces
  combat.onWorldDamage = (handle, damage) => { blocks.damageCollider(handle, damage); };
  combat.onExplosion = (pos, radius, damage) => blocks.explosion(pos, radius, damage);
  combat.materialOf = (handle) => blocks.byCollider(handle)?.material ?? null;
  const match = new Match(R, world, map, blocks, sim.team.id, sim.mover.collider);
  const bots = new BotManager(R, world, map, combat, match, blocks, sim.team.id);
  const pickups = new Pickups(R, world, map);
  const npcs = new NpcManager(R, world, map, combat, pickups);
  blocks.characters.push(...npcs.colliders);
  // the build tool and its blocks come from the shop
  blocks.inventory.wood = 0;

  // --- rendering
  const assets = await loadAssets();
  const gfx = new Graphics(canvas);
  const { renderer, scene, camera } = gfx;
  const mapView = buildMapView(map);
  scene.add(mapView.group);
  await document.fonts.load('800 64px Inter', 'МАГАЗИН КРАСНЫЕ'); // decals are drawn on canvases
  scene.add(buildPropView(map, assets));
  const fx = new Fx(scene);
  const viewModel = new ViewModel(sim.team.color, assets);
  viewModel.environment = scene.environment;
  const gizmo = new GravityGizmo();

  // --- player, UI
  const input = new Input(canvas, overlay);
  const audio = new GameAudio();
  audio.volume = settings.volume;
  const hud = new Hud();
  const player = new PlayerCombat(sim, combat, hud, fx, audio, viewModel);
  const botView = new BotView(scene, bots, assets);
  const npcView = new NpcView(scene, npcs, assets);
  const build = new BlockController(sim, input, blocks, audio, hud, scene, sim.team.id);
  build.onPlace = () => viewModel.dig();
  const eco = new Economy(match.wallet, blocks, player.weapons);
  const ui = new MatchUi(match, eco, hud, audio, () => player.heal());
  const pockets = new Pockets(eco, pickups, sim, player, hud, audio, map.ponds);
  const pickupView = new PickupView(scene, pickups);
  const fishingView = new FishingView(scene, pockets.fishing);
  const keepers = new KeeperView(scene, map, assets);
  const generators = new GeneratorView(scene, match);
  const guide = new Guide(match, bots, sim);
  player.canRespawn = () => match.onDeath();
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

  const toggles: DebugToggles = { bloom: true, sensitivity: settings.sensitivity, fov: settings.fov, pixel: settings.pixel };
  const applyToggles = () => {
    gfx.bloom.enabled = toggles.bloom;
    input.sensitivity = toggles.sensitivity;
    camera.fov = toggles.fov;
    camera.updateProjectionMatrix();
    setPixelTextures(toggles.pixel, [scene, viewModel.scene]);
  };
  const statsHtml = () => stats.teamsHtml(player.me.alive) + stats.personalHtml();
  const menu = setupMenu(input, audio, camera, toggles, settings, {
    onToggles: applyToggles,
    onDifficulty: (d) => { difficulty = d; applyDifficulty(d); bots.retime(); },
    statsHtml,
  });
  // the debug panel (G) tunes the same values: keep them saved too
  const gui = createDebugGui(sim.cfg, sim.mover, toggles, () => {
    applyToggles();
    Object.assign(settings, { sensitivity: toggles.sensitivity, fov: toggles.fov, pixel: toggles.pixel });
    saveSettings(settings);
  });
  applyToggles();
  const scoreEl = document.getElementById('scoreboard')!;
  let scoreT = 0;

  const local = new LocalPlayer(sim, input);
  local.onTick = () => {
    // NPCs judge the player by how they move: speed, and whether they sneak (crouch)
    player.me.vel = sim.state.vel;
    player.me.quiet = local.input.crouch;
    player.me.crouched = local.input.crouch;
    if (!match.result) { bots.tick(TICK_DT); npcs.tick(TICK_DT); }
    player.tick(!build.active && !pockets.rod && !ui.shopOpen && input.locked && input.down('Mouse0'));
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
      if (match.onDeath()) player.reset();
      else player.me.alive = false;
    } else if (e.type === 'respawn' && e.reason === 'killed') hud.toast('Ты погиб', '#ff6b6b');
  };

  window.addEventListener('resize', () => gfx.resize());
  const handleKeys = createKeyHandler({
    input, sim, local, build, player, ui, eco, pockets, nearShop: () => match.nearShop(sim.state.pos), hud, toggles, applyToggles, gui,
  });

  // test / debug hook
  (window as unknown as Record<string, unknown>).__game = {
    sim, local, input, camera, renderer, combat, weapons: player.weapons, fx, blocks, match, bots, npcs, map, hud, icon, eco, pockets, pickups, ui, ready: true,
    shoot(ticks = 1, weapon?: WeaponId) {
      if (weapon) player.pendingSelect = weapon;
      player.forceFire = ticks;
    },
    /** Start / resume without pointer lock (screenshots). */
    play() {
      input.setLocked(true);
    },
    look(yaw: number, pitch: number) {
      input.yaw = yaw;
      input.pitch = pitch;
    },
  };

  // ambience: where the player is, sampled twice a second
  const ambient = { wind: 0.3, city: 0, water: 0, birds: 0 };
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
      const city = Math.max(0, Math.min(1, 1 - (nearest(map.houses, pos) - 15) / 60));
      ambient.city = city;
      ambient.birds = Math.max(0, Math.min(1, 1 - nearest(map.trees, pos) / 22));
      ambient.water = Math.max(0, Math.min(1, 1 - nearest(map.ponds, pos) / 16));
      ambient.wind = Math.min(1, 0.3 + (1 - city) * 0.35 + sim.state.vel.length() / 40);
    }
    audio.ambience(ambient, dt);
    local.applyCamera(camera);
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
    if (pockets.rod && input.locked && !ui.shopOpen && input.take('Mouse0')) pockets.useRod(camera);
    const pocketPrompt = pockets.update(dt, camera, () => viewModel.cast());
    ui.update(match.nearShop(sim.state.pos), reachable, pocketPrompt);
    generators.update(time);
    pickupView.update(time, pockets.near);
    keepers.update(dt, time);
    guide.update(camera);

    botView.update(dt, local.alpha);
    npcView.update(dt, local.alpha, camera);
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
    viewModel.setTool(build.active ? 'build' : pockets.rod ? 'rod' : null);
    viewModel.bite = pockets.fishing.phase === 'bite' ? 1 : 0;
    viewModel.render(renderer);

    // HUD wind: what the local player's projectiles feel
    const w = combat.wind.felt(combat.time, pUp.clone().negate());
    moveBasis(sim.state.frame, input.yaw, _wf, _wr);
    hud.setWind(Math.atan2(w.dot(_wr), w.dot(_wf)) - Math.PI / 2, w.length(), 0);
    hud.setWeapon(player.weapons, build.active ? 'build' : pockets.rod ? 'rod' : null, { build: eco.has('builder'), rod: eco.has('rod') });
    viewQuat(local.renderFrame, input.yaw, input.pitch, viewQ);
    const gDown = sim.gravityDown();
    gizmo.render(renderer, viewQ, Math.abs(gDown.z) > 0.9 ? '' : teamByDown(gDown).id);
    hud.setSpread(build.active || pockets.rod ? null : player.nextSpread, camera.fov);
    hud.setGuard(player.me.guard && player.me.alive ? player.me.guard.t : null);
    hud.update(dt, sim, `${(Math.hypot(...sim.state.pos.toArray())).toFixed(0)} м от центра`);
    stats.trackCash(match.wallet.cash);
    // scoreboard: hold Tab (in the shop Tab switches the tab)
    const showScore = input.locked && !ui.shopOpen && input.down('Tab');
    scoreEl.hidden = !showScore;
    scoreT -= dt;
    if (showScore && scoreT <= 0) {
      scoreT = 0.25;
      scoreEl.innerHTML = `<h3>Счёт<span>боты: ${DIFFICULTY_LABEL[difficulty].toLowerCase()}</span></h3>${statsHtml()}`;
    }
    input.endFrame();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  // the button stays disabled while wasm, models and fonts load: every handler is wired up by now
  const start = document.getElementById('start-game') as HTMLButtonElement;
  start.disabled = false;
  start.textContent = 'Играть';
}

main().catch((err: unknown) => {
  console.error(err);
  const start = document.getElementById('start-game') as HTMLButtonElement | null;
  if (start) start.textContent = 'Не удалось загрузить игру — обнови страницу';
});
