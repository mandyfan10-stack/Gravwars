import {
  AnimationAction, AnimationClip, AnimationMixer, Color, Group, LoopOnce, Mesh, MeshStandardMaterial, Object3D, Quaternion,
  Vector3,
} from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { GameAssets } from './assets';

/** Model units → metres: the Kenney character is 0.84 tall, the player capsule 1.83. */
const SCALE = 2.05;
const FEET = -1.83 / 2;
const AY = new Vector3(0, 1, 0);
/** Palette column (u range) of the uniform's red shades (helmet crest, skirt): they take the team colour. */
const TEAM_U: [number, number] = [0.6875, 0.75];
const ARM_TRACK = /^arm-(left|right)\./;

/** Clip without the arm tracks (legs + body follow locomotion, arms hold the gun). */
function withoutArms(c: AnimationClip) {
  return new AnimationClip(`${c.name}:body`, c.duration, c.tracks.filter((t) => !ARM_TRACK.test(t.name)));
}
function armsOnly(c: AnimationClip) {
  return new AnimationClip(`${c.name}:arms`, c.duration, c.tracks.filter((t) => ARM_TRACK.test(t.name)));
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

/** fists / none: empty hands (punching / standing behind a counter). */
export type HeldItem = 'rifle' | 'pistol' | 'fists' | 'none';

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
 * Animated team character (Kenney "Mini Arena" soldier) holding a blaster. The group sits at the capsule centre
 * and is oriented by the player's gravity frame; the body turns with yaw.
 */
export class PlayerModel {
  readonly group = new Group();
  private readonly body: Object3D;
  private readonly mixer: AnimationMixer;
  private readonly clips = new Map<string, AnimationAction>();
  private readonly materials: MeshStandardMaterial[] = [];
  private current: AnimationAction | null = null;
  private arms!: AnimationAction;
  private armsShoot!: AnimationAction;
  private shootT = 0;
  private flash = 0;
  private dying = false;
  private readonly guns: Record<'rifle' | 'pistol', Object3D>;
  private readonly armClips: Record<'both' | 'free', [AnimationAction, AnimationAction]>;
  /** What the character holds: arm pose + gun model. */
  held: HeldItem = 'rifle';

  constructor(assets: GameAssets, teamColor: number, held: HeldItem = 'rifle', grime = 0) {
    const src = assets.character;
    this.body = SkeletonUtils.clone(src.scene);
    this.body.scale.setScalar(SCALE);
    this.body.position.y = FEET;
    const mats = new Map<MeshStandardMaterial, MeshStandardMaterial>();
    this.body.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material as MeshStandardMaterial;
      if (!mats.has(m)) mats.set(m, teamMaterial(m, teamColor, grime));
      mesh.material = mats.get(m)!;
    });
    this.materials.push(...mats.values());
    this.group.add(this.body);

    // the blaster sits in both hands, barrels forward (character and blaster both face +Z)
    const torso = this.body.getObjectByName('torso')!;
    const rifle = assets.rifle.clone();
    rifle.scale.setScalar(0.22);
    rifle.position.set(-0.06, 0, 0.26);
    const pistol = assets.blaster.clone();
    pistol.scale.setScalar(0.2);
    pistol.position.set(-0.06, 0.02, 0.3);
    torso.add(rifle, pistol);
    this.guns = { rifle, pistol };

    this.mixer = new AnimationMixer(this.body);
    const find = (n: string) => AnimationClip.findByName(src.animations, n)!;
    for (const n of ['idle', 'walk', 'sprint', 'jump', 'fall']) this.clips.set(n, this.mixer.clipAction(withoutArms(find(n))));
    const die = this.mixer.clipAction(find('die'));
    die.setLoop(LoopOnce, 1);
    die.clampWhenFinished = true;
    this.clips.set('die', die);
    const once = (a: AnimationAction) => { a.setLoop(LoopOnce, 1); return a; };
    this.armClips = {
      both: [this.mixer.clipAction(armsOnly(find('holding-both'))), once(this.mixer.clipAction(armsOnly(find('holding-both-shoot'))))],
      // bare hands: natural arm swing, a right hook to punch
      free: [this.mixer.clipAction(armsOnly(find('idle'))), once(this.mixer.clipAction(armsOnly(find('attack-melee-right'))))],
    };
    [this.arms, this.armsShoot] = this.armClips.both;
    this.arms.play();
    this.play('idle', 0);
    this.setHeld(held);
  }

  /** Switch the gun model and the arm pose. */
  setHeld(held: HeldItem) {
    this.guns.rifle.visible = held === 'rifle';
    this.guns.pistol.visible = held === 'pistol';
    const [arms, shoot] = this.armClips[held === 'rifle' || held === 'pistol' ? 'both' : 'free'];
    if (arms !== this.arms) {
      this.arms.stop();
      this.armsShoot.stop();
      this.arms = arms;
      this.armsShoot = shoot;
      if (!this.dying) this.arms.reset().play();
    }
    this.held = held;
  }

  /** Bone to hang accessories on (sunglasses on the head). */
  bone(name: string) {
    return this.body.getObjectByName(name)!;
  }

  private play(name: string, fade = 0.15) {
    const next = this.clips.get(name)!;
    if (next === this.current) return;
    next.reset().play();
    if (this.current) next.crossFadeFrom(this.current, fade, false);
    this.current = next;
  }

  setPose(pos: Vector3, frame: Quaternion, yaw: number) {
    this.group.position.copy(pos);
    this.group.quaternion.copy(frame);
    this.body.quaternion.setFromAxisAngle(AY, yaw + Math.PI);
  }

  /** Brief white flash (took damage). */
  hit() {
    this.flash = 1;
  }

  /** Death animation; `revive()` puts the model back to normal. */
  die() {
    if (this.dying) return;
    this.dying = true;
    this.arms.stop();
    this.armsShoot.stop();
    this.play('die', 0.08);
  }

  revive() {
    if (!this.dying) return;
    this.dying = false;
    this.arms.reset().play();
    this.current?.stop();
    this.current = null;
    this.play('idle', 0);
  }

  update(dt: number, s: ModelState | null) {
    if (s && !this.dying) {
      if (!s.grounded) this.play(s.vUp > 1 ? 'jump' : 'fall');
      else if (s.speed > 5.5) this.play('sprint');
      else if (s.speed > 0.6) this.play('walk');
      else this.play('idle');
      const loco = this.clips.get('walk')!;
      loco.timeScale = Math.max(0.6, s.speed / 3.2);
      if (s.fired) {
        this.armsShoot.reset().play();
        this.shootT = this.held === 'fists' ? 0.45 : 0.2;
      }
    }
    this.shootT = Math.max(0, this.shootT - dt);
    this.arms.weight = this.shootT > 0 ? 0 : 1;
    this.flash = Math.max(0, this.flash - dt * 6);
    for (const m of this.materials) (m.userData.flash as { value: number }).value = this.flash;
    this.mixer.update(dt);
  }
}
