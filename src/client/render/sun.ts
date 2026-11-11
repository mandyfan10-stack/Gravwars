import {
  AdditiveBlending, CanvasTexture, Color, Group, Mesh, ShaderMaterial, SphereGeometry, Sprite, SpriteMaterial, Vector3,
} from 'three';

/** Radius of the sun ball in the middle of the cube, m. */
export const SUN_RADIUS = 9;

function radial(size: number, stops: [number, string][]) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [k, col] of stops) grad.addColorStop(k, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new CanvasTexture(c);
}

/** Soft streaks around the disc (rotated slowly, two layers turning against each other). */
function rays(size: number, n: number, seed: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.translate(size / 2, size / 2);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd() * 0.3;
    const len = size * (0.28 + rnd() * 0.22);
    const w = size * (0.004 + rnd() * 0.01);
    const grad = g.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
    grad.addColorStop(0, 'rgba(255,240,200,0.55)');
    grad.addColorStop(1, 'rgba(255,200,120,0)');
    g.strokeStyle = grad;
    g.lineWidth = w;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    g.stroke();
  }
  return new CanvasTexture(c);
}

/**
 * The sun in the centre of the cube: a churning ball of plasma (bright enough to bloom), a corona and slow rays.
 * It lights every face from straight above (graphics.ts aims the shadow light from it at the player).
 */
export function createSun() {
  const group = new Group();
  group.name = 'sun';
  const ball = new ShaderMaterial({
    fog: false,
    uniforms: { time: { value: 0 }, hot: { value: new Color(3.2, 2.6, 1.6) }, warm: { value: new Color(2.4, 1.2, 0.35) } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vP; varying vec3 vView;
      void main() {
        vN = normalize(normalMatrix * normal);
        vP = position;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform float time; uniform vec3 hot; uniform vec3 warm;
      varying vec3 vN; varying vec3 vP; varying vec3 vView;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float noise(vec3 x) {
        vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.1; a *= 0.5; } return v; }
      void main() {
        vec3 p = normalize(vP) * 3.0;
        float n = fbm(p + vec3(0.0, time * 0.05, time * 0.03));
        float m = fbm(p * 2.3 - vec3(time * 0.04, 0.0, time * 0.06));
        float cells = smoothstep(0.35, 0.75, n * 0.7 + m * 0.5);
        float limb = pow(max(dot(normalize(vN), normalize(vView)), 0.0), 0.45);
        vec3 col = mix(warm, hot, cells) * (0.55 + 0.45 * limb);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sphere = new Mesh(new SphereGeometry(SUN_RADIUS, 48, 24), ball);
  group.add(sphere);

  const glowTex = radial(256, [[0, 'rgba(255,246,215,1)'], [0.16, 'rgba(255,220,135,0.92)'], [0.42, 'rgba(255,182,82,0.45)'], [1, 'rgba(255,150,60,0)']]);
  const haloTex = radial(256, [[0, 'rgba(255,228,165,0.65)'], [0.45, 'rgba(245,198,120,0.22)'], [1, 'rgba(235,180,100,0)']]);
  const sprite = (map: CanvasTexture, scale: number, opacity: number) => {
    const m = new SpriteMaterial({ map, blending: AdditiveBlending, depthWrite: false, transparent: true, opacity, fog: false });
    const s = new Sprite(m);
    s.scale.setScalar(scale);
    group.add(s);
    return s;
  };
  const corona = sprite(glowTex, SUN_RADIUS * 7.5, 0.95);
  const halo = sprite(haloTex, SUN_RADIUS * 28, 0.65);
  const rayA = sprite(rays(512, 46, 7), SUN_RADIUS * 9, 0.6);
  const rayB = sprite(rays(512, 30, 13), SUN_RADIUS * 12, 0.35);
  for (const s of [corona, halo, rayA, rayB]) s.renderOrder = 2;
  sphere.renderOrder = 1;

  const tmp = new Vector3();
  return {
    group,
    update(time: number, camera: { position: Vector3 }) {
      ball.uniforms.time.value = time;
      (rayA.material as SpriteMaterial).rotation = time * 0.02;
      (rayB.material as SpriteMaterial).rotation = -time * 0.013;
      // the corona breathes a little; it fades when you stand close to the ball
      const d = tmp.copy(camera.position).length();
      const pulse = 1 + Math.sin(time * 0.7) * 0.04;
      corona.scale.setScalar(SUN_RADIUS * 6 * pulse);
      (halo.material as SpriteMaterial).opacity = 0.55 * Math.min(1, d / 60);
    },
  };
}
