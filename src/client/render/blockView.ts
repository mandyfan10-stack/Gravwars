import {
  BoxGeometry, CanvasTexture, Color, EdgesGeometry, Group, InstancedMesh, LineBasicMaterial, LineSegments, Matrix4, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, NearestFilter, RepeatWrapping, Scene, SRGBColorSpace, Vector3,
} from 'three';
import {
  BLOCK_ORDER, BlockKind, BlockMaterial, BlockSystem, PIECE_CELL, PIECE_LEVEL, PIECE_THICK, PiecePlan,
} from '../../shared/blocks';
import { Rng } from '../../shared/math';

const MAX_PER_MATERIAL = 4096;

const TEX = 256;

/** Per-pixel noise on top of what is drawn: breaks up flat fills. */
function grain(x: CanvasRenderingContext2D, rng: Rng, amount: number) {
  const img = x.getImageData(0, 0, TEX, TEX);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng.next() - 0.5) * amount;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  x.putImageData(img, 0, 0);
}

const shade = (hex: string, k: number) => {
  const c = new Color(hex).multiplyScalar(k);
  return `#${c.getHexString()}`;
};

/**
 * Procedural material textures (one 1.5 m tile): planks with grain, knots and nails; cut stone with mortar and
 * bevelled edges; riveted steel plates with tread, scratches and a little rust.
 */
function texture(kind: BlockMaterial) {
  const c = document.createElement('canvas');
  c.width = c.height = TEX;
  const x = c.getContext('2d')!;
  const rng = new Rng(kind === 'wood' ? 11 : kind === 'stone' ? 23 : 37);
  if (kind === 'wood') {
    const rows = 5, h = TEX / rows;
    for (let r = 0; r < rows; r++) {
      // planks of random length, butt joints staggered
      let px = -rng.range(0, 120);
      while (px < TEX) {
        const len = rng.range(110, 200);
        const base = ['#b07a46', '#a46f3f', '#bb8650', '#9c6a3c'][Math.floor(rng.next() * 4)];
        x.fillStyle = base;
        x.fillRect(px, r * h, len, h);
        // grain: long wavy lines
        for (let g = 0; g < 9; g++) {
          x.strokeStyle = shade(base, rng.range(0.78, 0.92));
          x.lineWidth = rng.range(0.6, 1.6);
          x.beginPath();
          const gy = r * h + rng.range(3, h - 3), ph = rng.range(0, 6), amp = rng.range(0.5, 2);
          for (let gx = px; gx <= px + len; gx += 6) x.lineTo(gx, gy + Math.sin(gx * 0.05 + ph) * amp);
          x.stroke();
        }
        if (rng.next() < 0.5) { // knot
          const kx = px + rng.range(15, len - 15), ky = r * h + rng.range(10, h - 10);
          x.fillStyle = shade(base, 0.6);
          x.beginPath(); x.ellipse(kx, ky, rng.range(4, 7), rng.range(2.5, 4), 0, 0, 7); x.fill();
          x.strokeStyle = shade(base, 0.75); x.lineWidth = 1;
          x.beginPath(); x.ellipse(kx, ky, 9, 5.5, 0, 0, 7); x.stroke();
        }
        // nails at both ends, joint gap
        x.fillStyle = '#3d3a36';
        for (const nx of [px + 6, px + len - 7]) for (const ny of [r * h + 9, r * h + h - 10]) { x.beginPath(); x.arc(nx, ny, 1.8, 0, 7); x.fill(); }
        x.fillStyle = '#4a2e1b';
        x.fillRect(px + len - 1, r * h, 2, h);
        px += len;
      }
      x.fillStyle = '#3f2717';
      x.fillRect(0, r * h + h - 2, TEX, 2);
      x.fillStyle = '#ffffff22';
      x.fillRect(0, r * h, TEX, 1);
    }
    grain(x, rng, 14);
  } else if (kind === 'stone') {
    x.fillStyle = '#6c6b66'; // mortar
    x.fillRect(0, 0, TEX, TEX);
    const rows = [0, 46, 100, 142, 196, TEX];
    for (let r = 0; r < rows.length - 1; r++) {
      let px = -rng.range(0, 60);
      while (px < TEX) {
        const w = rng.range(50, 95);
        const y0 = rows[r] + 2, hh = rows[r + 1] - rows[r] - 4;
        const tone = rng.range(0.9, 1.12);
        const base = shade('#a6a49b', tone);
        const draw = (ox: number) => {
          x.fillStyle = base;
          x.fillRect(ox + 2, y0, w - 4, hh);
          // bevel: light top / left, dark bottom / right
          x.fillStyle = '#ffffff30'; x.fillRect(ox + 2, y0, w - 4, 3); x.fillRect(ox + 2, y0, 3, hh);
          x.fillStyle = '#00000038'; x.fillRect(ox + 2, y0 + hh - 3, w - 4, 3); x.fillRect(ox + w - 5, y0, 3, hh);
          // pits
          for (let k = 0; k < 6; k++) {
            x.fillStyle = shade(base, rng.range(0.7, 0.85));
            x.fillRect(ox + rng.range(6, w - 8), y0 + rng.range(5, hh - 5), rng.range(1, 3), rng.range(1, 3));
          }
        };
        draw(px);
        if (px + w > TEX) draw(px - TEX); // wrap around
        px += w;
      }
    }
    grain(x, rng, 22);
  } else {
    const base = '#8d989d';
    x.fillStyle = base;
    x.fillRect(0, 0, TEX, TEX);
    // brushed finish
    for (let i = 0; i < 260; i++) {
      x.fillStyle = rng.next() < 0.5 ? '#ffffff10' : '#00000010';
      x.fillRect(0, rng.range(0, TEX), TEX, 1);
    }
    // diamond tread
    for (let yy = 8; yy < TEX; yy += 16) for (let xx = (yy / 16) % 2 ? 0 : 8; xx < TEX; xx += 16) {
      x.save(); x.translate(xx, yy); x.rotate((yy / 16) % 2 ? 0.7 : -0.7);
      x.fillStyle = '#b4bec2'; x.fillRect(-5, -1.5, 10, 3);
      x.fillStyle = '#5d686d'; x.fillRect(-5, 1.5, 10, 1);
      x.restore();
    }
    // panel seams and rivets: 2 × 2 plates per tile
    for (const k of [0, TEX / 2]) {
      x.fillStyle = '#4b5458'; x.fillRect(k, 0, 3, TEX); x.fillRect(0, k, TEX, 3);
      x.fillStyle = '#c2cbce55'; x.fillRect(k + 3, 0, 1, TEX); x.fillRect(0, k + 3, TEX, 1);
    }
    for (const a of [0, TEX / 2]) for (const b of [0, TEX / 2]) for (let i = 0; i < 5; i++) {
      for (const [rx, ry] of [[a + 10 + i * 27, b + 10], [a + 10 + i * 27, b + TEX / 2 - 10], [a + 10, b + 10 + i * 27], [a + TEX / 2 - 10, b + 10 + i * 27]]) {
        x.fillStyle = '#5a6468'; x.beginPath(); x.arc(rx + 0.8, ry + 0.8, 3.2, 0, 7); x.fill();
        x.fillStyle = '#b9c2c5'; x.beginPath(); x.arc(rx, ry, 2.6, 0, 7); x.fill();
      }
    }
    // scratches, rust
    for (let i = 0; i < 18; i++) {
      x.strokeStyle = '#d6dde055'; x.lineWidth = 1;
      x.beginPath(); const sx = rng.range(0, TEX), sy = rng.range(0, TEX); x.moveTo(sx, sy); x.lineTo(sx + rng.range(-30, 30), sy + rng.range(-8, 8)); x.stroke();
    }
    for (let i = 0; i < 7; i++) {
      const g = x.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, '#7a4a2a80'); g.addColorStop(1, '#7a4a2a00');
      x.save(); x.translate(rng.range(0, TEX), rng.range(0, TEX)); x.scale(rng.range(6, 16), rng.range(4, 10));
      x.fillStyle = g; x.beginPath(); x.arc(0, 0, 1, 0, 7); x.fill(); x.restore();
    }
    grain(x, rng, 10);
  }
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Crack map (red channel): each crack has a value v, it shows once the damage exceeds 1 - v, so a block cracks a
 * little at first and more and more as it is shot.
 */
function crackTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = TEX;
  const x = c.getContext('2d')!;
  x.fillStyle = '#000'; x.fillRect(0, 0, TEX, TEX);
  const rng = new Rng(5);
  const branch = (px: number, py: number, a: number, len: number, v: number, w: number, depth: number) => {
    x.strokeStyle = `rgb(${Math.round(v * 255)},0,0)`;
    x.lineWidth = w;
    x.lineCap = 'round';
    x.beginPath(); x.moveTo(px, py);
    for (let s = 0; s < len; s += 7) {
      a += rng.range(-0.5, 0.5);
      px += Math.cos(a) * 7; py += Math.sin(a) * 7;
      x.lineTo(px, py);
      if (depth > 0 && rng.next() < 0.12) branch(px, py, a + rng.range(-1.2, 1.2), len * 0.45, v * 0.8, w * 0.7, depth - 1);
    }
    x.stroke();
  };
  // three generations: early hairlines, then wider networks
  for (const [v, n, w] of [[0.92, 3, 3], [0.6, 5, 4], [0.35, 7, 5]] as const) {
    for (let i = 0; i < n; i++) {
      const cx = rng.range(20, TEX - 20), cy = rng.range(20, TEX - 20);
      const arms = 3 + Math.floor(rng.next() * 3);
      for (let k = 0; k < arms; k++) branch(cx, cy, (k / arms) * Math.PI * 2 + rng.range(-0.3, 0.3), rng.range(40, 110), v, w, 2);
    }
  }
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  // the values are thresholds, not colours: no filtering / mipmaps that would average them away
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.userData.keepFilter = true;
  return t;
}

/** Instance colour carries the block's health (0..1): darkens it and opens up the cracks. */
function withDamage(mat: MeshStandardMaterial, cracks: CanvasTexture) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.crackMap = { value: cracks };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D crackMap;')
      .replace('#include <color_fragment>', `
        #ifdef USE_COLOR
          // (in the fragment stage instance colours come in as USE_COLOR / vColor)
          float health = vColor.r;
          float dmg = 1.0 - health;
          float crack = texture2D(crackMap, vMapUv).r;
          diffuseColor.rgb *= mix(0.55, 1.0, health);
          if (crack > 0.02 && dmg > 1.0 - crack + 0.04) diffuseColor.rgb *= 0.18;
        #endif`);
  };
  mat.customProgramCacheKey = () => 'block-damage';
  return mat;
}

const _m = new Matrix4();
const _c = new Color();
const _s = new Vector3();

/** All placed blocks as one instanced mesh per material + the placement preview. */
/** Box with UVs in metres / TILE, so the texture repeats on big pieces instead of stretching. */
const TILE = 1.5;
function tiledBox(sx: number, sy: number, sz: number) {
  const g = new BoxGeometry(sx, sy, sz);
  if (sx === 1 && sy === 1 && sz === 1) return g;
  const uv = g.getAttribute('uv');
  // face order: ±x (z × y), ±y (x × z), ±z (x × y), 4 vertices each
  const dims = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
  for (let f = 0; f < 6; f++) for (let v = 0; v < 4; v++) {
    const i = f * 4 + v;
    uv.setXY(i, uv.getX(i) * dims[f][0] / TILE, uv.getY(i) * dims[f][1] / TILE);
  }
  return g;
}

const PIECE_SIZE: Record<BlockKind, [number, number, number]> = {
  block: [1, 1, 1],
  wall: [PIECE_THICK, PIECE_LEVEL, PIECE_CELL],
  floor: [PIECE_CELL, PIECE_THICK, PIECE_CELL],
  ramp: [Math.hypot(PIECE_CELL, PIECE_LEVEL), PIECE_THICK, PIECE_CELL],
};
const KINDS = Object.keys(PIECE_SIZE) as BlockKind[];

/** Placed blocks and pieces: one instanced mesh per material and shape, plus the placement preview. */
export class BlockView {
  private readonly meshes = new Map<string, InstancedMesh>();
  private version = -1;
  private readonly ghost = new Group();
  private readonly ghostMat = new MeshBasicMaterial({ color: 0x55eecb, transparent: true, opacity: 0.3, depthWrite: false });
  private readonly outlineMat = new LineBasicMaterial({ color: 0xbaffea });

  constructor(private readonly scene: Scene) {
    const cracks = crackTexture();
    for (const m of BLOCK_ORDER) {
      const map = texture(m);
      map.wrapS = map.wrapT = RepeatWrapping;
      const mat = withDamage(new MeshStandardMaterial({ map, roughness: m === 'metal' ? 0.5 : 0.88, metalness: m === 'metal' ? 0.55 : 0 }), cracks);
      for (const k of KINDS) {
        const mesh = this.makeMesh(tiledBox(...PIECE_SIZE[k]), mat, k === 'block' ? MAX_PER_MATERIAL : 512);
        this.meshes.set(`${m}:${k}`, mesh);
      }
    }
    this.ghost.add(new Mesh(new BoxGeometry(1.004, 1.004, 1.004), this.ghostMat), new LineSegments(new EdgesGeometry(new BoxGeometry(1.004, 1.004, 1.004)), this.outlineMat));
    this.ghost.visible = false;
    scene.add(this.ghost);
  }

  private makeMesh(geometry: InstancedMesh['geometry'], material: InstancedMesh['material'], capacity: number) {
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.count = 0;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.setColorAt(0, _c.set(0xffffff));
    this.scene.add(mesh);
    return mesh;
  }

  /** Instance capacity is fixed per mesh: rebuild it twice as large (same geometry and material) when it runs out. */
  private grow(key: string, need: number) {
    const old = this.meshes.get(key)!;
    let cap = old.instanceMatrix.count;
    if (need <= cap) return;
    while (cap < need) cap *= 2;
    this.scene.remove(old);
    old.dispose(); // instance buffers only: geometry and material are shared with the new mesh
    this.meshes.set(key, this.makeMesh(old.geometry, old.material, cap));
  }

  /** `preview` = the piece that would be placed; `ok` = it can be placed. */
  update(system: BlockSystem, preview: PiecePlan | null, ok: boolean) {
    if (system.version !== this.version) {
      this.version = system.version;
      const need = new Map<string, number>();
      for (const b of system.blocks.values()) {
        const key = `${b.material}:${b.kind}`;
        need.set(key, (need.get(key) ?? 0) + 1);
      }
      for (const [key, n] of need) this.grow(key, n);
      for (const mesh of this.meshes.values()) mesh.count = 0;
      for (const b of system.blocks.values()) {
        const mesh = this.meshes.get(`${b.material}:${b.kind}`)!;
        const i = mesh.count++;
        mesh.setMatrixAt(i, _m.compose(b.center, b.quat, _s.set(1, 1, 1)));
        // health → the shader: darker and more cracked as it is damaged
        mesh.setColorAt(i, _c.setScalar(b.hp / b.maxHp));
      }
      for (const mesh of this.meshes.values()) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    this.ghost.visible = !!preview;
    if (!preview) return;
    this.ghost.position.copy(preview.center);
    this.ghost.quaternion.copy(preview.quat);
    this.ghost.scale.copy(preview.half).multiplyScalar(2);
    this.ghostMat.color.set(ok ? 0x55eecb : 0xff5360);
    this.outlineMat.color.set(ok ? 0xbaffea : 0xff9b9b);
  }
}
