import { BufferAttribute, BufferGeometry, Color, Material, Matrix4, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _m = new Matrix4();
const _inv = new Matrix4();

/**
 * Merge meshes into one draw call: every part's geometry is moved into `root`'s space and painted with its material
 * colour as a vertex colour, then all of them share `material` (which must use vertexColors). `pick` chooses the
 * meshes (default: every mesh under root). The picked meshes are removed from the scene graph.
 */
export function bakeMeshes(root: Object3D, material: Material, pick: (m: Mesh) => boolean = () => true): Mesh | null {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const parts: BufferGeometry[] = [];
  const meshes: Mesh[] = [];
  root.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !pick(mesh)) return;
    meshes.push(mesh);
  });
  for (const mesh of meshes) {
    let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(_m.multiplyMatrices(_inv, mesh.matrixWorld));
    const c = ((mesh.material as MeshStandardMaterial).color ?? new Color(1, 1, 1));
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
    g.setAttribute('color', new BufferAttribute(col, 3));
    parts.push(g);
    mesh.removeFromParent();
  }
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  const out = new Mesh(merged, material);
  out.castShadow = true;
  out.receiveShadow = true;
  root.add(out);
  return out;
}
