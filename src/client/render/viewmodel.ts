import {
  AdditiveBlending, BoxGeometry, Color, CylinderGeometry, DirectionalLight, DoubleSide, Group, HemisphereLight, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, PointLight, Scene, SphereGeometry,
  Texture, TorusGeometry, Vector3, WebGLRenderer,
} from 'three';
import type { WeaponId } from '../../shared/weapons';

const MUZZLE = new Vector3(0, 0.035, -0.78);

/** First-person weapon drawn in its own pass on top of the world (never clips into walls). */
export class ViewModel {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(62, 1, 0.01, 10);
  private root = new Group();
  private rifle = new Group();
  private grenade = new Group();
  private flash: Group;
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

  constructor(teamColor: number) {
    const metal = new MeshStandardMaterial({ color: 0x2b2d31, roughness: 0.4, metalness: 0.7 });
    const polymer = new MeshStandardMaterial({ color: 0x4a4237, roughness: 0.8 });
    const team = new MeshStandardMaterial({ color: teamColor, roughness: 0.5, emissive: new Color(teamColor), emissiveIntensity: 0.25 });
    const lens = new MeshBasicMaterial({ color: new Color(0x1a2630) });
    const box = (w: number, h: number, d: number, m: MeshStandardMaterial | MeshBasicMaterial, x: number, y: number, z: number) => {
      const mesh = new Mesh(new BoxGeometry(w, h, d), m);
      mesh.position.set(x, y, z);
      this.rifle.add(mesh);
      return mesh;
    };
    box(0.07, 0.1, 0.5, metal, 0, 0, -0.2); // receiver
    box(0.06, 0.08, 0.26, polymer, 0, -0.01, 0.17); // stock
    box(0.05, 0.13, 0.06, polymer, 0, -0.1, 0.0).rotation.x = 0.25; // grip
    box(0.045, 0.16, 0.08, metal, 0, -0.12, -0.2).rotation.x = -0.15; // mag
    box(0.004, 0.025, 0.3, team, 0.037, 0.0, -0.22); // team stripe (side)
    box(0.004, 0.025, 0.3, team, -0.037, 0.0, -0.22);
    box(0.072, 0.06, 0.24, polymer, 0, -0.005, -0.5); // handguard
    const barrel = new Mesh(new CylinderGeometry(0.014, 0.014, 0.22, 10).rotateX(Math.PI / 2), metal);
    barrel.position.set(0, 0.035, -0.67);
    this.rifle.add(barrel);
    const scope = new Mesh(new CylinderGeometry(0.028, 0.028, 0.18, 14).rotateX(Math.PI / 2), metal);
    scope.position.set(0, 0.1, -0.2);
    this.rifle.add(scope);
    const l = new Mesh(new CylinderGeometry(0.022, 0.022, 0.005, 14).rotateX(Math.PI / 2), lens);
    l.position.set(0, 0.1, -0.11);
    this.rifle.add(l);

    // muzzle flash: two crossed additive quads
    const fm = new MeshBasicMaterial({ color: new Color(6, 3.5, 1.4), transparent: true, blending: AdditiveBlending, depthWrite: false, side: DoubleSide });
    this.flash = new Group();
    for (let i = 0; i < 2; i++) {
      const q = new Mesh(new PlaneGeometry(0.16, 0.16), fm);
      q.rotation.y = i * Math.PI / 2;
      this.flash.add(q);
    }
    const front = new Mesh(new PlaneGeometry(0.12, 0.12), fm);
    front.rotation.x = 0;
    this.flash.add(front);
    this.flash.position.copy(MUZZLE).add(new Vector3(0, 0, -0.06));
    this.flash.visible = false;
    this.rifle.add(this.flash);
    this.flashLight.position.copy(MUZZLE);
    this.rifle.add(this.flashLight);

    const gBody = new Mesh(new SphereGeometry(0.06, 16, 12), new MeshStandardMaterial({ color: 0x3d5a2a, roughness: 0.6, metalness: 0.3 }));
    const gRing = new Mesh(new TorusGeometry(0.06, 0.008, 6, 20), team);
    gRing.rotation.x = Math.PI / 2;
    const gTop = new Mesh(new CylinderGeometry(0.02, 0.025, 0.04, 10), metal);
    gTop.position.y = 0.07;
    const pin = new Mesh(new TorusGeometry(0.018, 0.004, 6, 16), metal);
    pin.position.set(0.03, 0.08, 0);
    this.grenade.add(gBody, gRing, gTop, pin);
    this.grenade.position.set(0, 0, -0.1);

    this.root.add(this.rifle, this.grenade);
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
    return out.copy(MUZZLE).applyMatrix4(this.rifle.matrixWorld);
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
    this.rifle.visible = this.current === 'rifle';
    this.grenade.visible = this.current === 'grenade';
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
