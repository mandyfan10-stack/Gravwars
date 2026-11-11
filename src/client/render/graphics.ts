import {
  ACESFilmicToneMapping, Camera, Color, DirectionalLight, FogExp2, HemisphereLight, NearestFilter, PCFShadowMap, PerspectiveCamera,
  PMREMGenerator, Quaternion, Scene, ShaderMaterial, Vector2, Vector3, WebGLRenderer, WebGLRenderTarget,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createSky, createSpace, HAZE } from './sky';
import { createSun } from './sun';

/** Fill light direction in the local player's gravity frame (the sun is always straight above: it is the centre). */
const FILL_LOCAL = new Vector3(-0.55, 0.35, -0.6).normalize();

/**
 * The retro look: how many lines the picture has (0 = full screen resolution) and the colour depth (shades per
 * channel, 0 = full). The frame is rendered that small and blown up by a whole number of screen pixels per
 * pixel, so every pixel is a crisp square of the same size; the HUD stays sharp on top.
 */
export interface RetroLook { lines: number; levels: number }

/** Draws an extra scene (the first-person hands) into the frame after bloom, at the same pixel size. */
class OverlayPass extends Pass {
  scene: Scene | null = null;
  camera: Camera | null = null;
  constructor() {
    super();
    this.needsSwap = false;
  }
  render(renderer: WebGLRenderer, _write: WebGLRenderTarget, read: WebGLRenderTarget) {
    if (!this.scene || !this.camera) return;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(read);
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = auto;
  }
}

/**
 * Last pass: every screen pixel samples the centre of its small-frame pixel (whole-number blow-up, crisp edges),
 * then the colour is cut down to a few shades per channel with 4×4 ordered (Bayer) dithering on the big pixels.
 */
class RetroPass extends Pass {
  readonly uniforms = {
    tDiffuse: { value: null as unknown },
    low: { value: new Vector2(1, 1) },
    scale: { value: 1 },
    levels: { value: 0 },
  };
  private readonly quad = new FullScreenQuad(new ShaderMaterial({
    uniforms: this.uniforms,
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform vec2 low; uniform float scale; uniform float levels;
      varying vec2 vUv;
      float bayer2(vec2 a) { a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
      float bayer4(vec2 a) { return bayer2(0.5 * a) * 0.25 + bayer2(a); }
      void main() {
        vec2 px = floor(gl_FragCoord.xy / scale);
        vec3 c = texture2D(tDiffuse, (px + 0.5) / low).rgb;
        if (levels > 0.0) {
          float n = levels - 1.0;
          c = floor(clamp(c, 0.0, 1.0) * n + bayer4(px)) / n;
        }
        gl_FragColor = vec4(c, 1.0);
      }`,
    depthTest: false,
    depthWrite: false,
  }));
  render(renderer: WebGLRenderer, write: WebGLRenderTarget, read: WebGLRenderTarget) {
    this.uniforms.tDiffuse.value = read.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : write);
    this.quad.render(renderer);
  }
}

/** Renderer, scene, camera, sky, lights and post-processing. */
export class Graphics {
  readonly renderer: WebGLRenderer;
  readonly isSoftwareGl: boolean;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.1, 1500);
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  /** The first-person hands: drawn into the small frame too (same pixels, same palette). */
  readonly overlay = new OverlayPass();
  private readonly retro = new RetroPass();
  private look: RetroLook = { lines: 0, levels: 0 };
  /** World-space sun / up of the local player's render frame. Updated by `updateLighting`. */
  readonly sunDir = new Vector3();
  readonly upDir = new Vector3();
  private readonly space: ReturnType<typeof createSpace>;
  private readonly sunView: ReturnType<typeof createSun>;
  private readonly hemi = new HemisphereLight(0xfff0d4, 0x9b8665, 0.65);
  private readonly sun = new DirectionalLight(0xffe6b8, 2.65);
  private readonly fill = new DirectionalLight(0xebd8b5, 0.75);

  constructor(canvas: HTMLCanvasElement) {
    // the 3D frame is drawn off-screen (no MSAA there: crisp pixels); the canvas itself only gets the blow-up + HUD gizmo
    const renderer = (this.renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' }));
    const gl = renderer.getContext();
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const glRenderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    this.isSoftwareGl = /SwiftShader|llvmpipe|Software|Mesa OffScreen/i.test(glRenderer);

    renderer.setPixelRatio(this.isSoftwareGl ? 1 : window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = !this.isSoftwareGl;
    renderer.shadowMap.type = PCFShadowMap;

    const scene = this.scene;
    scene.background = new Color(HAZE);
    // warm golden air inside the cube: far faces and skybox blend into the warm haze
    scene.fog = new FogExp2(HAZE, 0.0024);

    // image-based lighting from the (sunless) haze dome: soft warm ambient + reflections for glass/water
    {
      const envScene = new Scene();
      const envSky = createSky();
      envSky.uniforms.sunStrength.value = 0.35;
      envScene.add(envSky.sky);
      const pm = new PMREMGenerator(renderer);
      scene.environment = pm.fromScene(envScene, 0, 1, 2000).texture;
      scene.environmentIntensity = 0.55;
      pm.dispose();
    }
    this.space = createSpace();
    scene.add(this.space.space);
    this.sunView = createSun();
    scene.add(this.sunView.group);
    scene.add(this.hemi);

    const sun = this.sun;
    sun.castShadow = !this.isSoftwareGl;
    sun.shadow.mapSize.set(this.isSoftwareGl ? 512 : 2048, this.isSoftwareGl ? 512 : 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -70;
    sc.right = sc.top = 70;
    sc.near = 1;
    sc.far = 400;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target, this.fill);

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(window.innerWidth, window.innerHeight), 0.22, 0.4, 0.92);
    if (this.isSoftwareGl) this.bloom.enabled = false;
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.overlay);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.retro);
    for (const t of [this.composer.renderTarget1, this.composer.renderTarget2]) t.texture.minFilter = t.texture.magFilter = NearestFilter;
    this.composer.setPixelRatio(1);
    this.resize();
  }

  /** Pixel size and colour depth (see RetroLook). */
  setLook(look: RetroLook) {
    this.look = { ...look };
    this.retro.uniforms.levels.value = look.levels;
    this.resize();
  }

  /** Screen pixels per frame pixel and the frame size for the current window. */
  frameSize() {
    const dpr = this.isSoftwareGl ? 1 : window.devicePixelRatio;
    const w = Math.floor(window.innerWidth * dpr), h = Math.floor(window.innerHeight * dpr);
    const scale = this.look.lines > 0 ? Math.max(1, Math.round(h / this.look.lines)) : 1;
    return { scale, width: Math.ceil(w / scale), height: Math.ceil(h / scale) };
  }

  /** Sun shadows: off, a 1024 map or a 2048 one. Materials recompile on their own when the count changes. */
  setShadows(q: 'off' | 'low' | 'high') {
    if (this.isSoftwareGl) {
      this.sun.castShadow = false;
      return;
    }
    const sun = this.sun;
    sun.castShadow = q !== 'off';
    const size = q === 'low' ? 1024 : 2048;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    const f = this.frameSize();
    this.composer.setSize(f.width, f.height);
    this.retro.uniforms.low.value.set(f.width, f.height);
    this.retro.uniforms.scale.value = f.scale;
  }

  /**
   * Space follows the camera; the sun sits in the centre of the cube, so its light comes from there towards the
   * player (straight down on every face), the fill and the sky light live in the player's (eased) gravity frame.
   */
  updateLighting(renderFrame: Quaternion, time = 0) {
    const { camera, sunDir, upDir, sun } = this;
    this.space.space.position.copy(camera.position);
    this.space.uniforms.time.value = time;
    this.sunView.update(time, camera);
    upDir.set(0, 1, 0).applyQuaternion(renderFrame);
    sunDir.copy(camera.position).negate();
    if (sunDir.lengthSq() < 1) sunDir.copy(upDir);
    sunDir.normalize();
    this.hemi.position.copy(upDir);
    sun.target.position.copy(camera.position).addScaledVector(upDir, -10);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 200);
    this.fill.position.copy(FILL_LOCAL).applyQuaternion(renderFrame);
  }

  render(dt: number) {
    if (this.isSoftwareGl) this.bloom.enabled = false;
    this.composer.render(dt);
  }

  scheduleFrame(cb: FrameRequestCallback) {
    if (this.isSoftwareGl) {
      setTimeout(() => requestAnimationFrame(cb), 16);
    } else {
      requestAnimationFrame(cb);
    }
  }
}
