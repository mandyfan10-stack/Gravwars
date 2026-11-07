import {
  Color, ConeGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion,
  Scene, SphereGeometry, Vector2, Vector3, WebGLRenderer,
} from 'three';
import type { MapData } from '../../shared/map';
import { getTeam, TeamId } from '../../shared/teams';

/** Corner compass: an arrow to the ground of every face of the cube (team colour, grey = neutral), relative to your view. */
export class GravityGizmo {
  private scene = new Scene();
  private camera = new PerspectiveCamera(32, 1, 0.1, 20);
  private arrows: { face: string; g: Group }[] = [];
  private tmp = new Vector2();

  constructor(map: MapData) {
    const cone = new ConeGeometry(0.16, 0.36, 12);
    const stick = new CylinderGeometry(0.035, 0.035, 0.6, 6);
    for (const f of map.faces) {
      const g = new Group();
      const color = f.team ? getTeam(f.team as TeamId).color : 0x8a8f96;
      const mat = new MeshBasicMaterial({ color: new Color(color) });
      const s = new Mesh(stick, mat);
      s.position.y = 0.3;
      const c = new Mesh(cone, mat);
      c.position.y = 0.75;
      g.add(s, c);
      g.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(...f.up).negate());
      this.scene.add(g);
      this.arrows.push({ face: f.id, g });
    }
    this.scene.add(new Mesh(new SphereGeometry(0.14, 16, 8), new MeshBasicMaterial({ color: 0xffd98a })));
  }

  render(renderer: WebGLRenderer, view: Quaternion, currentFace: string) {
    for (const a of this.arrows) a.g.scale.setScalar(a.face === currentFace ? 1.25 : 0.9);
    this.camera.quaternion.copy(view);
    this.camera.position.set(0, 0, 4.2).applyQuaternion(view);
    this.camera.updateMatrixWorld();
    const size = 140;
    const full = renderer.getSize(this.tmp);
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.setScissorTest(true);
    renderer.setViewport(20, 10, size, size);
    renderer.setScissor(20, 10, size, size);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, full.x, full.y);
    renderer.autoClear = true;
  }
}
