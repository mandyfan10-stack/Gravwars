import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';

/** Warm air inside the cube (fog colour). */
export const HAZE = 0xcdbd96;

/**
 * Warm hazy dome: only used to light the scene (image-based lighting), the visible sky is `createSpace`.
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
      void main() {
        vec3 d = normalize(vDir);
        float s = max(dot(d, sunDir), 0.0);
        float h = dot(d, upDir);
        vec3 col = mix(haze, haze * vec3(0.86, 0.95, 1.08), smoothstep(0.1, 0.9, h));
        col += vec3(1.0, 0.82, 0.55) * (pow(s, 6.0) * 0.35 + pow(s, 64.0) * 0.8) * sunStrength;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new Mesh(new SphereGeometry(900, 32, 16), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return { sky, uniforms: mat.uniforms };
}

/**
 * Outer space around the cube, seen through the gaps at its edges: deep blue-black, a faint nebula, stars that
 * twinkle. Fixed to the world (it is the only thing that tells the faces apart from afar).
 */
export function createSpace() {
  const mat = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { time: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float time;
      varying vec3 vDir;
      float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
      float noise(vec3 x) {
        vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
                   mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
      }
      float fbm(vec3 p) { float v = 0.0; float a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.07; a *= 0.5; } return v; }
      float stars(vec3 d, float scale, float density) {
        vec3 p = d * scale;
        vec3 c = floor(p);
        float h = hash(c);
        if (h > density) return 0.0;
        vec3 o = vec3(hash(c + 1.7), hash(c + 3.1), hash(c + 5.3)) * 0.6 + 0.2;
        float r = length(fract(p) - o);
        float tw = 0.75 + 0.25 * sin(time * (1.0 + h * 40.0) + h * 100.0);
        return smoothstep(0.09, 0.0, r) * tw;
      }
      void main() {
        vec3 d = normalize(vDir);
        vec3 col = mix(vec3(0.010, 0.014, 0.030), vec3(0.030, 0.035, 0.070), fbm(d * 2.0) );
        float neb = fbm(d * 3.0 + vec3(4.0, 1.0, 7.0));
        float neb2 = fbm(d * 5.0 - vec3(2.0, 6.0, 1.0));
        col += vec3(0.22, 0.08, 0.30) * smoothstep(0.5, 0.85, neb) * 0.35;
        col += vec3(0.05, 0.20, 0.28) * smoothstep(0.55, 0.9, neb2) * 0.3;
        col += vec3(1.0, 0.97, 0.9) * stars(d, 180.0, 0.05) * 1.6;
        col += vec3(0.8, 0.88, 1.0) * stars(d, 420.0, 0.06) * 0.8;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const space = new Mesh(new SphereGeometry(1000, 48, 24), mat);
  space.frustumCulled = false;
  space.renderOrder = -1;
  return { space, uniforms: mat.uniforms };
}
