import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import './style.css';
import { Quaternion, Vector3 } from 'three';
import { BlockSystem } from '../shared/blocks';
import { BotManager } from '../shared/bots';
import { Combat } from '../shared/combat';
import { TICK_DT } from '../shared/constants';
import { generateMap } from '../shared/map';
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
import { Fx } from './render/fx';
import { GeneratorView } from './render/generatorView';
import { GravityGizmo } from './render/gizmo';
import { Graphics } from './render/graphics';
import { loadAssets } from './render/assets';
import { BotView } from './render/botView';
import { buildMapView } from './render/mapView';
import { buildPropView } from './render/propView';
import { PortalView } from './render/portalView';
import { ViewModel } from './render/viewmodel';

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay')!;

  // --- simulation (shared with the future server)
  const R = await initRapier();
  const map = generateMap();
  const world = buildPhysicsWorld(R, map);
  const sim = new PlayerSim(R, world, map, 'red');
  const combat = new Combat(R, world, map, sim.portals, [sim.mover.collider]);
  const blocks = new BlockSystem(R, world, sim.mover.collider);
  combat.onWorldDamage = (handle, damage) => { blocks.damageCollider(handle, damage); };
  combat.onExplosion = (pos, radius, damage) => blocks.explosion(pos, radius, damage);
  const match = new Match(R, world, map, blocks, sim.team.id, sim.mover.collider);
  const bots = new BotManager(R, world, map, combat, match, blocks, sim.team.id);
  blocks.characters.push(...bots.bots.map((b) => b.sim.mover.collider));

  // --- rendering
  const assets = await loadAssets();
  const gfx = new Graphics(canvas);
  const { renderer, scene, camera } = gfx;
  const mapView = buildMapView(map);
  scene.add(mapView.group);
  await document.fonts.load('800 64px Inter', 'МАГАЗИН КРАСНЫЕ'); // decals are drawn on canvases
  scene.add(buildPropView(map, assets));
  const portalView = new PortalView(renderer, scene, sim.portals);
  const fx = new Fx(scene);
  const viewModel = new ViewModel(sim.team.color, assets);
  viewModel.environment = scene.environment;
  const gizmo = new GravityGizmo();

  // --- player, UI
  const input = new Input(canvas, overlay);
  const audio = new GameAudio();
  const hud = new Hud();
  const player = new PlayerCombat(sim, combat, hud, fx, audio, viewModel);
  const botView = new BotView(scene, bots, assets);
  const build = new BlockController(sim, input, blocks, audio, hud, scene, sim.team.id);
  build.onPlace = () => viewModel.dig();
  const ui = new MatchUi(match, hud, audio, () => player.heal());
  const generators = new GeneratorView(scene, match);
  const guide = new Guide(match, bots, sim);
  player.canRespawn = () => match.onDeath();
  player.onKill = () => {
    match.wallet.copper += KILL_REWARD;
  };

  const toggles: DebugToggles = { portals: true, bloom: true, sensitivity: input.sensitivity, fov: 80 };
  const applyToggles = () => {
    portalView.enabled = toggles.portals;
    gfx.bloom.enabled = toggles.bloom;
    input.sensitivity = toggles.sensitivity;
    camera.fov = toggles.fov;
    camera.updateProjectionMatrix();
  };
  setupMenu(input, audio, camera, toggles);
  const gui = createDebugGui(sim.cfg, sim.mover, toggles, applyToggles);

  const local = new LocalPlayer(sim, input);
  local.onTick = () => {
    if (!match.result) bots.tick(TICK_DT);
    player.tick(!build.active && input.locked && input.down('Mouse0'));
    match.tick(TICK_DT, sim.state.pos);
  };
  local.onEvent = (e) => {
    if (e.type === 'gravity' || e.type === 'teleport') {
      const t = teamByDown(sim.gravityDown());
      hud.toast(`Гравитация: ${t.name}`, teamHex(t.color));
    } else if (e.type === 'respawn' && e.reason === 'manual') player.reset();
    else if (e.type === 'respawn' && e.reason === 'void') {
      hud.toast('Упал в пустоту', '#ff6b6b');
      if (match.onDeath()) player.reset();
      else player.me.alive = false;
    } else if (e.type === 'respawn' && e.reason === 'killed') hud.toast('Ты погиб', '#ff6b6b');
    else if (e.type === 'launch') hud.toast('Гейзер!', '#d7a8ff', 1);
  };

  window.addEventListener('resize', () => gfx.resize());
  const handleKeys = createKeyHandler({
    input, sim, local, build, player, ui, nearShop: () => match.nearShop(sim.state.pos), hud, toggles, applyToggles, gui,
  });

  // test / debug hook
  (window as unknown as Record<string, unknown>).__game = {
    sim, local, input, camera, renderer, portalView, combat, weapons: player.weapons, fx, blocks, match, bots, map, hud, icon, ready: true,
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
    local.applyCamera(camera);
    build.update(dt, camera);
    gfx.updateLighting(local.renderFrame);

    // bedwars: break enemy crystals (hold E), match events, UI
    match.breakTick(dt, camera.position, input.locked && !ui.shopOpen && input.down('KeyE'));
    const reachable = match.breaking ? null : match.reachableBed(camera.position);
    for (const e of match.events.splice(0)) {
      ui.onEvent(e);
      if (e.type === 'bedBroken') {
        mapView.setBedAlive(e.team, false);
        fx.handle({ type: 'explode', pos: match.bed(e.team).pos.clone(), radius: 3 });
        audio.explosion();
      }
    }
    ui.update(match.nearShop(sim.state.pos), reachable);
    generators.update(time);
    guide.update(camera);

    botView.update(dt, local.alpha);
    fx.down.copy(gfx.upDir).negate();
    fx.update(dt, combat, time);
    mapView.update(time, dt);
    player.applyCameraKick(camera, dt);

    portalView.render(camera, time);
    gfx.render(dt);
    const invCam = camera.quaternion.clone().invert();
    const pUp = upOf(sim.state.frame);
    viewModel.update(dt, {
      speed: sim.state.vel.clone().addScaledVector(pUp, -sim.state.vel.dot(pUp)).length(),
      lookDX: lastYaw - input.yaw, lookDY: input.pitch - lastPitch, reload: player.reloadProgress,
      sunCam: gfx.sunDir.clone().applyQuaternion(invCam), upCam: gfx.upDir.clone().applyQuaternion(invCam),
      aspect: camera.aspect,
    });
    lastYaw = input.yaw;
    lastPitch = input.pitch;
    viewModel.setTool(build.active);
    viewModel.render(renderer);

    // HUD wind: what the local player's projectiles feel
    const w = combat.wind.felt(combat.time, pUp.clone().negate());
    moveBasis(sim.state.frame, input.yaw, _wf, _wr);
    hud.setWind(Math.atan2(w.dot(_wr), w.dot(_wf)) - Math.PI / 2, w.length(), 0);
    hud.setWeapon(player.weapons, build.active);
    viewQuat(local.renderFrame, input.yaw, input.pitch, viewQ);
    gizmo.render(renderer, viewQ, teamByDown(sim.gravityDown()).id);
    hud.update(dt, sim, `${(Math.hypot(...sim.state.pos.toArray())).toFixed(0)} м от центра`);
    input.endFrame();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();
