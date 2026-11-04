import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';

export const HAZE = 0xcdbd96;

/**
 * Warm hazy daytime sky. There is no global "up" (six gravities), so the sky is a haze dome lit by a sun
 * whose direction is given in world space and rotates together with the local player's gravity frame.
 */
export function createSky() {
  const mat = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      sunDir: { value: new Vector3(0.4, 0.8, 0.45).normalize() },
      upDir: { value: new Vector3(0, 1, 0) },
      haze: { value: new Color(HAZE) },
      sunStrength: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 sunDir; uniform vec3 upDir; uniform vec3 haze; uniform float sunStrength;
      varying vec3 vDir;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float noise(vec3 x) {
        vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
      void main() {
        vec3 d = normalize(vDir);
        float s = max(dot(d, sunDir), 0.0);
        float h = dot(d, upDir);
        // slightly bluer high above the local horizon, warm haze everywhere else
        vec3 col = mix(haze, haze * vec3(0.86, 0.95, 1.08), smoothstep(0.1, 0.9, h));
        float cl = fbm(d * 3.0 + 2.0);
        col = mix(col, col * 1.08 + vec3(0.03, 0.025, 0.015), smoothstep(0.5, 0.8, cl) * 0.6);
        col += vec3(1.0, 0.82, 0.55) * (pow(s, 6.0) * 0.35 + pow(s, 64.0) * 0.8) * sunStrength;
        col += vec3(1.0, 0.95, 0.85) * smoothstep(0.9993, 0.9997, s) * 6.0 * sunStrength;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new Mesh(new SphereGeometry(1500, 48, 24), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return { sky, uniforms: mat.uniforms };
}
