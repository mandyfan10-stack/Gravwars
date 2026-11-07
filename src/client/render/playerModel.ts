import {
  AdditiveBlending, CanvasTexture, Color, CylinderGeometry, Group, LatheGeometry, Mesh, MeshStandardMaterial, Object3D, Quaternion,
  Sprite, SpriteMaterial, Vector2, Vector3,
} from 'three';
import type { GameAssets } from './assets';
import { pixelGlint } from './pixelart';
import { pistolModel, rifleModel } from './guns';
import { bakeMeshes } from './bake';
import { buildHuman, HumanRig, Outfit, solveArm } from './human';

/** Palette column (u range) of the red shades in the Kenney prop textures (flags, banners): they take the team colour. */
const TEAM_U: [number, number] = [0.6875, 0.75];
const FEET = -1.83 / 2;
const AY = new Vector3(0, 1, 0);

/** A hard little star of light: the glint of a raised gun barrel (shared by every model). */
let glintTex: CanvasTexture | null = null;
const glintTexture = () => (glintTex ??= pixelGlint(15));

/** Hand grenade for the third-person models (metres). */
function grenadeMesh() {
  const g = new Group();
  const body = new Mesh(new LatheGeometry([
    new Vector2(0, -0.05), new Vector2(0.034, -0.046), new Vector2(0.045, -0.02), new Vector2(0.046, 0.015),
    new Vector2(0.036, 0.04), new Vector2(0.018, 0.05), new Vector2(0, 0.05)], 8),
  new MeshStandardMaterial({ color: 0x46592f, roughness: 0.6, flatShading: true }));
  const cap = new Mesh(new CylinderGeometry(0.014, 0.016, 0.022, 6).translate(0, 0.058, 0), new MeshStandardMaterial({ color: 0x55575c, roughness: 0.4, metalness: 0.6 }));
  g.add(body, cap);
  return g;
}

/**
 * Team uniform: recolours the red palette column with the team colour (keeping its shading) and adds a hit flash.
 * `grime` 0..1 makes the whole outfit dull, brownish and dirty (city bums).
 */
export function teamMaterial(src: MeshStandardMaterial, team: number, grime = 0) {
  const m = src.clone();
  m.roughness = 0.75;
  m.metalness = 0;
  m.userData.flash = { value: 0 };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uTeam = { value: new Color(team) };
    sh.uniforms.uFlash = m.userData.flash;
    sh.fragmentShader = sh.fragmentShader
      .replace('void main() {', 'uniform vec3 uTeam; uniform float uFlash;\nvoid main() {')
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float inCol = step(${TEAM_U[0].toFixed(4)}, vMapUv.x) * step(vMapUv.x, ${TEAM_U[1].toFixed(4)});
          float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          diffuseColor.rgb = mix(diffuseColor.rgb, uTeam * clamp(lum / 0.33, 0.45, 1.25), inCol);
          // armour column: a light team tint, readable from afar
          float armour = step(0.5625, vMapUv.x) * step(vMapUv.x, 0.625);
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * mix(vec3(1.0), uTeam * 1.6, 0.45), armour);
          ${grime > 0 ? `{
            float g = dot(diffuseColor.rgb, vec3(0.333));
            vec3 dull = mix(diffuseColor.rgb, vec3(g), 0.55) * vec3(0.78, 0.7, 0.58);
            // blotches from the model position: stains do not swim with the palette
            float n = fract(sin(dot(floor(vMapUv * 37.0), vec2(12.9898, 78.233))) * 43758.5453);
            diffuseColor.rgb = mix(diffuseColor.rgb, dull * (0.8 + 0.25 * n), ${grime.toFixed(2)});
          }` : ''}
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), uFlash * 0.8);
        }`);
  };
  m.customProgramCacheKey = () => `team-uniform-${grime}`;
  m.userData.team = team;
  return m;
}

/** fists / none: empty hands (punching / standing behind a counter); grenade: the right arm up, about to throw. */
export type HeldItem = 'rifle' | 'pistol' | 'fists' | 'none' | 'grenade' | 'rod';
export type { Outfit } from './human';

export interface ModelState {
  /** Planar speed, m/s. */
  speed: number;
  grounded: boolean;
  /** Velocity along the player's up, m/s. */
  vUp: number;
  /** A shot was fired this frame. */
  fired: boolean;
}

/**
 * Level of detail for every character, set by the game each frame: `eye` = camera position. Beyond `far` a person
 * is not drawn and not animated; beyond `shadow` it casts no shadow.
 */
export const CHAR_LOD = { eye: new Vector3(), far: 180, shadow: 45 };

const _t = new Vector3();
const _t2 = new Vector3();
const _p = new Vector3();
const _gq = new Quaternion();
const LEFT = 0, RIGHT = 1;
/** Elbow directions (chest space): out to the side and down. */
const POLE_R = new Vector3(-1, -0.7, -0.3).normalize();
const POLE_L = new Vector3(1, -0.9, -0.2).normalize();
/** Where the guns sit (chest space, metres): rifle butt in the right shoulder, pistol out in both hands. */
const RIFLE_AT = new Vector3(-0.1, 0.22, 0.3);
const PISTOL_AT = new Vector3(-0.03, 0.27, 0.46);
/** Fishing rod: butt in both hands in front of the belly, the rod up and out over the water. */
const ROD_AT = new Vector3(-0.08, -0.12, 0.3);
const ROD_LEN = 1.9;
const ROD_TILT = 0.75; // from straight ahead, upward (rad)
const smooth = (x: number) => x * x * (3 - 2 * x);
const KICK_TIME = 0.45;
/** Shared by every third-person gun and grenade (vertex colours carry the parts' colours). */
let gunMat: MeshStandardMaterial | null = null;
const gunMaterial = () => (gunMat ??= new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.45 }));

/**
 * A person (see human.ts) animated procedurally: walk / run cycle from the speed, jump and fall poses, arms on the
 * gun by IK (both hands on the rifle or the pistol), a punch, an overhand grenade throw, recoil, a fall when killed.
 * The group sits at the capsule centre and is oriented by the player's gravity frame; the body turns with yaw.
 */
export class PlayerModel {
  readonly group = new Group();
  private readonly rig: HumanRig;
  private readonly body = new Group();
  private readonly guns: Record<'rifle' | 'pistol', Object3D>;
  private readonly grenade: Group;
  private readonly rod = new Group();
  /** Tip of the rod (the line hangs from it). */
  readonly rodTip = new Object3D();
  private readonly glint: Sprite;
  private phase = Math.random() * 6;
  /** Smoothed planar speed and air state (poses blend instead of snapping). */
  private speed = 0;
  private air = 0;
  private vUp = 0;
  private recoil = 0;
  private punchT = 0;
  private throwT = 0;
  /** Kick timer, s (counts down from KICK_TIME). */
  private kickT = 0;
  private flash = 0;
  private dying = false;
  private dieT = 0;
  private breath = Math.random() * 6;
  private shadows = true;
  /** What the character holds: arm pose + gun model. */
  held: HeldItem = 'rifle';

  constructor(_assets: GameAssets | null, color: number, held: HeldItem = 'rifle', grime = 0, outfit: Outfit = 'soldier') {
    this.rig = buildHuman(outfit, color, grime);
    this.body.position.y = FEET;
    this.body.add(this.rig.root);
    this.group.add(this.body);
    const chest = this.rig.chest;
    const rifle = rifleModel().root;
    rifle.rotation.y = Math.PI;
    rifle.position.copy(RIFLE_AT);
    const pistol = pistolModel().root;
    pistol.rotation.y = Math.PI;
    pistol.position.copy(PISTOL_AT);
    chest.add(rifle, pistol);
    this.guns = { rifle, pistol };
    // third person: no moving parts, so each gun is one draw call
    for (const g of [rifle, pistol]) bakeMeshes(g, gunMaterial());
    // glint at the pistol muzzle (telegraphs an aimed burst)
    this.glint = new Sprite(new SpriteMaterial({ map: glintTexture(), color: new Color(2.2, 1.9, 1.5), blending: AdditiveBlending,
      depthWrite: false, transparent: true, toneMapped: false }));
    this.glint.position.copy(pistolModel().muzzle).add(new Vector3(0, 0, -0.03));
    this.glint.visible = false;
    pistol.add(this.glint);
    // a grenade in the right hand (wind-up before a throw)
    this.grenade = grenadeMesh();
    bakeMeshes(this.grenade, gunMaterial());
    this.grenade.position.set(0, -0.09, 0.03);
    this.grenade.visible = false;
    this.rig.hand[RIGHT].add(this.grenade);
    // the fishing rod: cork grip, then a thin dark blank (local +Y = along the rod)
    const grip = new Mesh(new CylinderGeometry(0.022, 0.024, 0.34, 6).translate(0, 0.17, 0), new MeshStandardMaterial({ color: 0x9a6b3e, roughness: 0.9 }));
    const blank = new Mesh(new CylinderGeometry(0.005, 0.014, ROD_LEN - 0.34, 5).translate(0, 0.34 + (ROD_LEN - 0.34) / 2, 0),
      new MeshStandardMaterial({ color: 0x23262b, roughness: 0.5, metalness: 0.3 }));
    this.rodTip.position.set(0, ROD_LEN, 0);
    this.rod.add(grip, blank, this.rodTip);
    this.rod.position.copy(ROD_AT);
    this.rod.rotation.x = Math.PI / 2 - ROD_TILT; // +Y tipped forward (+Z), then up by the tilt
    chest.add(this.rod);
    this.setHeld(held);
  }

  /** Switch the gun model and the arm pose. */
  setHeld(held: HeldItem) {
    this.guns.rifle.visible = held === 'rifle';
    this.guns.pistol.visible = held === 'pistol';
    this.grenade.visible = held === 'grenade';
    this.rod.visible = held === 'rod';
    if (held !== this.held) { this.punchT = 0; this.throwT = 0; }
    this.held = held;
  }

  /** Barrel glint 0..1 (0 = hidden): a raised gun about to fire. */
  setGlint(k: number) {
    this.glint.visible = k > 0.01 && this.held === 'pistol';
    this.glint.scale.setScalar(0.12 + k * 0.32);
    (this.glint.material as SpriteMaterial).opacity = Math.min(1, k * 1.4);
  }

  /** The grenade leaves the hand (the swing plays on). */
  release() {
    this.grenade.visible = false;
  }

  /** Attachment points, metres: head (origin at the top of the neck, face +Z), chest, handL / handR (wrist). */
  bone(name: 'head' | 'torso' | 'chest' | 'handL' | 'handR' | string): Object3D {
    const r = this.rig;
    if (name === 'head') return r.head;
    if (name === 'handL') return r.hand[LEFT];
    if (name === 'handR') return r.hand[RIGHT];
    return r.chest;
  }

  setPose(pos: Vector3, frame: Quaternion, yaw: number) {
    this.group.position.copy(pos);
    this.group.quaternion.copy(frame);
    this.body.quaternion.setFromAxisAngle(AY, yaw + Math.PI);
  }

  /** A front kick with the right leg (V). */
  kick() {
    this.kickT = KICK_TIME;
  }

  /** Brief white flash (took damage). */
  hit() {
    this.flash = 1;
  }

  /** Falls over backwards; `revive()` stands it up again. */
  die() {
    if (this.dying) return;
    this.dying = true;
    this.dieT = 0;
  }

  revive() {
    if (!this.dying) return;
    this.dying = false;
    this.rig.fall.rotation.set(0, 0, 0);
    this.rig.fall.position.set(0, 0, 0);
  }

  /** Distance LOD (see CHAR_LOD); false = too far, skip the animation. */
  private lod() {
    const d = this.group.position.distanceTo(CHAR_LOD.eye);
    this.body.visible = d < CHAR_LOD.far;
    const sh = d < CHAR_LOD.shadow;
    if (sh !== this.shadows) {
      this.shadows = sh;
      this.body.traverse((o) => { if ((o as Mesh).isMesh) o.castShadow = sh; });
    }
    return this.body.visible;
  }

  update(dt: number, s: ModelState | null) {
    const r = this.rig;
    if (!this.lod()) {
      // far away: keep the timers going, skip the pose
      if (this.dying) this.dieT += dt;
      return;
    }
    if (s && !this.dying) {
      this.speed += (s.speed - this.speed) * Math.min(1, dt * 10);
      this.air += ((s.grounded ? 0 : 1) - this.air) * Math.min(1, dt * 12);
      this.vUp = s.vUp;
      if (s.fired) {
        if (this.held === 'fists') this.punchT = 0.32;
        else if (this.held === 'grenade') this.throwT = 0.5;
        else this.recoil = 1;
      }
    }
    this.recoil = Math.max(0, this.recoil - dt * 9);
    this.punchT = Math.max(0, this.punchT - dt);
    this.throwT = Math.max(0, this.throwT - dt);
    this.kickT = Math.max(0, this.kickT - dt);
    this.breath += dt;

    // --- legs and body: gait cycle (one cycle = two steps, ~1.5 m walking, longer strides running)
    const v = this.speed;
    const run = smooth(Math.min(1, Math.max(0, (v - 3.5) / 3)));
    const move = Math.min(1, v / 1.2) * (1 - this.air);
    const stride = 1.45 + run * 1.1;
    this.phase += (v / stride) * Math.PI * 2 * dt;
    const ph = this.phase;
    const swing = (0.42 + run * 0.35) * move;
    for (const i of [LEFT, RIGHT]) {
      const p = ph + (i === LEFT ? 0 : Math.PI);
      const fwd = Math.sin(p); // +1: this leg forward
      // knee bends while the leg swings through (moving forward) and a little on landing
      const lift = Math.max(0, Math.cos(p)) * (0.75 + run * 0.7) * move + 0.08 * move;
      let th = -fwd * swing - run * 0.12 * move;
      let kn = lift;
      // airborne: tuck going up, legs loose coming down
      const up = this.vUp > 1 ? 1 : 0;
      th = th * (1 - this.air) + this.air * (up ? (i === LEFT ? -0.75 : -0.25) : (i === LEFT ? -0.35 : 0.15));
      kn = kn * (1 - this.air) + this.air * (up ? (i === LEFT ? 1.1 : 0.6) : 0.35);
      r.thigh[i].rotation.set(th, 0, (i === LEFT ? 1 : -1) * 0.03);
      r.shin[i].rotation.x = kn;
      r.foot[i].rotation.x = -(th + kn) * 0.6 * move + this.air * 0.25;
    }
    // kick: the right knee comes up (chamber), the leg snaps out straight, then back down; the body leans back
    let lean = 0;
    if (this.kickT > 0) {
      const e = 1 - this.kickT / KICK_TIME; // 0 → 1
      const chamber = smooth(Math.min(1, e / 0.3));
      const snap = e < 0.3 ? 0 : e < 0.5 ? smooth((e - 0.3) / 0.2) : 1 - smooth((e - 0.5) / 0.5);
      const out = e < 0.5 ? chamber : 1 - smooth((e - 0.5) / 0.5);
      r.thigh[RIGHT].rotation.x = -1.35 * out - 0.2 * snap;
      r.shin[RIGHT].rotation.x = 1.5 * out * (1 - snap) + 0.05;
      r.foot[RIGHT].rotation.x = -0.3 * snap;
      r.thigh[LEFT].rotation.x = 0.12 * out;
      r.shin[LEFT].rotation.x = 0.2 * out;
      lean = 0.22 * out;
    }
    // pelvis: bob (lowest when the feet pass each other), sway, run crouch
    const bob = (Math.abs(Math.cos(ph)) - 0.6) * (0.035 + run * 0.03) * move;
    r.pelvis.position.y = 0.975 + bob - run * 0.04 * move + Math.sin(this.breath * 1.7) * 0.003;
    r.pelvis.rotation.set(0, Math.sin(ph) * 0.12 * move, Math.sin(ph) * 0.03 * move);
    // chest: counter-twist, lean into a run, breathing
    const aim = this.held === 'rifle' || this.held === 'pistol';
    r.chest.rotation.set(0.06 + run * 0.2 * move + Math.sin(this.breath * 1.7) * 0.012 - lean, -Math.sin(ph) * (aim ? 0.04 : 0.16) * move, 0);
    r.head.rotation.x = -r.chest.rotation.x * 0.7;

    // --- arms
    const [uL, uR] = r.upper, [fL, fR] = r.fore;
    // free swing (opposite to the legs), elbows bent more when running
    const armSwing = (0.35 + run * 0.6) * move;
    const freeArm = (i: number) => {
      const p = ph + (i === LEFT ? Math.PI : 0);
      const side = i === LEFT ? 1 : -1;
      const flail = this.air * (this.vUp > 1 ? 0.5 : 0.9);
      r.upper[i].rotation.set(-Math.sin(p) * armSwing - this.air * 0.2, 0, side * (0.08 + flail));
      r.fore[i].rotation.set(-(0.15 + run * 1.1 * move + Math.max(0, Math.sin(p)) * 0.25 * move), 0, 0);
    };
    freeArm(LEFT);
    freeArm(RIGHT);
    const gunPose = (at: Vector3, rifle: boolean) => {
      // recoil: the gun kicks back and up, the hands follow
      const g = rifle ? this.guns.rifle : this.guns.pistol;
      g.position.copy(at).add(_p.set(0, this.recoil * 0.015, -this.recoil * (rifle ? 0.04 : 0.05)));
      g.rotation.set(-this.recoil * (rifle ? 0.08 : 0.25), Math.PI, 0);
      _gq.copy(g.quaternion);
      // right hand on the grip, left on the handguard / cupping the right
      _t.set(0, -0.035, rifle ? 0.07 : 0.015).applyQuaternion(_gq).add(g.position);
      solveArm(uR, fR, _t, POLE_R);
      _t2.set(rifle ? 0 : 0.03, rifle ? 0.0 : -0.05, rifle ? -0.2 : 0.03).applyQuaternion(_gq).add(g.position);
      solveArm(uL, fL, _t2, POLE_L);
    };
    if (this.held === 'rifle') gunPose(RIFLE_AT, true);
    else if (this.held === 'pistol') gunPose(PISTOL_AT, false);
    else if (this.held === 'fists' && this.punchT > 0) {
      // a straight right: out fast, back slower; the left stays up in guard
      const k = this.punchT > 0.22 ? (0.32 - this.punchT) / 0.1 : this.punchT / 0.22;
      solveArm(uR, fR, _t.set(-0.13, 0.33, 0.12).lerp(_p.set(-0.04, 0.36, 0.62), smooth(k)), POLE_R);
      solveArm(uL, fL, _t2.set(0.11, 0.36, 0.2), POLE_L, 0.8);
      r.chest.rotation.y -= 0.25 * k;
    } else if (this.held === 'grenade') {
      // wound up: right hand back over the shoulder, left arm out toward the target; the throw swings it over
      const k = this.throwT > 0 ? smooth(Math.min(1, (0.5 - this.throwT) / 0.25)) : 0;
      _t.set(-0.26, 0.5, -0.14).lerp(_p.set(-0.08, 0.32, 0.55), k);
      solveArm(uR, fR, _t, POLE_R);
      solveArm(uL, fL, _t2.set(0.2, 0.32, 0.42).lerp(_p.set(0.22, 0.05, 0.05), k), POLE_L);
      r.chest.rotation.y += 0.35 - 0.7 * k;
    } else if (this.held === 'rod') {
      // both hands on the grip, right one lower; a slow bob of the rod tip
      this.rod.rotation.x = Math.PI / 2 - ROD_TILT + Math.sin(this.breath * 1.3) * 0.03;
      _gq.copy(this.rod.quaternion);
      solveArm(uR, fR, _t.set(0, 0.05, 0).applyQuaternion(_gq).add(this.rod.position), POLE_R);
      solveArm(uL, fL, _t2.set(0, 0.3, 0).applyQuaternion(_gq).add(this.rod.position), POLE_L);
    } else if (this.held === 'none') {
      // standing at ease: arms hang a bit forward, hands loosely together in front
      if (move < 0.2) {
        solveArm(uR, fR, _t.set(-0.06, -0.08, 0.17), POLE_R, 0.85);
        solveArm(uL, fL, _t2.set(0.06, -0.08, 0.17), POLE_L, 0.85);
      }
    }
    // the hands follow the forearms; on a gun they turn palm-in
    for (const i of [LEFT, RIGHT]) r.hand[i].rotation.set(0, aim ? (i === LEFT ? 0.6 : -1.2) : 0, 0);

    // --- death: falls backwards about the heels, knees give way first
    if (this.dying) {
      this.dieT += dt;
      const k = Math.min(1, this.dieT / 0.75);
      const fallK = k * k;
      r.fall.rotation.x = -Math.PI / 2 * fallK;
      r.fall.position.set(0, 0.13 * fallK, -0.1 * fallK);
      for (const i of [LEFT, RIGHT]) {
        r.thigh[i].rotation.x = -0.5 * Math.sin(k * Math.PI);
        r.shin[i].rotation.x = 0.9 * Math.sin(k * Math.PI);
        r.upper[i].rotation.set(-0.3 - 1.6 * fallK, 0, (i === LEFT ? 1 : -1) * (0.2 + 0.9 * fallK));
        r.fore[i].rotation.set(-0.3, 0, 0);
      }
    }

    this.flash = Math.max(0, this.flash - dt * 6);
    for (const m of r.materials) m.emissive.setScalar(this.flash * 0.7);
  }
}
