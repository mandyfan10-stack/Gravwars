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
/** Pistol (Kenney small blaster): held lower and closer, same cant. */
const PISTOL_SCALE = 0.115;
const PISTOL_ROT = [0.1, Math.PI + 0.2, 0.2] as const;
const PISTOL_OFFSET = new Vector3(0.1, 0.0, -0.1);
const PISTOL_MUZZLE_MODEL = new Vector3(0, 0.5, 0.9);

/** What the hands hold besides weapons. */
export type ViewTool = 'build' | 'rod' | null;

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
  private pistol = new Group();
  private fists = new Group();
  private rod = new Group();
  private grenade = new Group();
  /** Fist punch: which hand and progress 1 → 0. */
  private punchHand = 1;
  private punchT = 0;
  /** Rod: cast swing 1 → 0, and a twitch while a fish bites. */
  private castT = 0;
  bite = 0;
  /** Rod tip in the rod group's space. */
  private rodTip = new Vector3();
  private pistolMuzzle = new Vector3();
  /** Build tool (shovel), shown instead of the weapon while building. */
  private shovel = new Group();
  private tool: ViewTool = null;
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
  current: WeaponId = 'fists';

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

    // pistol: Kenney small blaster
    const pistolGun = assets.blaster.clone();
    pistolGun.scale.setScalar(PISTOL_SCALE);
    pistolGun.rotation.set(...PISTOL_ROT);
    pistolGun.position.copy(PISTOL_OFFSET);
    pistolGun.updateMatrix();
    this.pistolMuzzle.copy(PISTOL_MUZZLE_MODEL).applyMatrix4(pistolGun.matrix);
    this.pistol.add(pistolGun);

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

    // fists: wrapped knuckles, team-coloured sleeves, both hands low in the corners
    const skinM = flat(0xd9a27e, 0.8);
    const wrapM = flat(0xe8e2d6, 0.9);
    for (const side of [-1, 1]) {
      const hand = new Group();
      const fist = new Mesh(new RoundedBoxGeometry(0.085, 0.075, 0.1, 2, 0.022), skinM);
      const wrap = new Mesh(new RoundedBoxGeometry(0.09, 0.05, 0.06, 1, 0.012), wrapM);
      wrap.position.set(0, -0.005, 0.045);
      const thumb = new Mesh(new RoundedBoxGeometry(0.03, 0.028, 0.06, 1, 0.01), skinM);
      thumb.position.set(-side * 0.04, -0.025, -0.01);
      const sleeve = new Mesh(new RoundedBoxGeometry(0.095, 0.09, 0.3, 2, 0.03), flat(0x3a3e47, 0.9));
      sleeve.position.set(0, -0.01, 0.24);
      const cuff = new Mesh(new RoundedBoxGeometry(0.1, 0.095, 0.03, 1, 0.01), teamM);
      cuff.position.set(0, -0.01, 0.1);
      hand.add(fist, wrap, thumb, sleeve, cuff);
      // guard: fists up in the lower corners, forearms going down and back out of the screen
      hand.position.set(side * 0.24 - 0.25, 0.06, -0.02);
      hand.rotation.set(0.6, -side * 0.2, side * 0.35);
      hand.scale.setScalar(0.78);
      hand.userData.rest = hand.position.clone();
      this.fists.add(hand);
    }

    // fishing rod: cork grip, reel, a long tapered blank going up and out of the screen; the line is drawn in the world
    const corkM = flat(0xb98a5a, 0.95);
    const blankM = flat(0x2c3138, 0.35);
    const rodLen = 0.85;
    const cork = new Mesh(new CylinderGeometry(0.016, 0.019, 0.2, 7), corkM);
    cork.rotation.x = Math.PI / 2;
    cork.position.z = 0.06;
    const blank = new Mesh(new CylinderGeometry(0.004, 0.011, rodLen, 6).translate(0, rodLen / 2, 0), blankM);
    blank.rotation.x = -Math.PI / 2;
    blank.position.z = -0.04;
    const reel = new Mesh(new CylinderGeometry(0.03, 0.03, 0.026, 10), steelM);
    reel.rotation.z = Math.PI / 2;
    reel.position.set(0, -0.04, 0.0);
    const reelFoot = new Mesh(new RoundedBoxGeometry(0.012, 0.03, 0.03, 1, 0.004), steelM);
    reelFoot.position.set(0, -0.022, 0.0);
    const rodGroup = new Group();
    rodGroup.add(cork, blank, reel, reelFoot);
    rodGroup.rotation.set(0.62, -0.28, -0.1);
    rodGroup.position.set(0.05, 0.02, 0.02);
    rodGroup.updateMatrix();
    this.rodTip.set(0, 0, -0.04 - rodLen).applyMatrix4(rodGroup.matrix);
    this.rod.add(rodGroup);

    this.root.add(this.rifle, this.pistol, this.fists, this.rod, this.grenade, this.shovel);
    this.scene.add(this.root, this.sun, this.sun.target, this.hemi);
    this.setWeapon('fists');
  }

  set environment(t: Texture | null) {
    this.scene.environment = t;
    this.scene.environmentIntensity = 0.5;
  }

  setWeapon(w: WeaponId) {
    if (w !== this.current) this.lower = 1;
    this.current = w;
  }

  /** Show the build tool / fishing rod instead of the current weapon. */
  setTool(tool: ViewTool) {
    if (tool !== this.tool) this.lower = 1;
    this.tool = tool;
  }

  /** Rod cast swing. */
  cast() {
    this.castT = 1;
  }

  /** Shovel swing when a piece is placed. */
  dig() {
    this.swing = 1;
  }

  fire() {
    if (this.current === 'fists') {
      this.punchHand = -this.punchHand;
      this.punchT = 1;
      return;
    }
    this.kick = this.current === 'pistol' ? 0.7 : 1;
    if (this.current === 'rifle' || this.current === 'pistol') {
      // the flash lives on the current gun's muzzle
      const gun = this.current === 'rifle' ? this.rifle : this.pistol;
      const m = this.current === 'rifle' ? this.muzzle : this.pistolMuzzle;
      gun.add(this.flash, this.flashLight);
      this.flash.position.copy(m);
      this.flashLight.position.copy(m);
      this.flashT = 0;
      this.flash.rotation.z = Math.random() * Math.PI;
      this.flash.scale.setScalar(0.8 + Math.random() * 0.5);
    }
  }

  /** Muzzle position in camera space (for tracers). */
  muzzleCameraSpace(out = new Vector3()): Vector3 {
    const pistol = this.current === 'pistol';
    const gun = pistol ? this.pistol : this.rifle;
    gun.updateWorldMatrix(true, false);
    return out.copy(pistol ? this.pistolMuzzle : this.muzzle).applyMatrix4(gun.matrixWorld);
  }

  /**
   * Where the rod tip appears in the world camera's view: the viewmodel has its own FOV, so the tip is projected to
   * the screen with the viewmodel camera and put back on the same screen point at the same distance with `camera`.
   */
  rodTipWorld(camera: PerspectiveCamera, out = new Vector3()): Vector3 {
    this.rod.updateWorldMatrix(true, false);
    const tip = out.copy(this.rodTip).applyMatrix4(this.rod.matrixWorld);
    const dist = tip.length();
    tip.project(this.camera);
    tip.z = 0.5;
    tip.unproject(camera).sub(camera.position).normalize().multiplyScalar(dist);
    return tip.add(camera.position);
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
    const weapon = this.tool === null;
    this.rifle.visible = weapon && this.current === 'rifle';
    this.pistol.visible = weapon && this.current === 'pistol';
    this.fists.visible = weapon && this.current === 'fists';
    this.grenade.visible = weapon && this.current === 'grenade';
    this.shovel.visible = this.tool === 'build';
    this.rod.visible = this.tool === 'rod';
    // punch: the active fist jabs forward and a bit inward, then comes back
    this.punchT = Math.max(0, this.punchT - dt * 4.5);
    const jab = Math.sin(Math.min(1, (1 - this.punchT) * 1.6) * Math.PI) * (this.punchT > 0 ? 1 : 0);
    this.fists.children.forEach((h, i) => {
      const side = i === 0 ? -1 : 1;
      const rest = h.userData.rest as Vector3;
      const on = side === this.punchHand ? jab : 0;
      h.position.set(rest.x - side * on * 0.12, rest.y + on * 0.08, rest.z - on * 0.32);
    });
    // rod: cast flick, small tremble while a fish bites
    this.castT = Math.max(0, this.castT - dt * 3);
    const flick = Math.sin(this.castT * Math.PI);
    this.rod.rotation.set(-flick * 0.6 + Math.sin(this.bobT * 9) * this.bite * 0.04, 0, 0);
    this.rod.position.set(0, this.bite * Math.sin(this.bobT * 13) * 0.006, 0);
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
