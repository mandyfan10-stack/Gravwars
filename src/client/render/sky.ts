import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, Vector3 } from 'three';

/** Warm golden-amber air inside the world (fog colour matching the Dyson-sphere city skybox). */
export const HAZE = 0xd8c394;

/**
 * Warm hazy dome: used for image-based lighting (IBL), matching the warm golden city skybox.
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
        vec3 col = mix(haze * vec3(1.04, 0.96, 0.84), haze * vec3(0.95, 0.92, 0.82), smoothstep(-0.4, 0.9, h));
        col += vec3(1.0, 0.84, 0.52) * (pow(s, 4.0) * 0.4 + pow(s, 32.0) * 0.85) * sunStrength;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new Mesh(new SphereGeometry(900, 32, 16), mat);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return { sky, uniforms: mat.uniforms };
}

/**
 * Inverted Dyson-sphere / cylindrical city skybox (matching Screenshots 1 & 2):
 * warm golden-amber atmospheric haze, a radiant golden core at the axis, winding turquoise rivers,
 * green parks with tree canopies, sandy-beige roads, and European terracotta-roofed city blocks wrapping
 * around the sky dome.
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

      float hash2(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }

      float noise2(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash2(i);
        float b = hash2(i + vec2(1.0, 0.0));
        float c = hash2(i + vec2(0.0, 1.0));
        float d = hash2(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }

      float fbm2(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 4; i++) {
          v += a * noise2(p);
          p = p * 2.03 + vec2(1.7, 9.2);
          a *= 0.5;
        }
        return v;
      }

      vec3 citySurface(vec2 uv, float depthFade) {
        // Base sandy-beige street/plaza color
        vec3 roadCol = vec3(0.75, 0.68, 0.53);
        vec3 col = roadCol;

        // Winding turquoise river with grassy olive-green banks
        float riverWave = sin(uv.x * 0.55) * 1.35 + cos(uv.x * 0.23 + 1.4) * 0.9;
        float riverDist = abs(uv.y - riverWave);
        float bankMask = 1.0 - smoothstep(0.55, 1.45, riverDist);
        float waterMask = 1.0 - smoothstep(0.28, 0.58, riverDist);
        vec3 grassCol = mix(vec3(0.42, 0.50, 0.21), vec3(0.52, 0.58, 0.27), noise2(uv * 6.0));
        vec3 waterCol = mix(vec3(0.28, 0.68, 0.72), vec3(0.48, 0.84, 0.85), noise2(uv * 8.0 + vec2(time * 0.08, 0.0)));
        col = mix(col, grassCol, bankMask);
        col = mix(col, waterCol, waterMask);

        if (waterMask < 0.5) {
          // City blocks grid
          vec2 grid = uv * vec2(2.6, 2.2);
          vec2 cellId = floor(grid);
          vec2 cellUv = fract(grid);
          float h = hash2(cellId);
          float h2 = hash2(cellId + 19.3);

          // Street borders around each block
          vec2 border = smoothstep(vec2(0.06), vec2(0.11), cellUv) * smoothstep(vec2(0.06), vec2(0.11), 1.0 - cellUv);
          float inBlock = border.x * border.y * (1.0 - smoothstep(0.3, 0.75, bankMask));

          if (inBlock > 0.01) {
            if (h < 0.20) {
              // Green park block with dark-green tree clusters and small cyan pond
              vec3 parkCol = mix(vec3(0.43, 0.51, 0.22), vec3(0.35, 0.44, 0.17), noise2(grid * 4.0));
              float trees = smoothstep(0.45, 0.68, fbm2(grid * 6.5));
              parkCol = mix(parkCol, vec3(0.22, 0.31, 0.10), trees * 0.85);
              if (h2 > 0.55) {
                float pond = 1.0 - smoothstep(0.16, 0.24, length(cellUv - vec2(0.5)));
                parkCol = mix(parkCol, vec3(0.38, 0.76, 0.79), pond);
              }
              col = mix(col, parkCol, inBlock);
            } else {
              // Sub-buildings inside the city block (courtyard perimeter + townhouses)
              vec2 subGrid = cellUv * vec2(3.0, 3.0);
              vec2 subId = floor(subGrid);
              vec2 subUv = fract(subGrid);
              float sh = hash2(cellId * 7.0 + subId);

              // Courtyard opening in the middle of some blocks
              bool isCourtyard = (subId.x == 1.0 && subId.y == 1.0 && h2 > 0.35);
              if (isCourtyard) {
                vec3 yardCol = mix(vec3(0.56, 0.50, 0.38), vec3(0.38, 0.46, 0.20), step(0.5, sh));
                col = mix(col, yardCol, inBlock);
              } else {
                // Facade vs pitched terracotta roof
                float facadeBand = smoothstep(0.58, 0.64, subUv.y);
                // Terracotta roof with tile ridges and gable shadow
                vec3 roofA = vec3(0.77, 0.43, 0.27);
                vec3 roofB = vec3(0.61, 0.32, 0.19);
                float pitch = step(0.5, fract((subUv.x + subUv.y * 0.35) * 2.0));
                float shingles = sin(subUv.x * 42.0) * 0.04 + sin(subUv.y * 36.0) * 0.04;
                vec3 roofCol = mix(roofA, roofB, pitch * 0.65 + sh * 0.25) + shingles;

                // Facade palette (warm cream, olive-green, muted slate-blue, brick-red)
                vec3 wallCol = sh < 0.35 ? vec3(0.76, 0.69, 0.55)
                  : sh < 0.60 ? vec3(0.55, 0.62, 0.45)
                  : sh < 0.80 ? vec3(0.52, 0.61, 0.66)
                  : vec3(0.68, 0.35, 0.27);

                // Window grid on the facade band
                vec2 winUv = fract(subUv * vec2(5.0, 6.0));
                float win = step(0.24, winUv.x) * step(winUv.x, 0.76) * step(0.22, winUv.y) * step(winUv.y, 0.78);
                vec3 winCol = mix(vec3(0.25, 0.28, 0.30), vec3(0.82, 0.85, 0.78), step(0.65, hash2(subId + floor(subUv * 5.0))));
                wallCol = mix(wallCol, winCol, win * 0.75);

                vec3 bldCol = mix(roofCol, wallCol, facadeBand);
                // Subtle shadow between adjacent buildings
                float bldEdge = smoothstep(0.0, 0.06, subUv.x) * smoothstep(0.0, 0.06, subUv.y);
                bldCol *= 0.82 + 0.18 * bldEdge;
                col = mix(col, bldCol, inBlock);
              }
            }
          }
        }
        return col;
      }

      void main() {
        vec3 d = normalize(vDir);
        // Primary tunnel axis for the Dyson-sphere city cylinder
        vec3 axis = normalize(vec3(0.42, 0.78, 0.46));
        vec3 upRef = abs(axis.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 t1 = normalize(cross(upRef, axis));
        vec3 t2 = cross(axis, t1);

        float z = dot(d, axis);
        vec2 xy = vec2(dot(d, t1), dot(d, t2));
        float r = max(0.001, length(xy));
        float angle = atan(xy.y, xy.x);

        // Cylindrical projection into the infinite city tunnel
        float depth = 1.6 / r;
        vec2 cityUv = vec2(angle * 3.82, z * depth * 1.45);
        float depthFade = clamp((depth - 1.5) / 14.0, 0.0, 1.0);

        vec3 city = citySurface(cityUv, depthFade);

        // Soft drifting warm cloud/steam wisps over the city
        float clouds = fbm2(cityUv * 0.45 + vec2(time * 0.015, -time * 0.01));
        vec3 hazeCol = vec3(0.86, 0.77, 0.58);
        city = mix(city, hazeCol, smoothstep(0.42, 0.82, clouds) * 0.32);

        // Distance atmospheric perspective towards the glowing golden core at the ends of the cylinder
        vec3 coreGlow = vec3(1.0, 0.86, 0.48);
        city = mix(city, mix(hazeCol, coreGlow, 0.55), smoothstep(0.0, 1.0, depthFade) * 0.78);

        // Radiant golden-yellow sun core at the vanishing points
        float pole = max(abs(z), 0.0);
        float core = smoothstep(0.84, 0.998, pole);
        float rays = 0.5 + 0.5 * sin(angle * 16.0 + fbm2(vec2(angle * 4.0, time * 0.05)) * 5.0);
        city += vec3(1.0, 0.82, 0.38) * pow(pole, 7.0) * (0.55 + 0.25 * rays);
        city = mix(city, vec3(1.0, 0.97, 0.82), pow(core, 2.2));

        gl_FragColor = vec4(city, 1.0);
      }`,
  });
  const space = new Mesh(new SphereGeometry(1000, 48, 24), mat);
  space.frustumCulled = false;
  space.renderOrder = -1;
  return { space, uniforms: mat.uniforms };
}
