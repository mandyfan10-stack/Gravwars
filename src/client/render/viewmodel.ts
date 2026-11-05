import {
  AdditiveBlending, CanvasTexture, Color, CylinderGeometry, DirectionalLight, DoubleSide, ExtrudeGeometry, Group, HemisphereLight, LatheGeometry,
  Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, PointLight, Scene, Shape, Texture,
  TorusGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { WeaponId } from '../../shared/weapons';
import type { GameAssets } from './assets';

/**
 * Blaster placement in the weapon group: canted so the barrels show in profile and the stock leaves the screen at
 * the bottom-right corner. Tuned with the screenshot stand. The model's barrels point along its +Z.
 */
const RIFLE_SCALE = 0.17;
const RIFLE_ROT = [0.1, Math.PI + 0.26, 0.3] as const;
const RIFLE_OFFSET = new Vector3(0.13, -0.05, -0.06);
/** Spade rest pitch (blade up); the dig swing rotates around it. */
const SHOVEL_TILT = 0.7;
/** Barrel tip in model units. */
const MUZZLE_MODEL = new Vector3(0, 0.45, 1.2);

/** Muzzle flash sprite: a hot core with four soft spikes, fading to transparent. */
function flashTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.translate(32, 32);
  const glow = g.createRadialGradient(0, 0, 0, 0, 0, 32);
  glow.addColorStop(0, '#fff');
  glow.addColorStop(0.25, '#ffd9a0');
  glow.addColorStop(0.6, '#ff8a3040');
  glow.addColorStop(1, '#ff6a0000');
  g.fillStyle = glow;
  for (let i = 0; i < 4; i++) {
    g.rotate(Math.PI / 2 + (i % 2) * 0.25);
    g.beginPath();
    g.moveTo(0, -32);
    g.quadraticCurveTo(5, -5, 32 * (i % 2 ? 0.55 : 0.8), 0);
    g.quadraticCurveTo(5, 5, 0, 32);
    g.quadraticCurveTo(-5, 5, 0, 0);
    g.fill();
  }
  g.beginPath();
  g.arc(0, 0, 13, 0, Math.PI * 2);
  g.fill();
  return new CanvasTexture(c);
}

/** First-person weapon drawn in its own pass on top of the world (never clips into walls). */
export class ViewModel {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(62, 1, 0.01, 10);
  private root = new Group();
  private rifle = new Group();
  private grenade = new Group();
  /** Build tool (shovel), shown instead of the weapon while building. */
  private shovel = new Group();
  private toolOn = false;
  private swing = 0;
  private flash: Group;
  /** Barrel tip in the rifle group's space. */
  private muzzle = new Vector3();
  private flashLight = new PointLight(0xffc070, 0, 3, 2);
  private sun = new DirectionalLight(0xffeccc, 2.2);
  private hemi = new HemisphereLight(0xfff1dc, 0x6a5a48, 0.7);
  private kick = 0;
  private flashT = 1;
  private swayX = 0;
  private swayY = 0;
  private bobT = 0;
  private lower = 0;
  current: WeaponId = 'rifle';

  constructor(teamColor: number, assets: GameAssets) {
    // rifle: Kenney repeater blaster, barrel along -Z
    const gun = assets.rifle.clone();
    gun.scale.setScalar(RIFLE_SCALE);
    gun.rotation.set(...RIFLE_ROT);
    gun.position.copy(RIFLE_OFFSET);
    gun.updateMatrix();
    this.muzzle.copy(MUZZLE_MODEL).applyMatrix4(gun.matrix);
    this.rifle.add(gun);

    // muzzle flash: two crossed additive quads
    const fm = new MeshBasicMaterial({ map: flashTexture(), color: new Color(2.2, 1.6, 1.1), transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    this.flash = new Group();
    for (let i = 0; i < 2; i++) {
      const q = new Mesh(new PlaneGeometry(0.16, 0.16), fm);
      q.rotation.y = i * Math.PI / 2;
      this.flash.add(q);
    }
    const front = new Mesh(new PlaneGeometry(0.12, 0.12), fm);
    front.rotation.x = 0;
    this.flash.add(front);
    this.flash.quaternion.copy(gun.quaternion); // quads along the barrel
    this.flash.position.copy(new Vector3(0, 0, 0.04).applyQuaternion(gun.quaternion)).add(this.muzzle);
    this.flash.visible = false;
    this.rifle.add(this.flash);
    this.flashLight.position.copy(this.muzzle);
    this.rifle.add(this.flashLight);

    // grenade + shovel: chunky low-poly in the Kenney palette (flat shaded, bevelled), team-coloured accents
    const flat = (color: number, rough = 0.7) => new MeshStandardMaterial({ color, roughness: rough, flatShading: true });
    const steelM = flat(0xa0a8c9, 0.45);
    const darkM = flat(0x4f5260);
    const woodM = flat(0xd6865b);
    const teamM = flat(teamColor, 0.5);
    const gBody = new Mesh(new LatheGeometry([
      new Vector2(0, -0.075), new Vector2(0.05, -0.07), new Vector2(0.066, -0.035), new Vector2(0.068, 0.02),
      new Vector2(0.055, 0.06), new Vector2(0.03, 0.075), new Vector2(0, 0.076)], 8), flat(0x61cb8b));
    const gBand = new Mesh(new CylinderGeometry(0.07, 0.07, 0.022, 8), teamM);
    const gCap = new Mesh(new RoundedBoxGeometry(0.05, 0.035, 0.05, 1, 0.008), darkM);
    gCap.position.y = 0.088;
    const gLever = new Mesh(new RoundedBoxGeometry(0.018, 0.11, 0.03, 1, 0.006), steelM);
    gLever.position.set(0.04, 0.05, 0);
    gLever.rotation.z = -0.35;
    const gRing = new Mesh(new TorusGeometry(0.02, 0.005, 5, 10), steelM);
    gRing.position.set(-0.03, 0.1, 0);
    gRing.rotation.y = Math.PI / 2;
    this.grenade.add(gBody, gBand, gCap, gLever, gRing);
    this.grenade.position.set(0, 0, -0.1);

    // short spade: T-grip, wooden shaft, steel collar and blade, held in the lower-right corner
    const handle = new Mesh(new RoundedBoxGeometry(0.03, 0.03, 0.34, 1, 0.01), woodM);
    handle.position.z = -0.04;
    const grip = new Mesh(new RoundedBoxGeometry(0.1, 0.036, 0.04, 1, 0.012), teamM);
    grip.position.z = 0.14;
    const collar = new Mesh(new RoundedBoxGeometry(0.05, 0.044, 0.07, 1, 0.012), darkM);
    collar.position.z = -0.2;
    const bladeShape = new Shape();
    bladeShape.moveTo(-0.085, 0);
    bladeShape.lineTo(0.085, 0);
    bladeShape.lineTo(0.085, 0.15);
    bladeShape.quadraticCurveTo(0.08, 0.22, 0, 0.26);
    bladeShape.quadraticCurveTo(-0.08, 0.22, -0.085, 0.15);
    bladeShape.lineTo(-0.085, 0);
    const blade = new Mesh(new ExtrudeGeometry(bladeShape, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 1, curveSegments: 4 }), steelM);
    blade.rotation.x = -Math.PI / 2;
    blade.position.set(0, -0.006, -0.23);
    this.shovel.add(handle, grip, collar, blade);
    this.shovel.rotation.set(SHOVEL_TILT, 0.35, -0.1);
    this.shovel.position.set(0.1, -0.08, 0.05);
    this.shovel.scale.setScalar(0.8);

    this.root.add(this.rifle, this.grenade, this.shovel);
    this.scene.add(this.root, this.sun, this.sun.target, this.hemi);
    this.setWeapon('rifle');
  }

  set environment(t: Texture | null) {
    this.scene.environment = t;
    this.scene.environmentIntensity = 0.5;
  }

  setWeapon(w: WeaponId) {
    if (w !== this.current) this.lower = 1;
    this.current = w;
  }

  /** Show the build tool instead of the current weapon. */
  setTool(on: boolean) {
    if (on !== this.toolOn) this.lower = 1;
    this.toolOn = on;
  }

  /** Shovel swing when a piece is placed. */
  dig() {
    this.swing = 1;
  }

  fire() {
    this.kick = 1;
    if (this.current === 'rifle') {
      this.flashT = 0;
      this.flash.rotation.z = Math.random() * Math.PI;
      this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
    }
  }

  /** Muzzle position in camera space (for tracers). */
  muzzleCameraSpace(out = new Vector3()): Vector3 {
    this.rifle.updateWorldMatrix(true, false);
    return out.copy(this.muzzle).applyMatrix4(this.rifle.matrixWorld);
  }

  update(dt: number, opts: { speed: number; lookDX: number; lookDY: number; reload: number; sunCam: Vector3; upCam: Vector3; aspect: number }) {
    this.camera.aspect = opts.aspect;
    this.camera.updateProjectionMatrix();
    this.kick = Math.max(0, this.kick - dt * 9);
    this.flashT += dt;
    this.flash.visible = this.flashT < 0.045;
    this.flashLight.intensity = this.flash.visible ? 3 : 0;
    this.lower = Math.max(0, this.lower - dt * 4);
    this.swayX += (Math.max(-1, Math.min(1, opts.lookDX * 6)) * 0.03 - this.swayX) * Math.min(1, dt * 10);
    this.swayY += (Math.max(-1, Math.min(1, opts.lookDY * 6)) * 0.03 - this.swayY) * Math.min(1, dt * 10);
    const sp = Math.min(opts.speed / 7.6, 1.5);
    this.bobT += dt * (4 + sp * 6) * (sp > 0.05 ? 1 : 0.3);
    const bob = sp * 0.012;
    const k = this.kick;
    const rel = opts.reload;
    const relDip = rel > 0 ? Math.sin(Math.min(rel, 1) * Math.PI) : 0;
    const r = this.root;
    r.position.set(0.25 - this.swayX + Math.cos(this.bobT) * bob, -0.25 - this.swayY - Math.abs(Math.sin(this.bobT)) * bob - this.lower * 0.25 - relDip * 0.12,
      -0.5 + k * 0.05);
    r.rotation.set(k * 0.09 + relDip * 0.5, -0.04 + this.swayX * 0.6, relDip * 0.4);
    this.swing = Math.max(0, this.swing - dt * 5);
    this.rifle.visible = !this.toolOn && this.current === 'rifle';
    this.grenade.visible = !this.toolOn && this.current === 'grenade';
    this.shovel.visible = this.toolOn;
    this.shovel.rotation.x = SHOVEL_TILT - Math.sin(this.swing * Math.PI) * 0.9;
    this.grenade.position.set(0.04, 0.02 - k * 0.1, 0.0 - k * 0.2);
    this.grenade.scale.setScalar(0.7);
    this.sun.position.copy(opts.sunCam).multiplyScalar(5);
    this.hemi.position.copy(opts.upCam);
  }

  render(renderer: WebGLRenderer) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }
}
