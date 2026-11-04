import './style.css';
import {
  ACESFilmicToneMapping, Color, DirectionalLight, FogExp2, HemisphereLight, PCFShadowMap, PerspectiveCamera,
  PMREMGenerator, Quaternion, Scene, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { Combat, CombatEvent, MAX_HP, Target } from '../shared/combat';
import { BUILD_COST, BUILD_MATERIALS, BuildSystem, BuildKind, BuildMaterial, BuildPlan, BuildResult, planBuild } from '../shared/building';
import { buildAim } from '../shared/buildAim';
import { EYE_OFFSET, PLAYER_HEIGHT, TICK_DT, WORLD } from '../shared/constants';
import { generateMap } from '../shared/map';
import { upOf } from '../shared/math';
import { moveBasis, viewQuat } from '../shared/movement';
import { buildPhysicsWorld, initRapier } from '../shared/physics';
import { PlayerSim } from '../shared/sim';
import { getTeam, TEAMS, teamByDown } from '../shared/teams';
import { createWeaponState, WeaponId, WEAPONS, weaponTick } from '../shared/weapons';
import { createDebugGui, DebugToggles } from './debugGui';
import { Hud, teamHex } from './hud';
import { Input } from './input';
import { LocalPlayer } from './localPlayer';
import { GravityGizmo } from './render/gizmo';
import { buildMapView } from './render/mapView';
import { PlayerModel } from './render/playerModel';
import { PortalView } from './render/portalView';
import { Fx } from './render/fx';
import { createSky, HAZE } from './render/sky';
import { ViewModel } from './render/viewmodel';
import { BuildView } from './render/buildView';
import { BuildWheel } from './buildWheel';
import { GameAudio } from './audio';

interface Dummy {
  model: PlayerModel;
  base: Vector3;
  frame: Quaternion;
  yaw: number;
  hop: number;
  phase: number;
  target: Target;
}

async function main() {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const overlay = document.getElementById('overlay')!;

  // --- simulation (shared with the future server)
  const R = await initRapier();
  const map = generateMap();
  const world = buildPhysicsWorld(R, map);
  const sim = new PlayerSim(R, world, map, 'red');
  const combat = new Combat(R, world, map, sim.portals, [sim.mover.collider]);
  const me: Target = {
    id: 0, team: sim.team.id, center: sim.state.pos, up: new Vector3(0, 1, 0), hp: MAX_HP, alive: true, respawnIn: -1,
    onImpulse: (v) => sim.applyImpulse(v),
  };
  combat.targets.push(me);
  const weapons = createWeaponState();
  const buildings = new BuildSystem(R, world, sim.mover.collider);
  combat.onWorldDamage = (handle, damage) => { buildings.damageCollider(handle, damage); };
  combat.onExplosion = (pos, radius, damage) => buildings.explosion(pos, radius, damage);

  // --- rendering
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();
  scene.background = new Color(HAZE);
  scene.fog = new FogExp2(HAZE, 0.0042);
  const camera = new PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.05, 3000);

  const { sky, uniforms: skyU } = createSky();
  // image-based lighting from the (sunless) haze dome: soft warm ambient + reflections for glass/water
  {
    const envScene = new Scene();
    const envSky = createSky();
    envSky.uniforms.sunStrength.value = 0.35;
    envScene.add(envSky.sky);
    const pm = new PMREMGenerator(renderer);
    scene.environment = pm.fromScene(envScene, 0, 1, 2000).texture;
    scene.environmentIntensity = 0.55;
    pm.dispose();
  }
  scene.add(sky);
  const hemi = new HemisphereLight(0xfff1dc, 0x8a7a62, 0.55);
  scene.add(hemi);
  // the sun lives in the local player's gravity frame (each team sees "its" sun) and follows the camera
  const SUN_LOCAL = new Vector3(0.42, 0.78, 0.46).normalize();
  const sun = new DirectionalLight(0xffeccc, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -70;
  sc.right = sc.top = 70;
  sc.near = 1;
  sc.far = 400;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  const fill = new DirectionalLight(0xc8d6ff, 0.5);
  scene.add(sun, sun.target, fill);
  const sunDir = new Vector3();
  const upDir = new Vector3();

  const mapView = buildMapView(map);
  scene.add(mapView.group);
  const portalView = new PortalView(renderer, scene, sim.portals);

  // demo players: show how other teams look from your point of view
  const dummies: Dummy[] = [];
  const addDummy = (team: string, base: Vector3, frame: Quaternion, yaw: number, hop = 0) => {
    const model = new PlayerModel(getTeam(team as never).color);
    scene.add(model.group);
    const target: Target = {
      id: dummies.length + 1, team: team as never, center: base.clone(), up: upOf(frame), hp: MAX_HP, alive: true, respawnIn: 0,
    };
    combat.targets.push(target);
    dummies.push({ model, base, frame, yaw, hop, phase: Math.random() * 10, target });
  };
  for (const t of TEAMS) {
    const sp = map.spawns[t.id];
    const q = new Quaternion(...sp.quat);
    const base = new Vector3(...sp.pos);
    if (t.id === 'red') base.add(new Vector3(3, 0, -1).applyQuaternion(q));
    addDummy(t.id, base, q, sp.yaw + Math.PI);
  }
  // target practice on the red island streets
  for (const [x, z, t] of [[0, -14, 'blue'], [-2, -22, 'green'], [14, 2, 'yellow'], [22, -1.5, 'pink']] as [number, number, string][])
    addDummy(t, new Vector3(x, -87 + PLAYER_HEIGHT / 2 + 0.03, z), new Quaternion(), Math.atan2(x, z), t === 'green' ? 1.2 : 0);
  for (const f of map.faces) {
    const q = new Quaternion(...f.quat);
    const n = new Vector3(...f.normal);
    const c = n.clone().multiplyScalar(WORLD.coreHalf);
    addDummy(f.team, c.clone().add(new Vector3(5, PLAYER_HEIGHT / 2, 4).applyQuaternion(q)), q, 0.6);
    addDummy(f.team, c.clone().add(new Vector3(-6, PLAYER_HEIGHT / 2, -2).applyQuaternion(q)), q, 2.4, 1.6);
  }

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new Vector2(window.innerWidth, window.innerHeight), 0.22, 0.4, 0.92);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  // --- player, UI
  const input = new Input(canvas, overlay);
  const audio = new GameAudio();
  document.getElementById('start-game')!.addEventListener('click', () => audio.unlock());
  let started = false;
  document.addEventListener('pointerlockchange', () => {
    if (input.locked) { started = true; (document.getElementById('start-game') as HTMLButtonElement).innerHTML = 'Продолжить <span>↗</span>'; }
    else if (started) document.querySelector('.menu-kicker')!.lastChild!.textContent = ' ПАУЗА · ЛОКАЛЬНЫЙ ПРОТОТИП';
  });
  for (const section of ['help','settings']) document.getElementById(`show-${section}`)!.addEventListener('click', () => {
    const target = document.getElementById(`menu-${section}`)!;
    const open = target.hidden;
    for (const other of ['help','settings']) document.getElementById(`menu-${other}`)!.hidden = true;
    target.hidden = !open;
  });
  const volume = document.getElementById('volume') as HTMLInputElement;
  volume.addEventListener('input', () => { audio.volume=Number(volume.value); document.getElementById('volume-value')!.textContent=`${Math.round(audio.volume*100)}%`; });
  const sensitivity = document.getElementById('sensitivity') as HTMLInputElement;
  sensitivity.addEventListener('input', () => { input.sensitivity=Number(sensitivity.value); toggles.sensitivity=input.sensitivity; document.getElementById('sensitivity-value')!.textContent=`${Math.round(input.sensitivity/0.0022*100)}%`; });
  const fov = document.getElementById('fov') as HTMLInputElement;
  fov.addEventListener('input', () => { camera.fov=Number(fov.value); toggles.fov=camera.fov; camera.updateProjectionMatrix(); document.getElementById('fov-value')!.textContent=`${fov.value}°`; });
  const local = new LocalPlayer(sim, input);
  const hud = new Hud();
  const fx = new Fx(scene);
  const buildView = new BuildView(scene);
  let buildingMode = false;
  let buildKind: BuildKind = 'floor';
  let buildMaterial: BuildMaterial = 'wood';
  let buildCooldown = 0;
  const buildWheel = new BuildWheel(() => audio.select());
  input.onMouseMove = (dx,dy) => buildWheel.move(dx,dy);
  input.onWheel = (delta) => { if (!buildingMode) return false; const all: BuildKind[] = ['floor','wall','ramp']; buildKind=all[(all.indexOf(buildKind)+(delta>0?1:2))%3]; audio.select(); return true; };
  let buildTurns = 0;
  let buildPlan: BuildPlan | null = null;
  let buildResult: BuildResult | null = null;
  const buildHud = document.getElementById('build-hud')!;
  const viewModel = new ViewModel(sim.team.color);
  viewModel.environment = scene.environment;
  let pendingSelect: WeaponId | null = null;
  let pendingReload = false;
  let forceFire = 0;
  let punch = 0;
  let shake = 0;
  const _vq = new Quaternion();
  const teamSpan = (id: string, label?: string) => {
    const t = getTeam(id as never);
    return `<span style="color:${teamHex(t.color)}">${label ?? t.name}</span>`;
  };
  const resetCombatant = () => {
    me.hp = MAX_HP;
    me.alive = true;
    Object.assign(weapons, createWeaponState());
    hud.setHp(me.hp);
  };
  const onCombat = (e: CombatEvent) => {
    fx.handle(e);
    if (e.type === 'fire' && e.weapon === 'rifle') audio.shot();
    if (e.type === 'explode') audio.explosion();
    if (e.type === 'hit') {
      const tg = combat.target(e.target)!;
      if (e.owner === 0 && e.target !== 0) {
        hud.hitmarker(e.killed, e.head);
        if (e.killed) hud.killfeed(`${teamSpan(me.team, 'Ты')} ⟶ ${teamSpan(tg.team)}${e.head ? ' (в голову)' : ''}`);
      }
      if (e.target === 0) {
        hud.hurt(e.damage);
        hud.setHp(me.hp);
        if (e.killed) {
          hud.killfeed(e.owner === 0 ? `${teamSpan(me.team, 'Ты')} подорвал себя` : `${teamSpan(combat.target(e.owner)?.team ?? 'red')} ⟶ ${teamSpan(me.team, 'Ты')}`);
          sim.respawn('killed');
          resetCombatant();
        }
      }
    } else if (e.type === 'explode') {
      const d = e.pos.distanceTo(sim.state.pos);
      shake = Math.max(shake, Math.max(0, 1 - d / 18));
    }
  };
  local.onTick = () => {
    me.up.copy(upOf(sim.state.frame));
    const fire = (!buildingMode && input.locked && input.down('Mouse0')) || forceFire > 0;
    if (forceFire > 0) forceFire--;
    const fired = weaponTick(weapons, { fire: fire && me.alive, reload: pendingReload, select: pendingSelect }, TICK_DT);
    if (pendingSelect) viewModel.setWeapon(weapons.current);
    pendingReload = false;
    pendingSelect = null;
    if (fired) {
      const eye = sim.state.pos.clone().addScaledVector(me.up, EYE_OFFSET);
      viewQuat(sim.state.frame, sim.state.yaw, sim.state.pitch, _vq);
      const dir = new Vector3(0, 0, -1).applyQuaternion(_vq);
      const p = combat.fire(fired, 0, eye, dir, sim.state.vel, sim.gravityDown());
      if (fired === 'rifle') {
        const muzzle = viewModel.muzzleCameraSpace().applyQuaternion(_vq).add(eye);
        fx.setMuzzle(p.id, eye, muzzle);
      }
      viewModel.fire();
      punch = Math.min(punch + (fired === 'rifle' ? 0.5 : 0.3), 1.5);
    }
    combat.tick(TICK_DT);
    for (const e of combat.events.splice(0)) onCombat(e);
  };
  const gizmo = new GravityGizmo();
  const toggles: DebugToggles = { portals: true, bloom: true, sensitivity: input.sensitivity, fov: 80 };
  const applyToggles = () => {
    portalView.enabled = toggles.portals;
    bloom.enabled = toggles.bloom;
    input.sensitivity = toggles.sensitivity;
    camera.fov = toggles.fov;
    camera.updateProjectionMatrix();
  };
  const gui = createDebugGui(sim.cfg, sim.mover, toggles, applyToggles);
  let guiVisible = false;

  const gravityToast = () => {
    const t = teamByDown(sim.gravityDown());
    hud.toast(`Гравитация: ${t.name}`, teamHex(t.color));
  };
  local.onEvent = (e) => {
    if (e.type === 'gravity' || e.type === 'teleport') gravityToast();
    else if (e.type === 'respawn' && e.reason === 'manual') resetCombatant();
    else if (e.type === 'respawn' && e.reason === 'void') {
      hud.toast('Упал в пустоту', '#ff6b6b');
      resetCombatant();
    } else if (e.type === 'respawn' && e.reason === 'killed') hud.toast('Ты погиб', '#ff6b6b');
    else if (e.type === 'launch') hud.toast('Гейзер!', '#d7a8ff', 1);
  };

  const onResize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  const handleKeys = () => {
    if (!input.locked) return;
    const shift = input.down('ShiftLeft') || input.down('ShiftRight');
    TEAMS.forEach((t, i) => {
      if (shift && input.take(`Digit${i + 1}`)) sim.setGravity(new Vector3(...t.down));
    });
    if (input.take('KeyB')) buildingMode = !buildingMode;
    if (input.take('Digit1')) { buildingMode = false; pendingSelect = 'rifle'; }
    if (input.take('Digit2')) { buildingMode = false; pendingSelect = 'grenade'; }
    if (input.take('Digit3')) { buildingMode = true; buildKind = 'wall'; }
    if (input.take('Digit4')) { buildingMode = true; buildKind = 'floor'; }
    if (input.take('Digit5')) { buildingMode = true; buildKind = 'ramp'; }
    if (!buildingMode && input.take('KeyQ')) pendingSelect = weapons.current === 'rifle' ? 'grenade' : 'rifle';
    if (input.take('KeyR')) { if (buildingMode) buildTurns = (buildTurns + 1) % 4; else pendingReload = true; }
    if (input.take('KeyK')) sim.respawn('manual');
    if (input.take('KeyN')) {
      sim.state.noclip = !sim.state.noclip;
      hud.toast(sim.state.noclip ? 'Noclip: вкл' : 'Noclip: выкл', '#8af5ff', 1);
    }
    if (input.take('KeyT')) {
      const up = upOf(sim.state.frame);
      sim.state.pos.copy(up).multiplyScalar(WORLD.coreHalf + PLAYER_HEIGHT / 2 + 0.1);
      sim.state.vel.set(0, 0, 0);
      sim.mover.place(sim.state);
      local.snap();
    }
    if (input.take('KeyP')) {
      toggles.portals = !toggles.portals;
      applyToggles();
      gui.controllersRecursive().forEach((c) => c.updateDisplay());
    }
    if (input.take('KeyG')) {
      guiVisible = !guiVisible;
      if (guiVisible) {
        gui.show();
        document.exitPointerLock();
      } else gui.hide();
    }
    local.drainEvents();
  };

  // test / debug hook
  (window as unknown as Record<string, unknown>).__game = {
    sim, local, input, camera, renderer, portalView, combat, weapons, fx, buildings, ready: true,
    shoot(ticks = 1, weapon?: WeaponId) {
      if (weapon) pendingSelect = weapon;
      forceFire = ticks;
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
    const wheelChoice=buildWheel.update(dt,buildingMode && input.locked,(key)=>input.down(key),buildKind,buildMaterial);
    buildKind=wheelChoice.kind; buildMaterial=wheelChoice.material;
    buildCooldown=Math.max(0,buildCooldown-dt);
    if (buildingMode && input.locked) {
      const up = upOf(sim.state.frame);
      const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const flat = new Vector3(), right = new Vector3();
      moveBasis(sim.state.frame, input.yaw, flat, right);
      const hit = world.castRayAndGetNormal(new R.Ray(camera.position, forward), 7, true, undefined, undefined, sim.mover.collider);
      const aimHit = hit ? { pos: camera.position.clone().addScaledVector(forward,hit.timeOfImpact), piece: buildings.byCollider(hit.collider.handle) } : null;
      const point = buildAim(buildKind, camera.position, sim.state.pos, up, forward, flat, aimHit);
      const stack = buildKind === 'wall' && aimHit?.piece?.plan.kind === 'wall' && point.distanceTo(aimHit.piece.plan.cell.clone().addScaledVector(up,3)) < .01;
      const orientation = stack ? new Vector3(0,0,-1).applyQuaternion(aimHit!.piece!.plan.rotation) : flat;
      buildPlan = planBuild(buildKind, point, up, orientation, stack ? 0 : buildTurns);
      buildResult = buildings.validate(buildPlan, sim.state.pos, sim.state.frame, camera.position, buildMaterial);
      if (!buildWheel.active && input.take('Mouse2')) {
        const piece = hit && buildings.reclaim(hit.collider.handle);
        if (piece) { audio.remove(); hud.toast(`Разобрано: +5 ${BUILD_MATERIALS[piece.material].label.toLowerCase()}`, '#c6ffdb', 1); }
        else { audio.reject(); hud.toast('Наведи на постройку', '#ffb49e', 1); }
      }
      const click = input.take('Mouse0');
      if (!buildWheel.active && buildCooldown <= 0 && (click || input.down('Mouse0'))) {
        buildCooldown = .16;
        const result = buildings.place(buildPlan, sim.state.pos, sim.state.frame, camera.position, buildMaterial);
        if (result === 'ok') audio.place();
        else if (click) { audio.reject(); hud.toast(({ duplicate: 'Уже построено', resources: 'Не хватает материалов', player: 'Слишком близко к игроку', range: 'Слишком далеко', occupied: 'Место занято' } as Record<string,string>)[result], '#ff8e83', 1); }
        buildResult = buildings.validate(buildPlan, sim.state.pos, sim.state.frame, camera.position, buildMaterial);
      }
    } else { buildPlan = null; buildResult = null; }
    buildView.update(buildings, buildPlan, buildResult);
    buildHud.style.display = buildingMode ? 'block' : 'none';
    buildHud.innerHTML = `<strong>${({wall: 'СТЕНА', floor: 'ПОЛ', ramp: 'ПАНДУС'} as const)[buildKind]} · ${BUILD_MATERIALS[buildMaterial].label.toUpperCase()}</strong> &nbsp; ${buildings.resources[buildMaterial]} / ${BUILD_COST} &nbsp; <span>Q деталь · Z материал · R поворот · ЛКМ строить · ПКМ разобрать · B выход</span>`;
    sky.position.copy(camera.position);
    sunDir.copy(SUN_LOCAL).applyQuaternion(local.renderFrame);
    upDir.set(0, 1, 0).applyQuaternion(local.renderFrame);
    skyU.sunDir.value.copy(sunDir);
    skyU.upDir.value.copy(upDir);
    hemi.position.copy(upDir);
    sun.target.position.copy(camera.position).addScaledVector(upDir, -10);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 200);
    fill.position.copy(sunDir).negate().addScaledVector(upDir, 0.6);

    for (const d of dummies) {
      d.model.group.visible = d.target.alive;
      if (!d.target.alive) continue;
      const h = d.hop > 0 ? Math.max(0, Math.sin(time * 3 + d.phase)) * d.hop : 0;
      const up = upOf(d.frame);
      d.target.center.copy(d.base).addScaledVector(up, h);
      d.model.setPose(d.target.center, d.frame, d.yaw + Math.sin(time * 0.4 + d.phase) * 0.6);
      d.model.update(dt, PLAYER_HEIGHT / 2 + h);
    }
    fx.down.copy(upDir).negate();
    fx.update(dt, combat, time);
    mapView.update(time, dt);

    // view punch (recoil) + explosion shake
    punch = Math.max(0, punch - dt * 6);
    shake = Math.max(0, shake - dt * 1.8);
    camera.rotateX(punch * 0.025);
    if (shake > 0) {
      camera.rotateX((Math.random() - 0.5) * shake * 0.05);
      camera.rotateY((Math.random() - 0.5) * shake * 0.05);
    }
    camera.updateMatrixWorld();

    portalView.render(camera, time);
    composer.render(dt);
    const invCam = camera.quaternion.clone().invert();
    const pUp = upOf(sim.state.frame);
    viewModel.update(dt, {
      speed: sim.state.vel.clone().addScaledVector(pUp, -sim.state.vel.dot(pUp)).length(),
      lookDX: lastYaw - input.yaw, lookDY: input.pitch - lastPitch, reload: weapons.reloadT > 0 ? 1 - weapons.reloadT / WEAPONS.rifle.reload : 0,
      sunCam: sunDir.clone().applyQuaternion(invCam), upCam: upDir.clone().applyQuaternion(invCam),
      aspect: camera.aspect,
    });
    lastYaw = input.yaw;
    lastPitch = input.pitch;
    if (!buildingMode) viewModel.render(renderer);
    // HUD wind: what the local player's projectiles feel
    const w = combat.wind.felt(combat.time, pUp.clone().negate());
    moveBasis(sim.state.frame, input.yaw, _wf, _wr);
    hud.setWind(Math.atan2(w.dot(_wr), w.dot(_wf)) - Math.PI / 2, w.length(), 0);
    hud.setWeapon(weapons);
    viewQuat(local.renderFrame, input.yaw, input.pitch, viewQ);
    gizmo.render(renderer, viewQ, teamByDown(sim.gravityDown()).id);
    hud.update(dt, sim, `${(Math.hypot(...sim.state.pos.toArray())).toFixed(0)} м от центра`);
    input.endFrame();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

main();