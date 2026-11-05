import { LinearFilter, LinearMipmapLinearFilter, Material, NearestFilter, Object3D, Texture } from 'three';

/** Textures hidden in shader closures (masks, triplanar maps) that a scene walk would not find. */
const extra = new Set<Texture>();
export function trackTexture<T extends Texture>(t: T): T {
  extra.add(t);
  return t;
}

const SLOTS = ['map', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'normalMap', 'aoMap', 'alphaMap'] as const;

/**
 * Texture magnification for everything in `roots`: nearest (crisp texels, the pixel look) or linear (smooth).
 * Minification keeps trilinear mipmaps either way, so distant surfaces do not shimmer.
 */
export function setPixelTextures(pixel: boolean, roots: Object3D[]) {
  const found = new Set<Texture>(extra);
  const visit = (m: Material) => {
    const rec = m as unknown as Record<string, unknown>;
    for (const k of SLOTS) if (rec[k] instanceof Texture) found.add(rec[k] as Texture);
    const tri = (m.userData.tri as { triMap?: { value: Texture } } | undefined)?.triMap?.value;
    if (tri) found.add(tri);
  };
  for (const r of roots) r.traverse((o) => {
    const mat = (o as { material?: Material | Material[] }).material;
    if (Array.isArray(mat)) mat.forEach(visit);
    else if (mat) visit(mat);
  });
  const mag = pixel ? NearestFilter : LinearFilter;
  for (const t of found) {
    if (t.userData?.keepFilter) continue;
    if (t.magFilter === mag) continue;
    t.magFilter = mag;
    if (t.generateMipmaps) t.minFilter = LinearMipmapLinearFilter;
    t.needsUpdate = true;
  }
}
