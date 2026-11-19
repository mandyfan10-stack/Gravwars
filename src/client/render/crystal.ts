import { pixelDot } from './pixelart';
import {
  AdditiveBlending, BufferAttribute, BufferGeometry, CanvasTexture, Color, DoubleSide, Group, IcosahedronGeometry, Mesh, MeshBasicMaterial,
  MeshPhysicalMaterial, PointLight, Points, PointsMaterial, RingGeometry, ShaderMaterial, TorusGeometry, Vector3,
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
const sparkTexture = () => {
  if (!sparkTex) {
    sparkTex = pixelDot(8);
    sparkTex.userData.shared = true;
  }
  return sparkTex;
};

/** Animated plasma & Fresnel energy shader material for crystals. */
function makePlasmaMat(color: number) {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(color) },
      uTime: { value: 0 },
      uStage: { value: 0 },
    },
    vertexShader: `
      varying vec3 vLocal;
      varying vec3 vNormalView;
      varying vec3 vViewPos;
      void main() {
        vLocal = position;
        vNormalView = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uStage;
      varying vec3 vLocal;
      varying vec3 vNormalView;
      varying vec3 vViewPos;
      void main() {
        vec3 N = normalize(vNormalView);
        vec3 V = normalize(vViewPos);
        float fresnel = pow(clamp(1.0 - abs(dot(N, V)), 0.0, 1.0), 2.1);
        float waveA = sin(vLocal.y * 5.2 - uTime * (2.6 + uStage * 1.6) + sin(vLocal.x * 7.0 + vLocal.z * 7.0));
        float waveB = cos((vLocal.x - vLocal.z) * 8.0 + uTime * 3.1);
        float veins = smoothstep(0.35, 0.92, waveA * 0.65 + waveB * 0.35);
        float intensity = 0.25 + fresnel * 1.45 + veins * (0.8 + uStage * 0.55);
        vec3 tint = mix(uColor, vec3(1.0), fresnel * 0.45 + veins * 0.35 + uStage * 0.2);
        gl_FragColor = vec4(tint * (1.2 + intensity), clamp(0.18 + fresnel * 0.55 + veins * 0.38, 0.0, 0.92));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
  });
}

/** Glassy shell over a glowing core: the shell reflects the sky with a rainbow sheen, the core feeds the bloom. */
export function crystalMaterials(color: number) {
  const c = new Color(color);
  const shell = new MeshPhysicalMaterial({
    color: c.clone().lerp(new Color(0xffffff), 0.15), roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05,
    iridescence: 0.7, iridescenceIOR: 1.7, iridescenceThicknessMinimum: 200, iridescenceThicknessMaximum: 600, envMapIntensity: 2.2,
    transparent: true, opacity: 0.38, depthWrite: false, flatShading: true,
  });
  const core = new MeshBasicMaterial({ color: c.clone().multiplyScalar(2.2) });
  const plasma = makePlasmaMat(color);
  return { shell, core, plasma };
}

/** One crystal: core + animated plasma shell + outer glass shell sharing geometry. */
function crystalMesh(geo: BufferGeometry, mats: ReturnType<typeof crystalMaterials>) {
  const g = new Group();
  const core = new Mesh(geo, mats.core);
  core.scale.setScalar(0.55);
  const aura = new Mesh(geo, mats.plasma);
  aura.scale.setScalar(0.84);
  aura.renderOrder = 1;
  const shell = new Mesh(geo, mats.shell);
  shell.renderOrder = 2;
  shell.castShadow = true;
  g.add(core, aura, shell);
  return g;
}

export interface CrystalCluster {
  group: Group;
  setStage(stage: 1 | 2, invulnT: number): void;
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

  // Ambient floating energy halo rings around the crystal
  const orbitMat = new MeshBasicMaterial({
    color: new Color(color).lerp(new Color(0xffffff), 0.35).multiplyScalar(1.8),
    transparent: true,
    opacity: 0.42,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const orbit1 = new Mesh(new TorusGeometry(1.45, 0.025, 6, 36), orbitMat);
  orbit1.rotation.x = Math.PI * 0.36;
  const orbit2 = new Mesh(new TorusGeometry(1.75, 0.02, 6, 36), orbitMat);
  orbit2.rotation.x = -Math.PI * 0.42;
  orbit2.rotation.z = Math.PI * 0.25;
  group.add(orbit1, orbit2);

  // Invulnerability barrier (shown during the 10s countdown between Stage 1 and Stage 2)
  const shieldGroup = new Group();
  shieldGroup.visible = false;
  const shieldMat = new MeshBasicMaterial({
    color: new Color(color).lerp(new Color(0xffffff), 0.55).multiplyScalar(2.2),
    transparent: true,
    opacity: 0.28,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
    wireframe: true,
  });
  const shieldDome = new Mesh(new IcosahedronGeometry(2.15, 2), shieldMat);
  const ringMat = new MeshBasicMaterial({
    color: new Color(color).lerp(new Color(0xffffff), 0.7).multiplyScalar(3.2),
    transparent: true,
    opacity: 0.75,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const ring1 = new Mesh(new TorusGeometry(2.25, 0.045, 8, 36), ringMat);
  const ring2 = new Mesh(new TorusGeometry(2.25, 0.045, 8, 36), ringMat);
  ring2.rotation.x = Math.PI / 2;
  shieldGroup.add(shieldDome, ring1, ring2);
  group.add(shieldGroup);

  // Visual healing (+2 HP/s) & ammo refill zone (radius = 8.5 m, flush on base hall floor at y = -2.73 relative to crystal center)
  const zoneGroup = new Group();
  zoneGroup.position.y = -2.73;
  const zoneColor = new Color(color).lerp(new Color(0x7dffa8), 0.32);
  const zoneFillMat = new MeshBasicMaterial({
    color: zoneColor,
    transparent: true,
    opacity: 0.09,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
  const zoneBorderMat = new MeshBasicMaterial({
    color: zoneColor.clone().multiplyScalar(1.9),
    transparent: true,
    opacity: 0.65,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
  const zoneDisc = new Mesh(new RingGeometry(2.2, 8.5, 48).rotateX(-Math.PI / 2), zoneFillMat);
  const zoneOuter = new Mesh(new RingGeometry(8.34, 8.52, 64).rotateX(-Math.PI / 2), zoneBorderMat);
  const zoneInner = new Mesh(new RingGeometry(5.25, 5.34, 48).rotateX(-Math.PI / 2), zoneBorderMat.clone());
  (zoneInner.material as MeshBasicMaterial).opacity = 0.28;
  zoneGroup.add(zoneDisc, zoneOuter, zoneInner);
  group.add(zoneGroup);

  let stage: 1 | 2 = 1;
  let invulnT = 0;

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
    setStage(st, inv) {
      stage = st;
      invulnT = inv;
      shieldGroup.visible = inv > 0;
    },
    update(time, dt) {
      const spinMult = invulnT > 0 ? 4.5 + (10 - invulnT) * 0.6 : stage === 2 ? 1.85 : 1;
      mats.plasma.uniforms.uTime.value = time;
      mats.plasma.uniforms.uStage.value = stage === 2 || invulnT > 0 ? 1 : 0;
      float.position.y = Math.sin(time * (stage === 2 ? 1.8 : 1.1) + seed) * (stage === 2 ? 0.18 : 0.12);
      float.rotation.y += dt * 0.25 * spinMult;
      orbit1.rotation.z += dt * 0.75 * spinMult;
      orbit1.rotation.y += dt * 0.35;
      orbit2.rotation.z -= dt * 0.55 * spinMult;
      orbitMat.opacity = invulnT > 0 ? 0.8 : stage === 2 ? 0.65 : 0.38;
      const zonePulse = 0.72 + 0.28 * Math.sin(time * 2.2 + seed);
      zoneFillMat.opacity = (invulnT > 0 ? 0.14 : 0.085) * zonePulse;
      zoneBorderMat.opacity = (invulnT > 0 ? 0.85 : 0.58) * zonePulse;
      zoneOuter.rotation.y += dt * 0.18;
      zoneInner.rotation.y -= dt * 0.28;
      if (invulnT > 0) {
        const urgency = 1 + (10 - invulnT) * 0.9;
        const pulse = 0.5 + 0.5 * Math.sin(time * 6 * urgency);
        shieldMat.opacity = 0.22 + 0.25 * pulse;
        shieldDome.rotation.y -= dt * 1.4;
        ring1.rotation.x += dt * 2.6 * urgency;
        ring1.rotation.y += dt * 1.8;
        ring2.rotation.y -= dt * 2.9 * urgency;
        ring2.rotation.z += dt * 2.1;
        const scalePulse = 1 + 0.06 * Math.sin(time * 8 * urgency);
        shieldGroup.scale.setScalar(scalePulse);
        mats.core.color.set(color).lerp(new Color(0xffffff), 0.65).multiplyScalar(3.2 + 1.8 * pulse);
        light.intensity = 9 + 6 * pulse;
      } else {
        // the core breathes (stage 2 glows hotter and satellites float slightly higher)
        const k = 0.8 + 0.2 * Math.sin(time * (stage === 2 ? 3.4 : 2.1) + seed);
        mats.core.color.set(color).multiplyScalar((stage === 2 ? 2.2 : 1.6) + k);
        light.intensity = (stage === 2 ? 6.5 : 5) + 3 * k;
      }
      main.scale.setScalar(stage === 2 && invulnT <= 0 ? 0.88 : 1);
      for (let i = 0; i < N; i++) {
        const s = seeds[i];
        const t = (time * s.s * (invulnT > 0 ? 2.4 : stage === 2 ? 1.4 : 1) + s.o) % 1;
        const a = s.a + time * 0.4 * spinMult;
        pos[i * 3] = Math.cos(a) * s.r * (1 - t * 0.5);
        pos[i * 3 + 1] = -1.9 + t * 4.2;
        pos[i * 3 + 2] = Math.sin(a) * s.r * (1 - t * 0.5);
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}
