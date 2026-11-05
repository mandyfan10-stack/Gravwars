import { Color, Group, Mesh, MeshBasicMaterial, OctahedronGeometry, Quaternion, Scene, Vector3 } from 'three';
import type { Generator, Match } from '../../shared/match';

const SHOWN = 8;
const Y = new Vector3(0, 1, 0);
const _spin = new Quaternion();

/** Waiting crystals hover over each generator, up to 8 visible. */
export class GeneratorView {
  private readonly items: { gen: Generator; group: Group; meshes: Mesh[]; up: Vector3 }[] = [];

  constructor(scene: Scene, match: Match) {
    const gem = new OctahedronGeometry(0.2);
    const crystal = new MeshBasicMaterial({ color: new Color(0x8af5ff).multiplyScalar(2) });
    for (const gen of match.generators) {
      const group = new Group();
      group.position.copy(gen.pos);
      group.quaternion.setFromUnitVectors(Y, gen.up);
      const meshes: Mesh[] = [];
      for (let i = 0; i < SHOWN; i++) {
        const m = new Mesh(gem, crystal);
        const a = (i / SHOWN) * Math.PI * 2;
        m.position.set(Math.cos(a) * 0.55, 0.6 + (i % 2) * 0.18, Math.sin(a) * 0.55);
        m.castShadow = true;
        group.add(m);
        meshes.push(m);
      }
      scene.add(group);
      this.items.push({ gen, group, meshes, up: gen.up });
    }
  }

  update(time: number) {
    for (const it of this.items) {
      const n = Math.min(it.gen.stored, SHOWN);
      it.meshes.forEach((m, i) => { m.visible = i < n; });
      it.group.quaternion.setFromUnitVectors(Y, it.up).multiply(_spin.setFromAxisAngle(Y, time * 0.8));
      it.group.position.copy(it.gen.pos).addScaledVector(it.up, Math.sin(time * 2) * 0.06);
    }
  }
}
