import { Object3D } from 'three';
import type { PropModel } from '../../shared/map';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * 3D assets (Kenney, CC0): the Mini Arena props placed by the map (banners, columns, racks…). Files live in
 * public/models/arena/ next to their palette texture. People, guns and hands are built in code.
 */
export interface GameAssets {
  props: Record<PropModel, Object3D>;
}

const PROPS: PropModel[] = ['banner', 'column', 'weapon-rack', 'trophy', 'block'];

let cache: Promise<GameAssets> | null = null;

export function loadAssets(): Promise<GameAssets> {
  cache ??= (async () => {
    const loader = new GLTFLoader();
    const base = import.meta.env.BASE_URL;
    const props = await Promise.all(PROPS.map((n) => loader.loadAsync(`${base}models/arena/${n}.glb`)));
    for (const g of props) g.scene.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    return { props: Object.fromEntries(PROPS.map((n, i) => [n, props[i].scene])) as unknown as Record<PropModel, Object3D> };
  })();
  return cache;
}
