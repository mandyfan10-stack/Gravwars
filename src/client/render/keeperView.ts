import {
  AdditiveBlending, BackSide, CanvasTexture, Color, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  Quaternion, Scene, Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { MapData } from '../../shared/map';
import { getTeam, TeamId } from '../../shared/teams';
import type { GameAssets } from './assets';
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

interface Keeper { team: TeamId; model: PlayerModel; aura: Mesh; ring: Mesh; phase: number }

/**
 * Shopkeepers behind the counters: a man in a dark suit, sunglasses, empty hands, standing idle and
 * glancing around, with a quiet aura in the team colour.
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

      // neutral shops in the central city: a cool steel blue
      const color = new Color(b.team ? getTeam(b.team as TeamId).color : 0x6fa8d0);
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
      this.keepers.push({ team: b.team as TeamId, model, aura, ring, phase: this.keepers.length * 1.7 });
    }
  }

  update(dt: number, time: number) {
    for (const k of this.keepers) {
      const t = time + k.phase;
      k.model.update(dt, { speed: 0, grounded: true, vUp: 0, fired: false });
      // slow look around the roof
      k.model.bone('head').rotation.y = Math.sin(t * 0.35) * 0.45;
      const pulse = 0.85 + Math.sin(t * 1.6) * 0.15;
      (k.aura.material as MeshBasicMaterial).opacity = pulse;
      k.aura.rotation.y = t * 0.2;
    }
  }
}
