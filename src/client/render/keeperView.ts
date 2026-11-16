import {
  AdditiveBlending, BackSide, BoxGeometry, CanvasTexture, Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, OctahedronGeometry, Quaternion, Scene, TorusGeometry, Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { MapData } from '../../shared/map';
import { getTeam, TeamId } from '../../shared/teams';
import type { GameAssets } from './assets';
import { crossbowModel, hookGunModel, launcherModel, pistolModel, revolverModel, rifleModel, shotgunModel } from './guns';
import { appleMeshes, bottleMeshes, medkitMeshes } from './pickupView';
import { PlayerModel } from './playerModel';

/** Suit colour. */
const SUIT = 0x24262c;

/** Vertical gradient for the aura: bright at the floor, gone at head height; soft at the sides. */
function auraTexture() {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 64, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.18)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 64);
  return new CanvasTexture(c);
}

/** Sunglasses: two dark rounded lenses on a thin bridge, sized for the character's head (model units). */
function sunglasses() {
  const g = new Group();
  const lens = new MeshStandardMaterial({ color: 0x07080a, roughness: 0.3, metalness: 0 });
  const frame = new MeshStandardMaterial({ color: 0x15161a, roughness: 0.4, metalness: 0.4 });
  for (const s of [-1, 1]) {
    const l = new Mesh(new RoundedBoxGeometry(0.11, 0.065, 0.02, 2, 0.018), lens);
    l.position.set(s * 0.068, 0, 0);
    g.add(l);
    const arm = new Mesh(new RoundedBoxGeometry(0.012, 0.012, 0.2, 1, 0.004), frame);
    arm.position.set(s * 0.128, 0.012, -0.095);
    g.add(arm);
  }
  const bridge = new Mesh(new RoundedBoxGeometry(0.04, 0.012, 0.014, 1, 0.004), frame);
  bridge.position.set(0, 0.018, 0);
  g.add(bridge);
  return g;
}

/** Builds 3D showcase weapons, armor mannequin, jetpack, crystal artifact & supplies around one shop stall. */
function buildShopShowcase(teamColor: number): { root: Group; artifact: Group } {
  const root = new Group();
  // Keeper origin sits at y = R + 0.5 + PLAYER_HEIGHT/2 (+1.415 above stall ground R), z = -0.15
  // Stall counter top is at z_offset = +1.10, y_offset = -0.325; wall racks are at x = ±1.05, z_offset = -0.73
  const brass = new MeshStandardMaterial({ color: 0xc99c3c, roughness: 0.35, metalness: 0.78 });
  const darkSteel = new MeshStandardMaterial({ color: 0x26292e, roughness: 0.45, metalness: 0.7 });
  const armorMat = new MeshStandardMaterial({ color: 0x454d58, roughness: 0.38, metalness: 0.65 });

  // Countertop crystal artifact orb/prism on brass pedestal
  const ped = new Mesh(new CylinderGeometry(0.08, 0.11, 0.08, 8), brass);
  ped.position.set(0, -0.285, 1.12);
  root.add(ped);
  const artifact = new Group();
  artifact.position.set(0, -0.1, 1.12);
  const gem = new Mesh(new OctahedronGeometry(0.11, 0), new MeshBasicMaterial({ color: new Color(0x66e8ff).multiplyScalar(1.9) }));
  gem.scale.set(0.75, 1.35, 0.75);
  const halo = new Mesh(new TorusGeometry(0.14, 0.012, 6, 20), new MeshBasicMaterial({ color: new Color(teamColor).multiplyScalar(1.6) }));
  halo.rotation.x = Math.PI * 0.38;
  artifact.add(gem, halo);
  root.add(artifact);

  // Revolver & pistol displayed neatly on counter velvet trays
  const trayMat = new MeshStandardMaterial({ color: 0x4a1d24, roughness: 0.9 });
  for (const [tx, gun] of [[-0.52, revolverModel().root], [0.52, pistolModel().root]] as const) {
    const tray = new Mesh(new BoxGeometry(0.32, 0.02, 0.22), trayMat);
    tray.position.set(tx, -0.315, 1.12);
    root.add(tray);
    gun.position.set(tx, -0.29, 1.14);
    gun.rotation.set(Math.PI / 2, 0, Math.PI * 0.38);
    gun.scale.setScalar(0.85);
    root.add(gun);
  }

  // Apples, glass bottle & medkit on right/left counter ends
  const med = medkitMeshes();
  med.position.set(0.82, -0.32, 1.02);
  med.rotation.y = -0.35;
  med.scale.setScalar(1.1);
  root.add(med);

  const bot = bottleMeshes();
  bot.position.set(-0.82, -0.32, 1.04);
  bot.rotation.y = 0.5;
  bot.scale.setScalar(1.15);
  root.add(bot);

  const app = appleMeshes();
  app.position.set(-0.24, -0.32, 1.2);
  app.scale.setScalar(1.1);
  root.add(app);

  // Heavy weapons hung horizontally across left & right back wall racks
  const mountRack = (gun: Group, x: number, y: number, z: number, yaw: number, sc = 0.78) => {
    gun.position.set(x, y, z);
    gun.rotation.set(0, yaw, 0);
    gun.scale.setScalar(sc);
    root.add(gun);
  };
  mountRack(rifleModel().root, -1.05, 0.05, -0.7, Math.PI / 2, 0.78);
  mountRack(shotgunModel().root, -1.05, -0.45, -0.7, Math.PI / 2, 0.8);
  mountRack(crossbowModel().root, 1.05, 0.08, -0.7, -Math.PI / 2, 0.72);
  mountRack(launcherModel().root, 1.05, -0.42, -0.7, -Math.PI / 2, 0.72);
  mountRack(hookGunModel(teamColor).root, 0, 0.25, -0.92, Math.PI / 2, 0.8);

  // Armor mannequin stand next to left rack
  const armorStand = new Group();
  armorStand.position.set(-1.68, -0.82, -0.42);
  const standPost = new Mesh(new CylinderGeometry(0.03, 0.04, 0.9, 6), darkSteel);
  standPost.position.y = 0.2;
  const chest = new Mesh(new RoundedBoxGeometry(0.36, 0.42, 0.22, 2, 0.04), armorMat);
  chest.position.y = 0.45;
  const shoulderBar = new Mesh(new BoxGeometry(0.46, 0.1, 0.18), darkSteel);
  shoulderBar.position.y = 0.6;
  const visor = new Mesh(new BoxGeometry(0.24, 0.05, 0.24), new MeshBasicMaterial({ color: new Color(teamColor).multiplyScalar(1.4) }));
  visor.position.y = 0.48;
  armorStand.add(standPost, chest, shoulderBar, visor);
  root.add(armorStand);

  // Twin-thruster Jetpack unit displayed beside right rack
  const jp = new Group();
  jp.position.set(1.68, -0.35, -0.42);
  jp.rotation.y = -0.35;
  const backplate = new Mesh(new BoxGeometry(0.34, 0.4, 0.08), darkSteel);
  jp.add(backplate);
  for (const sx of [-0.1, 0.1]) {
    const tank = new Mesh(new CylinderGeometry(0.068, 0.068, 0.36, 8), new MeshStandardMaterial({ color: 0xb8522e, roughness: 0.4, metalness: 0.6 }));
    tank.position.set(sx, 0, -0.05);
    const nozzle = new Mesh(new CylinderGeometry(0.04, 0.06, 0.1, 8), brass);
    nozzle.position.set(sx, -0.22, -0.05);
    jp.add(tank, nozzle);
  }
  root.add(jp);

  return { root, artifact };
}

interface Keeper { team: TeamId; model: PlayerModel; aura: Mesh; ring: Mesh; artifact: Group; phase: number }

/**
 * Shopkeepers behind the counters: a man in a dark suit, sunglasses, empty hands, standing idle and
 * glancing around, surrounded by a stocked counter and wall display racks of weapons, armor, artifacts & jetpacks.
 */
export class KeeperView {
  private readonly keepers: Keeper[] = [];

  constructor(scene: Scene, map: MapData, assets: GameAssets) {
    const tex = auraTexture();
    for (const b of map.bases) {
      const model = new PlayerModel(assets, SUIT, 'none', 0, 'suit');
      const head = model.bone('head');
      const glasses = sunglasses();
      // head bone origin is at the top of the neck (metres); the glasses were drawn for the old cartoon head
      glasses.scale.setScalar(0.62);
      glasses.position.set(0, 0.13, 0.1);
      head.add(glasses);
      model.setPose(new Vector3(...b.keeper.pos), new Quaternion(...b.keeper.quat), Math.PI);
      scene.add(model.group);

      const teamColor = b.team ? getTeam(b.team as TeamId).color : 0x6fa8d0;
      const showcase = buildShopShowcase(teamColor);
      showcase.root.position.set(...b.keeper.pos);
      showcase.root.quaternion.set(...b.keeper.quat);
      scene.add(showcase.root);

      // neutral shops in the central city: a cool steel blue
      const color = new Color(teamColor);
      const auraMat = new MeshBasicMaterial({
        // back faces only: the glow sits behind the silhouette and does not tint the face
        color: color.clone().multiplyScalar(1.6), map: tex, transparent: true, blending: AdditiveBlending, depthWrite: false, side: BackSide,
      });
      const aura = new Mesh(new CylinderGeometry(0.62, 0.7, 2.1, 24, 1, true), auraMat);
      aura.position.y = -1.83 / 2 + 1.05;
      model.group.add(aura);
      const ring = new Mesh(new CylinderGeometry(0.72, 0.72, 0.02, 32, 1, true),
        new MeshBasicMaterial({ color: color.clone().multiplyScalar(1.6), transparent: true, opacity: 0.55, blending: AdditiveBlending, depthWrite: false }));
      ring.position.y = -1.83 / 2 + 0.02;
      model.group.add(ring);
      this.keepers.push({ team: b.team as TeamId, model, aura, ring, artifact: showcase.artifact, phase: this.keepers.length * 1.7 });
    }
  }

  update(dt: number, time: number) {
    for (const k of this.keepers) {
      const t = time + k.phase;
      k.model.update(dt, { speed: 0, grounded: true, vUp: 0, fired: false });
      // slow look around the stall
      k.model.bone('head').rotation.y = Math.sin(t * 0.35) * 0.45;
      const pulse = 0.85 + Math.sin(t * 1.6) * 0.15;
      (k.aura.material as MeshBasicMaterial).opacity = pulse;
      k.aura.rotation.y = t * 0.2;
      k.artifact.rotation.y = t * 1.5;
      k.artifact.position.y = -0.1 + Math.sin(t * 2.4) * 0.025;
    }
  }
}
