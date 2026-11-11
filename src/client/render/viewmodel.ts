import {
  AdditiveBlending, CanvasTexture, Color, CylinderGeometry, DirectionalLight, DoubleSide, ExtrudeGeometry, Group, HemisphereLight, LatheGeometry,
  Mesh, MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, PointLight, Scene, Shape, Texture,
  TorusGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { ITEM_ORDER, ItemId } from '../../shared/economy';
import type { WeaponId } from '../../shared/weapons';
import type { GameAssets } from './assets';
import { crossbowModel, GunModel, hookGunModel, launcherModel, pistolModel, rifleModel, shotgunModel } from './guns';
import { itemMeshes } from './pickupView';

/**
 * Gun placement in the weapon group (guns are real size, barrel along -Z, origin at the grip): the rifle shouldered
 * low on the right, the pistol held out in two hands. Tuned with the screenshot stand.
 */
const RIFLE_ROT = [0.02, 0.05, -0.04] as const;
const RIFLE_OFFSET = new Vector3(-0.03, 0.055, 0.16);
/** Spade rest pitch (blade up); the dig swing rotates around it. */
const SHOVEL_TILT = 0.7;
const PISTOL_ROT = [0.03, 0.08, -0.03] as const;
const PISTOL_OFFSET = new Vector3(-0.13, 0.1, 0.02);
/** The shotgun sits like the rifle; the launcher rides higher on the shoulder, the hook gun is held out one-handed. */
const SHOTGUN_OFFSET = new Vector3(-0.03, 0.06, 0.16);
const CROSSBOW_OFFSET = new Vector3(-0.03, 0.055, 0.14);
const LAUNCHER_ROT = [0.0, 0.03, 0] as const;
const LAUNCHER_OFFSET = new Vector3(0.0, 0.07, 0.1);
const HOOK_ROT = [0.04, 0.1, -0.05] as const;
const HOOK_OFFSET = new Vector3(-0.06, 0.08, 0.04);
/** How far the slide / bolt / pump travels back, m. */
const SLIDE_TRAVEL: Partial<Record<WeaponId, number>> = { pistol: 0.035, rifle: 0.075, shotgun: 0.09, crossbow: 0.11 };
type Gun = 'pistol' | 'rifle' | 'shotgun' | 'rocket' | 'crossbow';
const isViewGun = (w: WeaponId): w is Gun => w === 'pistol' || w === 'rifle' || w === 'shotgun' || w === 'rocket' || w === 'crossbow';

/** What the hands hold besides weapons: tools and pocket items. */
export type ViewTool = 'build' | 'rod' | 'hook' | ItemId | null;

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
  private shotgun = new Group();
  private rocket = new Group();
  private crossbow = new Group();
  private hookGun = new Group();
  private hookClaw = new Vector3();
  private hookModel!: GunModel;
  /** The claw is out on the rope (hidden on the gun). */
  hookOut = false;
  /** Kick: the leg comes up from below the screen, 1 → 0. */
  private kickT = 0;
  private leg = new Group();
  /** Shotgun: the pump is worked after a shot, 1 → 0. */
  private pumpT = 0;
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
  /** A pocket item in the right hand (one mesh group per kind), and the throw / use swing 1 → 0. */
  private held = new Group();
  private heldItems = {} as Record<ItemId, Group>;
  private tossT = 0;
  private flash: Group;
  /** Barrel tip in the rifle group's space. */
  private muzzle = new Vector3();
  private flashLight = new PointLight(0xffc070, 0, 3, 2);
  private sun = new DirectionalLight(0xffeccc, 2.2);
  private hemi = new HemisphereLight(0xfff1dc, 0x6a5a48, 0.7);
  private recoilK = 0;
  private flashT = 1;
  private guns!: Record<Gun, GunModel>;
  private muzzles!: Record<Gun, Vector3>;
  private reloadEmpty = false;
  private swayX = 0;
  private swayY = 0;
  private bobT = 0;
  private lower = 0;
  current: WeaponId = 'fists';

  constructor(teamColor: number, assets: GameAssets) {
    void assets;
    // the soldier's outfit (see human.ts): dark tactical gloves, softshell sleeves in the team colour
    const skinM = new MeshStandardMaterial({ color: 0x232527, roughness: 0.75 });
    const sleeveM = new MeshStandardMaterial({ color: new Color(teamColor).multiplyScalar(0.72), roughness: 0.8 });
    const cuffM = new MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.7 });
    const sleeveGeo = new CylinderGeometry(0.046, 0.054, 0.34, 14).rotateX(Math.PI / 2);
    /** A gloved hand closed around something, its forearm going back (+Z) and down out of the screen. */
    const hand = (x: number, y: number, z: number, rx: number, ry: number, rz: number) => {
      const h = new Group();
      const palm = new Mesh(new RoundedBoxGeometry(0.062, 0.072, 0.075, 3, 0.024), skinM);
      const cuff = new Mesh(new CylinderGeometry(0.04, 0.042, 0.04, 12).rotateX(Math.PI / 2), cuffM);
      cuff.position.set(0, -0.008, 0.055);
      const sleeve = new Mesh(sleeveGeo, sleeveM);
      sleeve.position.set(0, -0.012, 0.23);
      h.add(palm, cuff, sleeve);
      h.position.set(x, y, z);
      h.rotation.set(rx, ry, rz);
      h.scale.setScalar(0.72);
      return h;
    };

    // rifle: right hand on the pistol grip, left hand under the handguard
    const rifleGun = rifleModel();
    rifleGun.root.rotation.set(...RIFLE_ROT);
    rifleGun.root.position.copy(RIFLE_OFFSET);
    rifleGun.root.add(hand(0.006, -0.05, 0.07, 0.55, 0, 0), hand(-0.012, -0.005, -0.27, 0.9, 0.5, 0.25));
    rifleGun.root.updateMatrix();
    this.muzzle.copy(rifleGun.muzzle).applyMatrix4(rifleGun.root.matrix);
    this.rifle.add(rifleGun.root);
    const gun = rifleGun.root;

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
    this.flash.position.copy(new Vector3(0, 0, -0.04).applyQuaternion(gun.quaternion)).add(this.muzzle);
    this.flash.visible = false;
    this.rifle.add(this.flash);
    this.flashLight.position.copy(this.muzzle);
    this.rifle.add(this.flashLight);

    // pistol: two-handed grip, the left hand wraps under the right one
    const pistolGun = pistolModel();
    pistolGun.root.rotation.set(...PISTOL_ROT);
    pistolGun.root.position.copy(PISTOL_OFFSET);
    pistolGun.root.add(hand(0.004, -0.045, 0.02, 0.35, 0, 0), hand(-0.03, -0.06, 0.0, 0.5, 0.45, 0.4));
    pistolGun.root.updateMatrix();
    this.pistolMuzzle.copy(pistolGun.muzzle).applyMatrix4(pistolGun.root.matrix);
    this.pistol.add(pistolGun.root);

    // pump shotgun: right hand on the grip, left on the pump
    const shotgunGun = shotgunModel();
    shotgunGun.root.rotation.set(...RIFLE_ROT);
    shotgunGun.root.position.copy(SHOTGUN_OFFSET);
    shotgunGun.root.add(hand(0.006, -0.05, 0.08, 0.6, 0, 0));
    shotgunGun.slide.add(hand(-0.012, -0.012, -0.25, 0.9, 0.5, 0.25));
    shotgunGun.root.updateMatrix();
    this.shotgun.add(shotgunGun.root);
    // rocket launcher on the shoulder: both hands on its grips
    const launcher = launcherModel();
    launcher.root.rotation.set(...LAUNCHER_ROT);
    launcher.root.position.copy(LAUNCHER_OFFSET);
    launcher.root.add(hand(0.004, -0.05, 0.0, 0.4, 0, 0), hand(-0.01, -0.05, -0.3, 0.6, 0.4, 0.3));
    launcher.root.updateMatrix();
    this.rocket.add(launcher.root);
    // grappling-hook gun, one hand
    const hookGun = hookGunModel(teamColor);
    hookGun.root.rotation.set(...HOOK_ROT);
    hookGun.root.position.copy(HOOK_OFFSET);
    hookGun.root.add(hand(0.004, -0.045, 0.02, 0.35, 0, 0));
    hookGun.root.updateMatrix();
    this.hookClaw.copy(hookGun.muzzle).applyMatrix4(hookGun.root.matrix);
    this.hookGun.add(hookGun.root);
    this.hookModel = hookGun;
    // crossbow: shouldered like a rifle, two hands
    const xbowGun = crossbowModel();
    xbowGun.root.rotation.set(...RIFLE_ROT);
    xbowGun.root.position.copy(CROSSBOW_OFFSET);
    xbowGun.root.add(hand(0.006, -0.05, 0.05, 0.55, 0, 0), hand(-0.012, -0.01, -0.22, 0.85, 0.45, 0.25));
    xbowGun.root.updateMatrix();
    this.crossbow.add(xbowGun.root);
    this.guns = { rifle: rifleGun, pistol: pistolGun, shotgun: shotgunGun, rocket: launcher, crossbow: xbowGun };
    const at = (g: GunModel) => g.muzzle.clone().applyMatrix4(g.root.matrix);
    this.muzzles = { rifle: this.muzzle, pistol: this.pistolMuzzle, shotgun: at(shotgunGun), rocket: at(launcher), crossbow: at(xbowGun) };

    // the kicking leg: trousers in the team colour, a heavy boot; it lives below the screen until a kick
    const legM = new MeshStandardMaterial({ color: new Color(teamColor).multiplyScalar(0.45), roughness: 0.85 });
    const bootM = new MeshStandardMaterial({ color: 0x1d1b19, roughness: 0.6 });
    const shin = new Mesh(new CylinderGeometry(0.075, 0.09, 0.55, 14), legM);
    shin.position.y = 0.3;
    const boot = new Mesh(new RoundedBoxGeometry(0.15, 0.13, 0.3, 3, 0.04), bootM);
    boot.position.set(0, 0.0, -0.06);
    const sole = new Mesh(new RoundedBoxGeometry(0.16, 0.035, 0.32, 2, 0.012), new MeshStandardMaterial({ color: 0x3a3631, roughness: 0.9 }));
    sole.position.set(0, -0.07, -0.06);
    this.leg.add(shin, boot, sole);
    this.leg.visible = false;

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

    // fists: gloved, the same sleeves as on the gun
    for (const side of [-1, 1]) {
      const hand = new Group();
      const fist = new Mesh(new RoundedBoxGeometry(0.082, 0.07, 0.09, 3, 0.026), skinM);
      // curled fingers: a rounded roll under the knuckles
      const fingers = new Mesh(new CylinderGeometry(0.022, 0.022, 0.08, 10).rotateZ(Math.PI / 2), skinM);
      fingers.position.set(0, -0.03, -0.035);
      const thumb = new Mesh(new RoundedBoxGeometry(0.028, 0.026, 0.06, 2, 0.011), skinM);
      thumb.position.set(-side * 0.04, -0.022, -0.01);
      const cuff = new Mesh(new CylinderGeometry(0.046, 0.048, 0.045, 12).rotateX(Math.PI / 2), cuffM);
      cuff.position.set(0, -0.006, 0.065);
      const sleeve = new Mesh(sleeveGeo, sleeveM);
      sleeve.position.set(0, -0.01, 0.25);
      hand.add(fist, fingers, thumb, cuff, sleeve);
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

    // pocket items: on the open right hand, low in the corner
    const palm = hand(0.0, -0.05, 0.03, 0.5, 0, 0.15);
    this.held.add(palm);
    for (const id of ITEM_ORDER) {
      const g = itemMeshes(id);
      // the meshes lie on the ground along X: a bottle stands up in the fist, the rest sit on the palm
      if (id === 'bottle') g.rotation.set(0.25, 0, -Math.PI / 2 + 0.15);
      else g.rotation.set(0.35, id === 'fish' ? 1.1 : 0.5, 0);
      g.position.set(id === 'bottle' ? 0.03 : 0, id === 'bottle' ? -0.06 : -0.02, 0);
      g.scale.setScalar(0.62);
      this.heldItems[id] = g;
      this.held.add(g);
    }

    this.root.add(this.rifle, this.pistol, this.shotgun, this.rocket, this.crossbow, this.hookGun, this.fists, this.rod, this.grenade, this.shovel, this.held);
    this.scene.add(this.root, this.leg, this.sun, this.sun.target, this.hemi);
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

  /** Threw / used the held item: the hand flicks forward. */
  toss() {
    this.tossT = 1;
  }

  /** Shovel swing when a piece is placed. */
  dig() {
    this.swing = 1;
  }

  /** V: the boot comes up into view and shoots forward. */
  kick() {
    this.kickT = 1;
  }

  /** The hook gun fired / the claw came back: a small jolt. */
  hookShot() {
    this.recoilK = 0.6;
  }

  /** Reload started: `empty` = the slide / bolt has to be racked at the end. */
  reload(empty: boolean) {
    this.reloadEmpty = empty;
  }

  private gunGroup(w: Gun) {
    return w === 'rifle' ? this.rifle : w === 'pistol' ? this.pistol : w === 'shotgun' ? this.shotgun : w === 'crossbow' ? this.crossbow : this.rocket;
  }

  fire() {
    if (this.current === 'fists') {
      this.punchHand = -this.punchHand;
      this.punchT = 1;
      return;
    }
    const w = this.current;
    this.recoilK = w === 'pistol' ? 0.7 : w === 'shotgun' ? 1.6 : w === 'rocket' ? 1.3 : 1;
    if (w === 'shotgun') this.pumpT = 1;
    if (w === 'rocket') this.guns.rocket.mag.visible = false;
    if (isViewGun(w)) {
      // the flash lives on the current gun's muzzle (a shotgun's is big, the rocket's is the motor's burn)
      const gun = this.gunGroup(w);
      const m = this.muzzles[w];
      gun.add(this.flash, this.flashLight);
      this.flash.position.copy(m);
      this.flashLight.position.copy(m);
      this.flashT = 0;
      this.flash.rotation.z = Math.random() * Math.PI;
      this.flash.scale.setScalar((w === 'shotgun' ? 1.6 : w === 'rocket' ? 2 : 0.8) + Math.random() * 0.5);
    }
  }

  /** Muzzle position in camera space (for tracers). */
  muzzleCameraSpace(out = new Vector3()): Vector3 {
    const w: Gun = isViewGun(this.current) ? this.current : 'rifle';
    const gun = this.gunGroup(w);
    gun.updateWorldMatrix(true, false);
    return out.copy(this.muzzles[w]).applyMatrix4(gun.matrixWorld);
  }

  /** Where the hook gun's claw sits, as seen by the world camera (the rope starts there). */
  hookClawWorld(camera: PerspectiveCamera, out = new Vector3()): Vector3 {
    this.hookGun.updateWorldMatrix(true, false);
    return this.toWorldCamera(out.copy(this.hookClaw).applyMatrix4(this.hookGun.matrixWorld), camera);
  }

  /** A point in viewmodel-camera space → the world point on the same screen spot at the same distance. */
  private toWorldCamera(p: Vector3, camera: PerspectiveCamera) {
    const dist = p.length();
    p.project(this.camera);
    p.z = 0.5;
    p.unproject(camera).sub(camera.position).normalize().multiplyScalar(dist);
    return p.add(camera.position);
  }

  /**
   * Where the rod tip appears in the world camera's view: the viewmodel has its own FOV, so the tip is projected to
   * the screen with the viewmodel camera and put back on the same screen point at the same distance with `camera`.
   */
  rodTipWorld(camera: PerspectiveCamera, out = new Vector3()): Vector3 {
    this.rod.updateWorldMatrix(true, false);
    return this.toWorldCamera(out.copy(this.rodTip).applyMatrix4(this.rod.matrixWorld), camera);
  }

  update(dt: number, opts: { speed: number; lookDX: number; lookDY: number; reload: number; sunCam: Vector3; upCam: Vector3; aspect: number;
    /** The magazine is empty: the slide stays locked back. */
    empty?: boolean;
    /** Crossbow charge time (0..3s). */
    charge?: number;
    /** Apple eating progress (0..1). */
    eatProgress?: number; }) {
    this.camera.aspect = opts.aspect;
    this.camera.updateProjectionMatrix();
    this.recoilK = Math.max(0, this.recoilK - dt * (this.current === 'shotgun' || this.current === 'rocket' ? 6 : 9));
    this.flashT += dt;
    this.flash.visible = this.flashT < 0.045;
    this.flashLight.intensity = this.flash.visible ? 3 : 0;
    this.lower = Math.max(0, this.lower - dt * 4);
    this.swayX += (Math.max(-1, Math.min(1, opts.lookDX * 6)) * 0.03 - this.swayX) * Math.min(1, dt * 10);
    this.swayY += (Math.max(-1, Math.min(1, opts.lookDY * 6)) * 0.03 - this.swayY) * Math.min(1, dt * 10);
    const sp = Math.min(opts.speed / 7.6, 1.5);
    this.bobT += dt * (4 + sp * 6) * (sp > 0.05 ? 1 : 0.3);
    const bob = sp * 0.012;
    const k = this.recoilK;
    const rel = opts.reload;
    const charge = opts.charge ?? 0;
    const shake = charge > 0 ? Math.min(1, charge / 3) * 0.0035 * Math.sin(this.bobT * 18) : 0;
    // reload: the gun rolls to show the magazine well, then comes back
    const relDip = rel > 0 ? Math.sin(Math.min(rel, 1) * Math.PI) : 0;
    const r = this.root;
    r.position.set(0.25 - this.swayX + Math.cos(this.bobT) * bob - relDip * 0.04 + shake, -0.25 - this.swayY - Math.abs(Math.sin(this.bobT)) * bob - this.lower * 0.25 - relDip * 0.04,
      -0.5 + k * 0.05 + Math.min(1, charge / 3) * 0.035);
    r.rotation.set(k * 0.09 + relDip * 0.18, -0.04 + this.swayX * 0.6 + relDip * 0.15, relDip * 0.45);
    this.animateGun(rel, opts.empty ?? false, charge);
    this.swing = Math.max(0, this.swing - dt * 5);
    const weapon = this.tool === null;
    this.rifle.visible = weapon && this.current === 'rifle';
    this.pistol.visible = weapon && this.current === 'pistol';
    this.shotgun.visible = weapon && this.current === 'shotgun';
    this.rocket.visible = weapon && this.current === 'rocket';
    this.crossbow.visible = weapon && this.current === 'crossbow';
    this.hookGun.visible = this.tool === 'hook';
    this.hookModel.mag.visible = !this.hookOut;
    this.fists.visible = weapon && this.current === 'fists';
    this.grenade.visible = weapon && this.current === 'grenade';
    this.shovel.visible = this.tool === 'build';
    this.rod.visible = this.tool === 'rod';
    const item = this.tool && this.tool in this.heldItems ? this.tool as ItemId : null;
    this.held.visible = !!item;
    for (const id of ITEM_ORDER) this.heldItems[id].visible = id === item;
    // throw or eat: wind up a little, flick forward (or raise apple to mouth when eating for 1s)
    this.tossT = Math.max(0, this.tossT - dt * 3.2);
    const fling = Math.sin(this.tossT * Math.PI);
    const eatP = item === 'apple' ? (opts.eatProgress ?? 0) : 0;
    if (eatP > 0) {
      const chew = Math.sin(eatP * Math.PI * 6) * 0.018;
      const lift = Math.min(1, eatP * 2.5);
      this.held.position.set(-0.12 * lift, 0.03 + 0.11 * lift + chew, -0.08 + 0.06 * lift);
      this.held.rotation.set(0.35 * lift + chew * 2, 0.2 * lift, 0.15 * lift);
    } else {
      this.held.position.set(0.0, 0.03 + fling * 0.08, -0.08 - fling * 0.22);
      this.held.rotation.set(-fling * 0.7, 0, 0);
    }
    if (item) this.heldItems[item].visible = this.tossT < 0.35 || this.tossT > 0.75;
    // punch: a quick wind-up, then the active fist drives forward and in with a twist of the wrist, the other one
    // pulls back to the chin; the whole guard leans into it
    this.punchT = Math.max(0, this.punchT - dt * 4.2);
    const pt = 1 - this.punchT;
    const wind = this.punchT > 0 ? Math.sin(Math.min(1, pt / 0.18) * Math.PI) * (pt < 0.18 ? 1 : 0) : 0;
    const jab = this.punchT > 0 && pt >= 0.12 ? Math.sin(Math.min(1, (pt - 0.12) * 1.9) * Math.PI) : 0;
    this.fists.children.forEach((h, i) => {
      const side = i === 0 ? -1 : 1;
      const rest = h.userData.rest as Vector3;
      const on = side === this.punchHand ? jab : 0;
      const back = side === this.punchHand ? wind : jab * 0.4;
      h.position.set(rest.x - side * on * 0.17, rest.y + on * 0.1 - back * 0.02, rest.z - on * 0.42 + back * 0.06);
      h.rotation.set(0.6 - on * 0.35, -side * 0.2, side * (0.35 - on * 1.1));
    });
    this.fists.position.set(-this.punchHand * jab * 0.03, 0, -jab * 0.05);
    this.fists.rotation.set(0, this.punchHand * jab * 0.12, 0);
    // kick: the boot rises from below the screen and drives forward, then drops back out of view
    this.kickT = Math.max(0, this.kickT - dt * 2.6);
    this.leg.visible = this.kickT > 0;
    if (this.kickT > 0) {
      const kt = 1 - this.kickT;
      const up = Math.sin(Math.min(1, kt / 0.75) * Math.PI);
      const thrust = Math.sin(Math.min(1, Math.max(0, kt - 0.12) / 0.5) * Math.PI);
      this.leg.position.set(0.05, -0.95 + up * 0.55, -0.45 - thrust * 0.32);
      this.leg.rotation.set(0.35 + up * 0.9, 0.08, 0);
    }
    // shotgun pump: racked back and forward right after the shot
    this.pumpT = Math.max(0, this.pumpT - dt * 2.2);
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

  /** Magazine out / in and the slide or bolt during a reload; the slide cycles on a shot and locks back when empty. */
  private animateGun(rel: number, empty: boolean, charge = 0) {
    const smooth = (a: number, b: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    };
    if (this.current === 'crossbow') {
      const g = this.guns.crossbow;
      const cRatio = Math.min(1, charge / 3);
      if (rel > 0) {
        g.mag.visible = rel > 0.45;
        g.mag.position.set(0, 0, (1 - smooth(0.45, 0.9, rel)) * 0.12);
        g.slide.position.z = smooth(0.2, 0.85, rel) * 0.05;
        g.mag.scale.set(1, 1, 1);
      } else {
        g.mag.visible = true;
        g.mag.position.set(0, 0, cRatio * 0.09);
        g.slide.position.z = 0.05 + cRatio * SLIDE_TRAVEL.crossbow!;
        const lvl = Math.min(3, Math.floor(charge));
        g.mag.scale.set(1 + lvl * 0.65, 1 + lvl * 0.25, 1);
      }
      return;
    }
    if (this.current === 'shotgun') {
      const g = this.guns.shotgun;
      // shells go into the loading port one after another, the pump is worked at the end (and after every shot)
      const shell = rel > 0 && rel < 0.85 ? (rel * 4) % 1 : 0;
      g.mag.visible = rel > 0 && rel < 0.85;
      g.mag.position.set(0, -0.06 + smooth(0.2, 0.7, shell) * 0.05, 0.05 - smooth(0.2, 0.7, shell) * 0.02);
      const pump = this.pumpT > 0 ? Math.sin((1 - this.pumpT) * Math.PI) : rel > 0.85 ? Math.sin(smooth(0.85, 1, rel) * Math.PI) : 0;
      g.slide.position.z = pump * SLIDE_TRAVEL.shotgun!;
      return;
    }
    if (this.current === 'rocket') {
      // a new rocket slides into the front of the tube
      const g = this.guns.rocket;
      if (rel > 0) {
        g.mag.visible = rel > 0.35;
        g.mag.position.set(0, -0.06 * (1 - smooth(0.35, 0.8, rel)), -0.25 * (1 - smooth(0.35, 0.8, rel)));
      } else {
        g.mag.position.set(0, 0, 0);
        if (!empty) g.mag.visible = true;
      }
      return;
    }
    if (this.current !== 'rifle' && this.current !== 'pistol') return;
    const g = this.guns[this.current];
    const travel = SLIDE_TRAVEL[this.current]!;
    let magDrop = 0;
    let slide = Math.min(1, this.recoilK * 1.2) * 0.8;
    if (rel > 0) {
      // old magazine out (0.1–0.38), new one in from below (0.42–0.7)
      magDrop = rel < 0.4 ? smooth(0.1, 0.38, rel) : 1 - smooth(0.42, 0.7, rel);
      // empty: the pistol slide is already locked back, the rifle bolt gets pulled; both slam home at the end
      const pull = this.current === 'pistol' ? 1 : smooth(0.76, 0.84, rel);
      slide = this.reloadEmpty ? (rel < 0.88 ? pull : 1 - smooth(0.88, 0.92, rel)) : 0;
    } else if (empty && this.current === 'pistol') slide = 1;
    g.mag.position.set(0, -magDrop * 0.3, magDrop * 0.05);
    g.mag.visible = magDrop < 0.95;
    g.slide.position.z = slide * travel;
  }

  render(renderer: WebGLRenderer) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = true;
  }
}
