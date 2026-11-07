import { pixelDot } from './pixelart';
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, Group, Mesh, MeshBasicMaterial, MeshPhysicalMaterial, PointLight,
  Points, PointsMaterial, Vector3,
} from 'three';
import { Rng } from '../../shared/math';

/**
 * A natural-looking crystal: a hexagonal prism with a pointed tip at each end, slightly irregular (rings of
 * different radii, twisted), flat-shaded so every facet catches the light. Origin at the centre, along +Y.
 */
export function crystalGeometry(radius: number, height: number, rng: Rng, sides = 6): BufferGeometry {
  const tip = radius * 1.6;
  const ring = (y: number, r: number, twist: number) => Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2 + twist;
    const rr = r * rng.range(0.82, 1.08);
    return new Vector3(Math.cos(a) * rr, y, Math.sin(a) * rr);
  });
  const h = height / 2;
  const top = new Vector3(rng.range(-0.08, 0.08) * radius, h, rng.range(-0.08, 0.08) * radius);
  const bottom = new Vector3(0, -h, 0);
  const tw = rng.range(0, 1);
  const r1 = ring(-h + tip, radius, tw), r2 = ring(h - tip, radius * rng.range(0.85, 1), tw + rng.range(-0.08, 0.08));
  const pos: number[] = [];
  const tri = (a: Vector3, b: Vector3, c: Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    tri(bottom, r1[j], r1[i]);
    tri(r1[i], r1[j], r2[j]);
    tri(r1[i], r2[j], r2[i]);
    tri(r2[i], r2[j], top);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.computeVertexNormals();
  return g;
}

let sparkTex: CanvasTexture | null = null;
const sparkTexture = () => (sparkTex ??= pixelDot(8));

/** Glassy shell over a glowing core: the shell reflects the sky with a rainbow sheen, the core feeds the bloom. */
export function crystalMaterials(color: number) {
  const c = new Color(color);
  const shell = new MeshPhysicalMaterial({
    color: c.clone().lerp(new Color(0xffffff), 0.15), roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05,
    iridescence: 0.7, iridescenceIOR: 1.7, iridescenceThicknessRange: [200, 600], envMapIntensity: 2.2,
    transparent: true, opacity: 0.38, depthWrite: false, flatShading: true,
  });
  const core = new MeshBasicMaterial({ color: c.clone().multiplyScalar(2.2) });
  return { shell, core };
}

/** One crystal: shell + core sharing a geometry. */
function crystalMesh(geo: BufferGeometry, mats: ReturnType<typeof crystalMaterials>) {
  const g = new Group();
  const core = new Mesh(geo, mats.core);
  core.scale.setScalar(0.55);
  const shell = new Mesh(geo, mats.shell);
  shell.renderOrder = 1;
  shell.castShadow = true;
  g.add(core, shell);
  return g;
}

export interface CrystalCluster {
  group: Group;
  update(time: number, dt: number): void;
}

/**
 * A team's crystal (the "bed"): a tall main crystal floating over a ring of smaller ones, a team-coloured light and
 * sparks drifting up around it. Size ~ the old 4.4 m gem, centred on the same point, +Y = up.
 */
export function crystalCluster(color: number, seed: number): CrystalCluster {
  const rng = new Rng(seed);
  const mats = crystalMaterials(color);
  const group = new Group();
  const float = new Group();
  group.add(float);
  const main = crystalMesh(crystalGeometry(0.62, 3.6, rng), mats);
  float.add(main);
  const sats: Group[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const s = crystalMesh(crystalGeometry(rng.range(0.16, 0.26), rng.range(0.8, 1.5), rng), mats);
    s.position.set(Math.cos(a) * 0.85, -1.45 + rng.range(-0.15, 0.2), Math.sin(a) * 0.85);
    // lean outwards from the centre
    s.lookAt(s.position.clone().multiplyScalar(2).setY(s.position.y + 2.2));
    s.rotateX(Math.PI / 2);
    float.add(s);
    sats.push(s);
  }
  const light = new PointLight(new Color(color), 7, 11, 2);
  light.position.set(0, 0.3, 0);
  group.add(light);

  // sparks: rise along the crystal and fade at the top
  const N = 36;
  const pos = new Float32Array(N * 3);
  const seeds = Array.from({ length: N }, () => ({ a: rng.range(0, 6.28), r: rng.range(0.5, 1.4), s: rng.range(0.25, 0.6), o: rng.range(0, 1) }));
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  const sparks = new Points(geo, new PointsMaterial({
    map: sparkTexture(), color: new Color(color).lerp(new Color(0xffffff), 0.5).multiplyScalar(1.8), size: 0.13, transparent: true,
    depthWrite: false, blending: AdditiveBlending,
  }));
  sparks.frustumCulled = false;
  group.add(sparks);

  return {
    group,
    update(time, dt) {
      float.position.y = Math.sin(time * 1.1 + seed) * 0.12;
      float.rotation.y += dt * 0.25;
      // the core breathes
      const k = 0.8 + 0.2 * Math.sin(time * 2.1 + seed);
      mats.core.color.set(color).multiplyScalar(1.6 + k);
      light.intensity = 5 + 3 * k;
      for (let i = 0; i < N; i++) {
        const s = seeds[i];
        const t = (time * s.s + s.o) % 1;
        const a = s.a + time * 0.4;
        pos[i * 3] = Math.cos(a) * s.r * (1 - t * 0.5);
        pos[i * 3 + 1] = -1.9 + t * 4.2;
        pos[i * 3 + 2] = Math.sin(a) * s.r * (1 - t * 0.5);
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}
