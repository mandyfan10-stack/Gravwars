import {
  BackSide, Box3, BoxGeometry, Color, Frustum, HalfFloatType, Matrix4, Mesh, PerspectiveCamera, Plane,
  Scene, ShaderMaterial, Vector2, Vector3, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import type { PortalRuntime } from '../../shared/portals';

const vertexShader = /* glsl */ `
  varying vec3 vLocal;
  #include <clipping_planes_pars_vertex>
  void main() {
    vLocal = position;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <clipping_planes_vertex>
  }`;

const fragmentShader = /* glsl */ `
  uniform sampler2D tView;
  uniform vec2 uRes;
  uniform vec3 uColor;
  uniform vec2 uSize;
  uniform float uTime;
  uniform float uActive;
  varying vec3 vLocal;
  #include <clipping_planes_pars_fragment>
  void main() {
    #include <clipping_planes_fragment>
    vec2 suv = gl_FragCoord.xy / uRes;
    vec3 view = texture2D(tView, suv).rgb;
    vec2 e = abs(vLocal.xy) / (uSize * 0.5);
    float edge = max(e.x, e.y);
    float ang = atan(vLocal.y, vLocal.x);
    float swirl = 0.5 + 0.5 * sin(ang * 5.0 + uTime * 3.0 - length(vLocal.xy) * 3.0);
    vec3 idle = uColor * (0.15 + 0.35 * swirl);
    vec3 col = mix(idle, view, uActive);
    col += uColor * smoothstep(0.78, 1.0, edge) * 1.6;
    col += uColor * 0.08 * swirl * uActive;
    gl_FragColor = vec4(col, 1.0);
  }`;

interface Entry {
  portal: PortalRuntime;
  mesh: Mesh;
  mat: ShaderMaterial;
  rt: WebGLRenderTarget | null;
  box: Box3;
}

/**
 * See-through portals: the partner side is rendered from a virtual camera into a texture and
 * sampled in screen space. The portal surface is a thin back-face box, so the image stays
 * correct while the camera passes through the plane. Anything between the virtual camera and
 * the exit plane is clipped. One recursion level (portals inside portals are not drawn).
 */
export class PortalView {
  enabled = true;
  maxPerFrame = 3;
  scale = 0.6;
  private entries: Entry[] = [];
  private vcam = new PerspectiveCamera();
  private frustum = new Frustum();
  private pm = new Matrix4();
  private res = new Vector2();
  private plane = new Plane();
  private tmp = new Vector3();
  private tmp2 = new Vector3();

  constructor(private renderer: WebGLRenderer, private scene: Scene, portals: PortalRuntime[]) {
    this.vcam.matrixAutoUpdate = false;
    this.vcam.matrixWorldAutoUpdate = false;
    for (const portal of portals) {
      const { width, height } = portal.def;
      const mat = new ShaderMaterial({
        vertexShader, fragmentShader, side: BackSide, clipping: true,
        uniforms: {
          tView: { value: null }, uRes: { value: this.res }, uColor: { value: new Color(portal.def.color) },
          uSize: { value: new Vector2(width, height) }, uTime: { value: 0 }, uActive: { value: 0 },
        },
      });
      const mesh = new Mesh(new BoxGeometry(width, height, 0.5), mat);
      mesh.position.copy(portal.pos);
      mesh.quaternion.copy(portal.quat);
      mesh.updateMatrixWorld();
      scene.add(mesh);
      const box = new Box3().setFromObject(mesh);
      this.entries.push({ portal, mesh, mat, rt: null, box });
    }
  }

  render(camera: PerspectiveCamera, time: number) {
    const r = this.renderer;
    r.getDrawingBufferSize(this.res);
    for (const e of this.entries) {
      e.mat.uniforms.uTime.value = time;
      e.mat.uniforms.uActive.value = 0;
    }
    if (!this.enabled) return;

    this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pm);
    const visible = this.entries
      .map((e) => ({ e, d: e.box.distanceToPoint(camera.position) }))
      .filter(({ e, d }) => d < 140 && this.frustum.intersectsBox(e.box))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.maxPerFrame);
    if (!visible.length) return;

    for (const e of this.entries) e.mesh.visible = false;
    const w = Math.max(1, Math.floor(this.res.x * this.scale));
    const h = Math.max(1, Math.floor(this.res.y * this.scale));
    const prevClip = r.clippingPlanes;
    for (const { e, d } of visible) {
      if (!e.rt) e.rt = new WebGLRenderTarget(w, h, { type: HalfFloatType });
      else if (e.rt.width !== w || e.rt.height !== h) e.rt.setSize(w, h);
      // render at reduced resolution when far
      void d;
      const p = e.portal;
      this.vcam.projectionMatrix.copy(camera.projectionMatrix);
      this.vcam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
      this.vcam.matrixWorld.multiplyMatrices(p.toPartner, camera.matrixWorld);
      this.vcam.matrixWorldInverse.copy(this.vcam.matrixWorld).invert();
      // clip everything on the virtual camera's side of the exit plane
      const camPos = this.tmp.setFromMatrixPosition(this.vcam.matrixWorld);
      const n = this.tmp2.copy(p.partner.normal);
      if (n.dot(camPos.sub(p.partner.pos)) > 0) n.negate();
      this.plane.setFromNormalAndCoplanarPoint(n, p.partner.pos);
      this.plane.constant += 0.02;
      r.clippingPlanes = [this.plane];
      r.setRenderTarget(e.rt);
      r.clear();
      r.render(this.scene, this.vcam);
      e.mat.uniforms.tView.value = e.rt.texture;
      e.mat.uniforms.uActive.value = 1;
    }
    r.clippingPlanes = prevClip;
    r.setRenderTarget(null);
    for (const e of this.entries) e.mesh.visible = true;
  }
}