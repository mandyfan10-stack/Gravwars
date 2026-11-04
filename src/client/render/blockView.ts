import {
  BoxGeometry, CanvasTexture, Color, EdgesGeometry, Group, InstancedMesh, LineBasicMaterial, LineSegments, Matrix4, Mesh,
  MeshBasicMaterial, MeshStandardMaterial, Quaternion, Scene, SRGBColorSpace, Vector3,
} from 'three';
import { BLOCK_ORDER, BLOCK_SIZE, BlockMaterial, BlockSystem } from '../../shared/blocks';

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
const IDENTITY_Q = new Quaternion();

/** All placed blocks as one instanced mesh per material + the placement preview. */
export class BlockView {
  private readonly meshes = {} as Record<BlockMaterial, InstancedMesh>;
  private version = -1;
  private readonly ghost = new Group();
  private readonly ghostMat = new MeshBasicMaterial({ color: 0x55eecb, transparent: true, opacity: 0.3, depthWrite: false });
  private readonly outlineMat = new LineBasicMaterial({ color: 0xbaffea });

  constructor(scene: Scene) {
    const geo = new BoxGeometry(BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
    for (const m of BLOCK_ORDER) {
      const mesh = new InstancedMesh(geo, new MeshStandardMaterial({
        map: texture(m), roughness: 0.85, metalness: m === 'metal' ? 0.38 : 0.02,
      }), MAX_PER_MATERIAL);
      mesh.count = 0;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.setColorAt(0, _c.set(0xffffff));
      scene.add(mesh);
      this.meshes[m] = mesh;
    }
    const s = BLOCK_SIZE * 1.004;
    this.ghost.add(new Mesh(new BoxGeometry(s, s, s), this.ghostMat), new LineSegments(new EdgesGeometry(new BoxGeometry(s, s, s)), this.outlineMat));
    this.ghost.visible = false;
    scene.add(this.ghost);
  }

  /** `preview` = centre of the block that would be placed; `ok` = it can be placed. */
  update(system: BlockSystem, preview: Vector3 | null, ok: boolean) {
    if (system.version !== this.version) {
      this.version = system.version;
      for (const m of BLOCK_ORDER) this.meshes[m].count = 0;
      for (const b of system.blocks.values()) {
        const mesh = this.meshes[b.material];
        if (mesh.count >= MAX_PER_MATERIAL) continue;
        const i = mesh.count++;
        mesh.setMatrixAt(i, _m.compose(b.center, IDENTITY_Q, _s.set(1, 1, 1)));
        // damaged blocks get darker
        mesh.setColorAt(i, _c.setScalar(0.45 + 0.55 * b.hp / b.maxHp));
      }
      for (const m of BLOCK_ORDER) {
        this.meshes[m].instanceMatrix.needsUpdate = true;
        if (this.meshes[m].instanceColor) this.meshes[m].instanceColor!.needsUpdate = true;
      }
    }
    this.ghost.visible = !!preview;
    if (!preview) return;
    this.ghost.position.copy(preview);
    this.ghostMat.color.set(ok ? 0x55eecb : 0xff5360);
    this.outlineMat.color.set(ok ? 0xbaffea : 0xff9b9b);
  }
}
