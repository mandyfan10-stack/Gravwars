import { Object3D } from 'three';
import type { PropModel } from '../../shared/map';
import { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * 3D assets (Kenney, CC0): the character from "Mini Arena" (rigged, 32 animations) and the blasters from the
 * FPS starter kit. Files live in public/models/<pack>/ next to their palette texture.
 */
export interface GameAssets {
  character: GLTF;
  /** Rifle: the repeater blaster. */
  rifle: Object3D;
  /** Small blaster (used as the grenade launcher hand pose fallback / spare). */
  blaster: Object3D;
  /** Mini Arena props placed by the map (banners, columns, racks…). */
  props: Record<PropModel, Object3D>;
}

const PROPS: PropModel[] = ['banner', 'column', 'weapon-rack', 'trophy', 'block'];

let cache: Promise<GameAssets> | null = null;

export function loadAssets(): Promise<GameAssets> {
  cache ??= (async () => {
    const loader = new GLTFLoader();
    const base = import.meta.env.BASE_URL;
    const [character, rifle, blaster, ...props] = await Promise.all([
      loader.loadAsync(`${base}models/character/character.glb`),
      loader.loadAsync(`${base}models/blaster/blaster-repeater.glb`),
      loader.loadAsync(`${base}models/blaster/blaster.glb`),
      ...PROPS.map((n) => loader.loadAsync(`${base}models/arena/${n}.glb`)),
    ]);
    for (const g of [character, rifle, blaster, ...props]) g.scene.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    return {
      character, rifle: rifle.scene, blaster: blaster.scene,
      props: Object.fromEntries(PROPS.map((n, i) => [n, props[i].scene])) as unknown as Record<PropModel, Object3D>,
    };
  })();
  return cache;
}
