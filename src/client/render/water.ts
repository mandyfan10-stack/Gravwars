import { Color, MeshPhysicalMaterial } from 'three';
import { HAZE } from './sky';

/**
 * Water for ponds and fountains: a dark, clear body that shows the bottom a little, small wind ripples running over
 * it (a procedural height field in world space, so any face of any mesh works, instanced or not), sky reflections
 * that grow towards grazing angles (the physical material's Fresnel), sun glints on the ripples and lighter crests.
 * Call `update(time)` every frame.
 */
export function waterMaterial() {
  const uniforms = { uTime: { value: 0 } };
  const deep = new Color(0x123e44), shallow = new Color(0x2f8a8a), horizon = new Color(HAZE), zenith = new Color(0x9db3c2);
  const mat = new MeshPhysicalMaterial({
    color: deep, roughness: 0.08, metalness: 0, envMapIntensity: 0, ior: 1.333, specularIntensity: 1,
    transparent: true, opacity: 0.9,
  });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms, { uDeep: { value: deep }, uShallow: { value: shallow }, uHorizon: { value: horizon }, uZenith: { value: zenith } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nvarying vec3 vWN;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        {
          vec4 wp = vec4(transformed, 1.0);
          vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
            wn = mat3(instanceMatrix) * wn;
          #endif
          vWPos = (modelMatrix * wp).xyz;
          vWN = normalize(mat3(modelMatrix) * wn);
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying vec3 vWN;
        uniform float uTime; uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uHorizon; uniform vec3 uZenith;
        vec3 wRN;
        // ripples: wind-driven wave trains in many directions (Gerstner-like sum), returned as (height, d/dx, d/dy)
        vec3 wWave(vec2 p, vec2 d, float k, float a, float w, float t) {
          float ph = dot(p, d) * k + t * w;
          return vec3(sin(ph) * a, d * cos(ph) * a * k);
        }
        vec3 wHeight(vec2 p, float t) {
          vec3 h = vec3(0.0);
          h += wWave(p, normalize(vec2(0.83, 0.55)), 2.1, 0.018, 1.5, t);
          h += wWave(p, normalize(vec2(-0.62, 0.78)), 3.3, 0.014, 2.0, t);
          h += wWave(p, normalize(vec2(0.21, -0.98)), 5.2, 0.020, 2.6, t);
          h += wWave(p, normalize(vec2(-0.93, -0.37)), 7.9, 0.012, 3.3, t);
          h += wWave(p, normalize(vec2(0.47, 0.88)), 11.3, 0.008, 4.1, t);
          h += wWave(p, normalize(vec2(0.99, -0.12)), 16.7, 0.005, 5.0, t);
          h += wWave(p, normalize(vec2(-0.30, 0.95)), 23.1, 0.0035, 6.2, t);
          return h;
        }`)
      // the instance / vertex colours of the map boxes are ignored: the water has its own colour
      .replace('#include <color_fragment>', `
        vec3 wN = normalize(vWN);
        vec3 wT = normalize(abs(wN.y) < 0.9 ? cross(wN, vec3(0.0, 1.0, 0.0)) : cross(wN, vec3(1.0, 0.0, 0.0)));
        vec3 wB = cross(wN, wT);
        vec2 wp = vec2(dot(vWPos, wT), dot(vWPos, wB));
        vec3 wH = wHeight(wp, uTime);
        vec2 wGrad = wH.yz * 0.5;
        // crests a touch lighter (light through the thin wave tops)
        diffuseColor.rgb = mix(uDeep, uShallow, clamp(wH.x * 1.5 + 0.35, 0.0, 1.0));`)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>
        {
          wRN = normalize(wN - (wT * wGrad.x + wB * wGrad.y));
          normal = normalize((viewMatrix * vec4(wRN, 0.0)).xyz);
        }`);
  };
  // a clean sky reflection (the scene's environment map carries the cloud noise of the sky dome, which on a flat
  // mirror reads as dirt): haze at the horizon, a cooler sky above, weighted by Fresnel
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', `
      {
        vec3 V = normalize(vWPos - cameraPosition);
        vec3 R = reflect(V, wRN);
        float up = clamp(dot(R, wN), 0.0, 1.0);
        vec3 sky = mix(uHorizon, uZenith, pow(up, 0.6)) * 0.85;
        float F = 0.02 + 0.98 * pow(1.0 - clamp(dot(-V, wRN), 0.0, 1.0), 5.0);
        outgoingLight = mix(outgoingLight, sky, clamp(F * 1.4 + 0.035, 0.0, 1.0));
      }
      #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => 'water-v3';
  const update = (time: number) => { uniforms.uTime.value = time; };
  mat.userData.update = update;
  return { material: mat, update };
}
