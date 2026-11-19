import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, Object3D, Points, PointsMaterial,
  Quaternion, Vector3,
} from 'three';
import { generateMap } from '../shared/map';
import type { GameMode } from '../shared/lobby';
import { MapData } from '../shared/mapgen/core';
import { WORLD } from '../shared/constants';
import { GameAssets } from './render/assets';
import { Graphics } from './render/graphics';
import { buildMapView, MapView } from './render/mapView';
import { buildPropView } from './render/propView';

/** A built world the match can take over instead of building it again. */
export interface BuiltWorld { map: MapData; mapView: MapView; propView: Group }

const _m = new Matrix4();
const _up = new Vector3();
const _at = new Vector3();
const FLOOR = new Quaternion(); // the red face's frame: gravity -Y

/** Seconds per full turn of the camera around the cube's axis. */
const TURN = 300;
/** Dust in the sunlit air round the camera: motes, side of the box they fill (m). */
const MOTES = 220;
const MOTE_BOX = 36;

/**
 * The world behind the pre-match menu: the default lobby's cube, the camera drifting round the inside of it a little
 * below the sun, looking down at the corners where the red face meets the walls, dust motes in the air. If the lobby
 * still matches when the match starts, the match takes this world over (`take`), otherwise it is thrown away.
 */
export class MenuBackdrop {
  private world: BuiltWorld | null = null;
  private key = '';
  private running = false;
  private rafId = 0;
  private time = 0;
  private last = 0;
  /** Starting angle: the first frame already looks at something (see `pose`). */
  private readonly a0 = 0.6;
  private readonly dust: Points;
  /** Mote drift (m/s) and phase, per mote. */
  private readonly drift = new Float32Array(MOTES * 4);

  constructor(private readonly gfx: Graphics) {
    const pos = new Float32Array(MOTES * 3);
    for (let i = 0; i < MOTES; i++) {
      for (let k = 0; k < 3; k++) pos[i * 3 + k] = (Math.random() - 0.5) * MOTE_BOX;
      this.drift.set([(Math.random() - 0.5) * 0.5, 0.15 + Math.random() * 0.35, (Math.random() - 0.5) * 0.5, Math.random() * 6], i * 4);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(pos, 3));
    this.dust = new Points(geo, new PointsMaterial({
      // no texture: square points, 1–2 frame pixels (crisp in the pixel look)
      color: 0xffc27a, size: 0.045, sizeAttenuation: true, transparent: true, opacity: 0.55,
      depthWrite: false, blending: AdditiveBlending, fog: false,
    }));
    this.dust.frustumCulled = false;
  }

  /** Build the world for (spawn team, playing teams, seed, mode) and start the camera. */
  start(assets: GameAssets, spawnTeam: string, teams: readonly string[], seed = 1337, mode: GameMode = 'standard') {
    this.gfx.setSunVisible(mode !== 'skirmish');
    const map = generateMap(seed, spawnTeam, teams, mode);
    const mapView = buildMapView(map);
    const propView = buildPropView(map, assets);
    this.gfx.scene.add(mapView.group, propView, this.dust);
    this.world = { map, mapView, propView };
    this.key = backdropKey(seed, spawnTeam, teams, mode);
    mapView.cull(this.gfx.camera.position, Infinity);
    this.running = true;
    this.last = performance.now();
    this.frame();
    document.body.classList.add('backdrop');
  }

  /**
   * Stop the camera. The world is handed over when it was built for the same teams & seed (it then stays in the scene),
   * else it is removed and freed and null comes back.
   */
  take(spawnTeam: string, teams: readonly string[], seed = 1337, mode: GameMode = 'standard'): BuiltWorld | null {
    this.running = false;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    document.body.classList.remove('backdrop', 'boot');
    this.gfx.scene.remove(this.dust);
    const w = this.world;
    this.world = null;
    if (!w) return null;
    if (this.key === backdropKey(seed, spawnTeam, teams, mode)) return w;
    this.gfx.scene.remove(w.mapView.group, w.propView);
    for (const g of [w.mapView.group, w.propView]) freeSceneObject(g);
    this.key = '';
    return null;
  }

  /** Resume the scenic rotating menu camera over an already built world when exiting a match back to the menu. */
  resumeExisting(world: BuiltWorld, key = '') {
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    this.world = world;
    this.key = key;
    this.gfx.setSunVisible(world.map.cube.halfY === undefined);
    if (this.dust.parent !== this.gfx.scene) this.gfx.scene.add(this.dust);
    world.mapView.cull(this.gfx.camera.position, Infinity);
    this.running = true;
    this.last = performance.now();
    this.frame();
    document.body.classList.add('backdrop');
  }

  /** The shot (tunable from the console): see `pose`. */
  shot = { r: 60, h: 100, lookR: 140, lookH: 40, off: 0.785, roll: 0 };

  /**
   * Camera at time `t`: a slow circle of radius `r` round the cube's axis, `h` m above the red face, looking past the
   * axis at a point `lookR` from it, `lookH` above the face (`off` rad ahead of the opposite side).
   */
  private pose(t: number) {
    const { camera } = this.gfx;
    const isSkirmish = this.world?.map.cube.halfY !== undefined;
    const S = isSkirmish ? (this.world!.map.cube.halfY!) : WORLD.cubeHalf;
    const { r, h, lookR, lookH, off, roll } = isSkirmish
      ? { r: 52, h: 14, lookR: 85, lookH: 6, off: 0.785, roll: 0 }
      : this.shot;
    const a = this.a0 + (t / TURN) * Math.PI * 2;
    camera.position.set(Math.cos(a) * r, -S + h + Math.sin(t * 0.11) * 2, Math.sin(a) * r);
    const b = a + Math.PI + off;
    _at.set(Math.cos(b) * lookR, -S + lookH, Math.sin(b) * lookR);
    _up.set(Math.cos(a) * roll, 1, Math.sin(a) * roll).normalize();
    camera.quaternion.setFromRotationMatrix(_m.lookAt(camera.position, _at, _up));
  }

  private renderStep(dt: number) {
    if (!this.world) return;
    this.pose(this.time);
    this.motes(dt);
    const { gfx } = this;
    gfx.updateLighting(FLOOR, this.time);
    this.world.mapView.update(this.time, dt);
    gfx.overlay.enabled = false;
    if (!document.hidden) gfx.render(dt);
    document.body.classList.remove('boot');
  }

  private frame = () => {
    if (!this.running || !this.world) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.time += dt;
    this.renderStep(dt);
    if (!navigator.webdriver) {
      this.rafId = requestAnimationFrame(this.frame);
    }
  };

  /** Motes rise and sway; the ones that leave the box round the camera come back in on the other side. */
  private motes(dt: number) {
    const p = this.dust.geometry.getAttribute('position') as BufferAttribute;
    const a = p.array as Float32Array, d = this.drift, c = this.gfx.camera.position, H = MOTE_BOX / 2;
    for (let i = 0; i < MOTES; i++) {
      const sway = Math.sin(this.time * 0.6 + d[i * 4 + 3]) * 0.2;
      for (let k = 0; k < 3; k++) {
        let v = a[i * 3 + k] + (d[i * 4 + k] + (k === 1 ? 0 : sway)) * dt - c.getComponent(k);
        v = ((v + H) % MOTE_BOX + MOTE_BOX) % MOTE_BOX - H;
        a[i * 3 + k] = v + c.getComponent(k);
      }
    }
    p.needsUpdate = true;
  }

  /** Debug / screenshots: jump the camera to time `t`. */
  seek(t: number) {
    this.time = t;
    if (navigator.webdriver && this.running && this.world) this.renderStep(0);
  }
}

export function backdropKey(seed: number, spawnTeam: string, teams: readonly string[], mode = 'standard') {
  return `${seed}|${mode}|${spawnTeam}|${[...teams].sort().join(',')}`;
}

/** Free the GPU buffers of a removed group (shared materials and textures are left alone). */
export function freeSceneObject(root: Object3D) {
  root.traverse((o) => {
    if ((o as InstancedMesh).isInstancedMesh) (o as InstancedMesh).dispose();
    if ((o as Mesh).isMesh) ((o as Mesh).geometry as BufferGeometry).dispose();
  });
}
