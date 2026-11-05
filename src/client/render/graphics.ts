import {
  ACESFilmicToneMapping, Color, DirectionalLight, FogExp2, HemisphereLight, PCFShadowMap, PerspectiveCamera,
  PMREMGenerator, Quaternion, Scene, Vector2, Vector3, WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { createSky, HAZE } from './sky';

/** Sun direction in the local player's gravity frame (each team sees "its" sun). */
const SUN_LOCAL = new Vector3(0.42, 0.78, 0.46).normalize();

/** Renderer, scene, camera, sky, lights and post-processing. */
export class Graphics {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.05, 3000);
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  /** World-space sun / up of the local player's render frame. Updated by `updateLighting`. */
  readonly sunDir = new Vector3();
  readonly upDir = new Vector3();
  private readonly sky: ReturnType<typeof createSky>;
  private readonly hemi = new HemisphereLight(0xfff1dc, 0x8a7a62, 0.55);
  private readonly sun = new DirectionalLight(0xffeccc, 2.6);
  private readonly fill = new DirectionalLight(0xc8d6ff, 0.5);

  constructor(canvas: HTMLCanvasElement) {
    const renderer = (this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' }));
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;

    const scene = this.scene;
    scene.background = new Color(HAZE);
    scene.fog = new FogExp2(HAZE, 0.0019);

    this.sky = createSky();
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
    scene.add(this.sky.sky);
    scene.add(this.hemi);

    const sun = this.sun;
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
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
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.composer.setSize(window.innerWidth, window.innerHeight);
  }

  /** Sky follows the camera; sun and sky live in the player's (eased) gravity frame. */
  updateLighting(renderFrame: Quaternion) {
    const { camera, sunDir, upDir, sun } = this;
    this.sky.sky.position.copy(camera.position);
    sunDir.copy(SUN_LOCAL).applyQuaternion(renderFrame);
    upDir.set(0, 1, 0).applyQuaternion(renderFrame);
    this.sky.uniforms.sunDir.value.copy(sunDir);
    this.sky.uniforms.upDir.value.copy(upDir);
    this.hemi.position.copy(upDir);
    sun.target.position.copy(camera.position).addScaledVector(upDir, -10);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 200);
    this.fill.position.copy(sunDir).negate().addScaledVector(upDir, 0.6);
  }

  render(dt: number) {
    this.composer.render(dt);
  }
}
