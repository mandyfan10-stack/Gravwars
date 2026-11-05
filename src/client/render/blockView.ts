import {
  BoxGeometry, CanvasTexture, Color, EdgesGeometry, Group, InstancedMesh, LineBasicMaterial, LineSegments, Matrix4, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, RepeatWrapping, Scene, SRGBColorSpace, Vector3,
} from 'three';
import {
  BLOCK_ORDER, BlockKind, BlockMaterial, BlockSystem, PIECE_CELL, PIECE_LEVEL, PIECE_THICK, PiecePlan,
} from '../../shared/blocks';

const MAX_PER_MATERIAL = 4096;

function texture(kind: BlockMaterial) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d')!;
  if (kind === 'wood') {
    x.fillStyle = '#ba8955'; x.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 4; i++) {
      x.fillStyle = i % 2 ? '#a97747' : '#bf925e'; x.fillRect(0, i * 32, 128, 30);
      x.fillStyle = '#5c3c27'; x.fillRect(0, i * 32 + 30, 128, 2);
      for (let j = 0; j < 5; j++) { x.fillStyle = '#70492c66'; x.fillRect((j * 37 + i * 13) % 128, i * 32 + 6 + j * 4, 24, 1); }
    }
  } else if (kind === 'stone') {
    x.fillStyle = '#707778'; x.fillRect(0, 0, 128, 128);
    for (let r = 0; r < 4; r++) for (let q = -1; q < 4; q++) {
      x.fillStyle = (r + q) % 2 ? '#b4b3a9' : '#a3a39d'; x.fillRect(q * 48 + (r % 2) * 24 + 2, r * 32 + 2, 44, 28);
    }
  } else {
    x.fillStyle = '#82939b'; x.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? '#aab7ba' : '#96a7ad'; x.fillRect(0, i * 16, 128, 12); x.fillStyle = '#64757c'; x.fillRect(0, i * 16 + 12, 128, 4); }
    x.fillStyle = '#4e5c62';
    for (const a of [10, 118]) for (const b of [10, 118]) { x.beginPath(); x.arc(a, b, 3, 0, 7); x.fill(); }
  }
  // dark frame: neighbouring blocks stay readable
  x.strokeStyle = '#0000004d'; x.lineWidth = 8; x.strokeRect(0, 0, 128, 128);
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
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

  constructor(scene: Scene) {
    for (const m of BLOCK_ORDER) {
      const map = texture(m);
      map.wrapS = map.wrapT = RepeatWrapping;
      const mat = new MeshStandardMaterial({ map, roughness: 0.85, metalness: m === 'metal' ? 0.38 : 0.02 });
      for (const k of KINDS) {
        const mesh = new InstancedMesh(tiledBox(...PIECE_SIZE[k]), mat, k === 'block' ? MAX_PER_MATERIAL : 512);
        mesh.count = 0;
        mesh.castShadow = mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.setColorAt(0, _c.set(0xffffff));
        scene.add(mesh);
        this.meshes.set(`${m}:${k}`, mesh);
      }
    }
    this.ghost.add(new Mesh(new BoxGeometry(1.004, 1.004, 1.004), this.ghostMat), new LineSegments(new EdgesGeometry(new BoxGeometry(1.004, 1.004, 1.004)), this.outlineMat));
    this.ghost.visible = false;
    scene.add(this.ghost);
  }

  /** `preview` = the piece that would be placed; `ok` = it can be placed. */
  update(system: BlockSystem, preview: PiecePlan | null, ok: boolean) {
    if (system.version !== this.version) {
      this.version = system.version;
      for (const mesh of this.meshes.values()) mesh.count = 0;
      for (const b of system.blocks.values()) {
        const mesh = this.meshes.get(`${b.material}:${b.kind}`)!;
        if (mesh.count >= mesh.instanceMatrix.count) continue;
        const i = mesh.count++;
        mesh.setMatrixAt(i, _m.compose(b.center, b.quat, _s.set(1, 1, 1)));
        // damaged blocks get darker
        mesh.setColorAt(i, _c.setScalar(0.45 + 0.55 * b.hp / b.maxHp));
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
