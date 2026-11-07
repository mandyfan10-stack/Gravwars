import {
  AdditiveBlending, BoxGeometry, CanvasTexture, BufferAttribute, BufferGeometry, Color, ConeGeometry, CylinderGeometry, DoubleSide,
  Group, IcosahedronGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshStandardMaterial, NormalBlending, PlaneGeometry,
  PointLight, Points, PointsMaterial, Quaternion, Scene, SphereGeometry, Sprite, SpriteMaterial, Vector3,
} from 'three';
import type { Combat, CombatEvent } from '../../shared/combat';
import { getTeam, TeamId } from '../../shared/teams';
import type { WeaponId } from '../../shared/weapons';

const MAX_TRACERS = 160;
const MAX_SPARKS = 1400;
const MAX_DROPS = 900;
const MAX_SMOKE = 140;
const MAX_SPLATS = 28;
const Z = new Vector3(0, 0, 1);
const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();
const _b = new Vector3();
const _d = new Vector3();
const _v = new Vector3();
const _c = new Color();

interface Blast { mesh: Mesh; ring: Mesh; t: number; radius: number; alive: boolean }
interface Puff { sprite: Sprite; vel: Vector3; t: number; life: number; size: number; alive: boolean }
interface Splat { mesh: Mesh; t: number }

/**
 * Tracer colours: a white-hot core and a coloured glow around it, by gun. Pellets are short and orange, the rifle's
 * long and amber, the pistol's yellow.
 */
const TRACER: Partial<Record<WeaponId, { core: Color; glow: Color; len: number; width: number }>> = {
  pistol: { core: new Color(9, 8, 4.5), glow: new Color(2.6, 2.1, 0.6), len: 3.2, width: 0.035 },
  rifle: { core: new Color(9, 6.5, 3), glow: new Color(3.2, 1.5, 0.35), len: 4.2, width: 0.035 },
  shotgun: { core: new Color(8, 5, 2.2), glow: new Color(3, 1.1, 0.25), len: 1.4, width: 0.03 },
};

/** Soft round dot for particles (plain points are squares). */
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, '#fff');
  grad.addColorStop(0.4, '#ffffffaa');
  grad.addColorStop(1, '#fff0');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new CanvasTexture(c);
}

/** Puff of smoke / mist: a soft blob with a ragged edge. */
function puffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  for (let i = 0; i < 9; i++) {
    const x = 32 + (Math.random() - 0.5) * 18, y = 32 + (Math.random() - 0.5) * 18, r = 12 + Math.random() * 10;
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  return new CanvasTexture(c);
}

/** A blood splat seen from above: a dark blot with droplets thrown out around it. */
function splatTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath();
  for (let i = 0; i <= 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const r = 30 + Math.random() * 14;
    g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r);
  }
  g.fill();
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, d = 38 + Math.random() * 22, r = 1.5 + Math.random() * 4.5;
    g.beginPath();
    g.arc(64 + Math.cos(a) * d, 64 + Math.sin(a) * d, r, 0, Math.PI * 2);
    g.fill();
  }
  return new CanvasTexture(c);
}

/**
 * Tracers, rockets, grenades, explosions, sparks, blood, all driven by combat events. Sparks are additive (they
 * glow); blood and smoke are not.
 */
export class Fx {
  readonly group = new Group();
  private cores: InstancedMesh;
  private glows: InstancedMesh;
  private heads: Points;
  private headPos = new Float32Array(MAX_TRACERS * 3);
  private headCol = new Float32Array(MAX_TRACERS * 3);
  /** Visual offset of a bullet that left the eye: makes it appear from the gun muzzle. */
  private muzzleOffset = new Map<number, { off: Vector3; start: Vector3 }>();
  private grenades = new Map<number, Mesh>();
  private grenadePool: Mesh[] = [];
  private grenadeGeo = new SphereGeometry(0.11, 12, 8);
  private grenadeMat = new MeshStandardMaterial({ color: 0x3d5a2a, roughness: 0.6, metalness: 0.3, emissive: new Color(0, 0, 0) });
  private rockets = new Map<number, Group>();
  private rocketPool: Group[] = [];
  private blasts: Blast[] = [];
  private lights: { light: PointLight; t: number }[] = [];
  private sparks: Points;
  private sPos: Float32Array;
  private sCol: Float32Array;
  private sVel: Float32Array;
  private sLife: Float32Array;
  private sBase: Float32Array;
  private sNext = 0;
  // blood drops: the same scheme as sparks, normal blending
  private drops: Points;
  private dPos: Float32Array;
  private dCol: Float32Array;
  private dVel: Float32Array;
  private dLife: Float32Array;
  private dBase: Float32Array;
  private dNext = 0;
  private puffs: Puff[] = [];
  private puffTex = puffTexture();
  private splats: Splat[] = [];
  private splatNext = 0;
  /** Down direction for cosmetic particles (the local player's gravity). */
  readonly down = new Vector3(0, -1, 0);
  /** Finds the ground under a point along `down` (blood splats land there). Set by the game. */
  ground: (pos: Vector3, down: Vector3) => { pos: Vector3; normal: Vector3 } | null = () => null;

  constructor(scene: Scene) {
    scene.add(this.group);
    const streak = new BoxGeometry(1, 1, 1).translate(0, 0, -0.5);
    const tracerMat = (opacity: number) => new MeshBasicMaterial({ transparent: true, opacity, blending: AdditiveBlending, depthWrite: false, toneMapped: false });
    this.cores = new InstancedMesh(streak, tracerMat(1), MAX_TRACERS);
    this.glows = new InstancedMesh(streak, tracerMat(0.4), MAX_TRACERS);
    for (const im of [this.cores, this.glows]) {
      im.frustumCulled = false;
      im.count = 0;
      im.setColorAt(0, new Color());
      this.group.add(im);
    }
    const headGeo = new BufferGeometry();
    headGeo.setAttribute('position', new BufferAttribute(this.headPos, 3));
    headGeo.setAttribute('color', new BufferAttribute(this.headCol, 3));
    this.heads = new Points(headGeo, new PointsMaterial({
      size: 0.32, map: dotTexture(), vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    this.heads.frustumCulled = false;
    this.group.add(this.heads);

    const geo = new BufferGeometry();
    this.sPos = new Float32Array(MAX_SPARKS * 3);
    this.sCol = new Float32Array(MAX_SPARKS * 3);
    this.sVel = new Float32Array(MAX_SPARKS * 3);
    this.sLife = new Float32Array(MAX_SPARKS);
    this.sBase = new Float32Array(MAX_SPARKS * 4);
    geo.setAttribute('position', new BufferAttribute(this.sPos, 3));
    geo.setAttribute('color', new BufferAttribute(this.sCol, 3));
    this.sparks = new Points(geo, new PointsMaterial({
      size: 0.08, map: dotTexture(), alphaTest: 0.02, vertexColors: true, transparent: true, blending: AdditiveBlending, depthWrite: false,
    }));
    this.sparks.frustumCulled = false;
    this.group.add(this.sparks);

    const dgeo = new BufferGeometry();
    this.dPos = new Float32Array(MAX_DROPS * 3);
    this.dCol = new Float32Array(MAX_DROPS * 3);
    this.dVel = new Float32Array(MAX_DROPS * 3);
    this.dLife = new Float32Array(MAX_DROPS);
    this.dBase = new Float32Array(MAX_DROPS * 2);
    dgeo.setAttribute('position', new BufferAttribute(this.dPos, 3));
    dgeo.setAttribute('color', new BufferAttribute(this.dCol, 3));
    this.drops = new Points(dgeo, new PointsMaterial({ size: 0.11, map: dotTexture(), alphaTest: 0.35, vertexColors: true, transparent: true, depthWrite: false }));
    this.drops.frustumCulled = false;
    this.group.add(this.drops);

    for (let i = 0; i < MAX_SMOKE; i++) {
      const sprite = new Sprite(new SpriteMaterial({ map: this.puffTex, transparent: true, depthWrite: false, opacity: 0 }));
      sprite.visible = false;
      this.group.add(sprite);
      this.puffs.push({ sprite, vel: new Vector3(), t: 0, life: 1, size: 1, alive: false });
    }
    const splatGeo = new PlaneGeometry(1, 1);
    const splatTex = splatTexture();
    for (let i = 0; i < MAX_SPLATS; i++) {
      const mesh = new Mesh(splatGeo, new MeshBasicMaterial({
        map: splatTex, color: new Color(0.32, 0.015, 0.02), transparent: true, depthWrite: false, side: DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      }));
      mesh.visible = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.splats.push({ mesh, t: 0 });
    }

    const blastGeo = new IcosahedronGeometry(1, 2);
    const ringGeo = new SphereGeometry(1, 24, 12);
    for (let i = 0; i < 6; i++) {
      const mesh = new Mesh(blastGeo, new MeshBasicMaterial({ color: new Color(3, 1.25, 0.3), transparent: true, blending: AdditiveBlending, depthWrite: false }));
      const ring = new Mesh(ringGeo, new MeshBasicMaterial({ color: new Color(0.9, 0.75, 0.6), transparent: true, depthWrite: false, opacity: 0.3 }));
      mesh.visible = ring.visible = false;
      this.group.add(mesh, ring);
      this.blasts.push({ mesh, ring, t: 0, radius: 1, alive: false });
    }
    // constant number of lights → no shader recompiles when explosions happen
    for (let i = 0; i < 2; i++) {
      const light = new PointLight(0xffa040, 0, 18, 1.6);
      this.group.add(light);
      this.lights.push({ light, t: 1 });
    }
  }

  spark(pos: Vector3, vel: Vector3, color: Color, life: number) {
    const i = this.sNext;
    this.sNext = (this.sNext + 1) % MAX_SPARKS;
    pos.toArray(this.sPos, i * 3);
    vel.toArray(this.sVel, i * 3);
    this.sLife[i] = life;
    this.sBase[i * 4] = color.r;
    this.sBase[i * 4 + 1] = color.g;
    this.sBase[i * 4 + 2] = color.b;
    this.sBase[i * 4 + 3] = life;
  }

  burst(pos: Vector3, normal: Vector3 | null, n: number, speed: number, color: Color, life = 0.4) {
    for (let k = 0; k < n; k++) {
      _d.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      if (normal) {
        if (_d.dot(normal) < 0) _d.reflect(normal);
        _d.addScaledVector(normal, 0.6).normalize();
      }
      this.spark(pos, _d.multiplyScalar(speed * (0.3 + Math.random() * 0.7)), color, life * (0.5 + Math.random() * 0.5));
    }
  }

  /** Blood drops flying out of `pos` (along `dir` if given, else all round). */
  private bleed(pos: Vector3, dir: Vector3 | null, n: number, speed: number, life = 0.9) {
    for (let k = 0; k < n; k++) {
      const i = this.dNext;
      this.dNext = (this.dNext + 1) % MAX_DROPS;
      _d.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize();
      if (dir) _d.addScaledVector(dir, 1.3).normalize();
      _d.multiplyScalar(speed * (0.25 + Math.random() * 0.75)).addScaledVector(this.down, -speed * 0.25);
      pos.toArray(this.dPos, i * 3);
      _d.toArray(this.dVel, i * 3);
      this.dLife[i] = this.dBase[i * 2 + 1] = life * (0.6 + Math.random() * 0.6);
      this.dBase[i * 2] = 0.22 + Math.random() * 0.26; // red level: dark arterial to brighter
    }
  }

  /** A soft puff (smoke, mist, dust): grows and fades over `life` s. */
  puff(pos: Vector3, vel: Vector3, size: number, life: number, color: Color, opacity = 0.6) {
    const p = this.puffs.find((x) => !x.alive) ?? this.puffs.reduce((a, b) => (a.t / a.life > b.t / b.life ? a : b));
    p.alive = true;
    p.t = 0;
    p.life = life;
    p.size = size;
    p.vel.copy(vel);
    p.sprite.position.copy(pos);
    p.sprite.visible = true;
    const m = p.sprite.material as SpriteMaterial;
    m.color.copy(color);
    m.userData.opacity = opacity;
    m.rotation = Math.random() * Math.PI * 2;
  }

  /** A blood stain on the ground under `pos` (if there is ground within a few metres). */
  private splat(pos: Vector3, size: number) {
    const g = this.ground(pos, this.down);
    if (!g) return;
    const s = this.splats[this.splatNext];
    this.splatNext = (this.splatNext + 1) % MAX_SPLATS;
    s.t = 0;
    s.mesh.visible = true;
    s.mesh.position.copy(g.pos).addScaledVector(g.normal, 0.02);
    s.mesh.quaternion.setFromUnitVectors(Z, g.normal);
    s.mesh.rotateZ(Math.random() * Math.PI * 2);
    s.mesh.scale.setScalar(size);
    (s.mesh.material as MeshBasicMaterial).opacity = 0.92;
  }

  /**
   * A body bursting into blood (`k` = how big: 1 for a fighter, less for a city NPC): a red mist, a spray of drops,
   * a few stains on the ground around.
   */
  blood(pos: Vector3, k = 1) {
    this.bleed(pos, null, Math.round(160 * k), 7 * Math.sqrt(k), 1.1);
    this.bleed(pos, _v.copy(this.down).negate(), Math.round(60 * k), 5, 1.2);
    for (let i = 0; i < Math.round(7 * k); i++) {
      _d.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).multiplyScalar(1.6);
      this.puff(_b.copy(pos).addScaledVector(_d, 0.25), _d, 1.2 + Math.random() * 0.8 * k, 0.7 + Math.random() * 0.4,
        _c.setRGB(0.24, 0.008, 0.012), 0.8);
    }
    this.splat(pos, 2.6 * k + 0.6);
    for (let i = 0; i < Math.round(3 * k); i++) {
      _d.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).multiplyScalar(1.8);
      this.splat(_b.copy(pos).add(_d), 0.6 + Math.random() * 0.9);
    }
  }

  /** Register where the local player's bullets visually start. */
  setMuzzle(projectileId: number, eye: Vector3, muzzle: Vector3) {
    this.muzzleOffset.set(projectileId, { off: muzzle.clone().sub(eye), start: eye.clone() });
  }

  /** People who bleed when hit (players and bots: `true`; NPCs bleed a little less). */
  bleeds: (target: number) => number = () => 1;

  handle(e: CombatEvent) {
    if (e.type === 'impact') {
      // by material: wood splinters, stone grit, metal sparks; the map's concrete gives a puff of dust and a few sparks
      const m = e.material;
      if (m === 'wood') this.burst(e.pos, e.normal, 10, 3, new Color(0.62, 0.42, 0.24), 0.5);
      else if (m === 'metal') this.burst(e.pos, e.normal, 18, 8, new Color(4, 2.8, 1.3), 0.25);
      else {
        this.burst(e.pos, e.normal, 8, 6, new Color(3.4, 2.4, 1.2), 0.22);
        this.burst(e.pos, e.normal, 7, 1.6, m === 'stone' ? new Color(0.62, 0.62, 0.6) : new Color(0.5, 0.47, 0.42), 0.6);
      }
      this.puff(e.pos, _v.copy(e.normal).multiplyScalar(0.6), 0.45, 0.5, _c.setRGB(0.55, 0.52, 0.48), 0.35);
    } else if (e.type === 'ricochet') {
      this.burst(e.pos, e.normal, 14, 9, new Color(4, 3, 1.5), 0.2);
    } else if (e.type === 'fizzle') {
      this.burst(e.pos, null, 14, 3, new Color(2, 0.8, 3.5), 0.5);
    } else if (e.type === 'hit' && e.target !== 0) { // nothing in the local player's own face
      const k = this.bleeds(e.target);
      if (k > 0) this.bleed(e.pos, null, Math.round((e.head ? 26 : 14) * k), e.head ? 4 : 3, 0.6);
      // a city NPC killed: a smaller burst here (fighters burst from the body, see BotView.onDeath)
      if (e.killed && k > 0 && k < 1) this.blood(e.pos, k);
      this.burst(e.pos, null, e.head ? 10 : 5, 3, e.head ? new Color(4, 1.2, 0.6) : new Color(2.4, 0.5, 0.4), 0.25);
    } else if (e.type === 'melee' && e.pos) {
      const kick = e.kind === 'kick';
      // knuckles / a boot on someone: a dust ring and a little blood; on a wall: dust
      this.burst(e.pos, null, kick ? 14 : 8, kick ? 4 : 2.5, new Color(1.6, 1.4, 1.2), 0.3);
      for (let i = 0; i < (kick ? 4 : 2); i++) {
        _d.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(2);
        this.puff(e.pos, _d, kick ? 0.9 : 0.6, 0.45, _c.setRGB(0.75, 0.72, 0.68), 0.4);
      }
    } else if (e.type === 'bounce') {
      this.burst(e.pos, null, 3, 1.5, new Color(1.5, 1.2, 0.8), 0.25);
    } else if (e.type === 'crystal') {
      // shards in the team's colour; a far shot just glances off
      const c = new Color(getTeam(e.team as TeamId).color).multiplyScalar(e.far ? 1.2 : 4);
      this.burst(e.pos, null, e.far ? 6 : 18, e.far ? 2 : 5, c, e.far ? 0.25 : 0.5);
      if (!e.far) this.burst(e.pos, null, 8, 7, new Color(4, 4, 4), 0.2);
    } else if (e.type === 'explode') {
      const b = this.blasts.find((x) => !x.alive) ?? this.blasts[0];
      b.alive = true;
      b.t = 0;
      b.radius = e.radius;
      b.mesh.position.copy(e.pos);
      b.ring.position.copy(e.pos);
      b.mesh.visible = b.ring.visible = true;
      const l = this.lights.reduce((x, y) => (x.t > y.t ? x : y));
      l.t = 0;
      l.light.position.copy(e.pos);
      this.burst(e.pos, null, 80, 14, new Color(5, 2.6, 0.9), 0.7);
      this.burst(e.pos, null, 30, 5, new Color(0.9, 0.8, 0.7), 1.2);
      // a smoke cloud that rolls up from the blast (never into the ground)
      for (let i = 0; i < 9; i++) {
        _d.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).multiplyScalar(e.radius * 0.8);
        const into = _d.dot(this.down);
        if (into > 0) _d.addScaledVector(this.down, -2 * into);
        _d.addScaledVector(this.down, -0.8);
        this.puff(_b.copy(e.pos).addScaledVector(_d, 0.35), _d, e.radius * (0.9 + Math.random() * 0.6), 1.6 + Math.random() * 0.9,
          _c.setRGB(0.34, 0.32, 0.3), 0.75);
      }
    }
  }

  /** A rocket: olive body, warhead, fins and a flame at the back (pooled). */
  private rocketMesh(): Group {
    const g = this.rocketPool.pop();
    if (g) return g;
    const r = new Group();
    const body = new Mesh(new CylinderGeometry(0.045, 0.045, 0.42, 10).rotateX(Math.PI / 2), new MeshStandardMaterial({ color: 0x5c6440, roughness: 0.6 }));
    const nose = new Mesh(new ConeGeometry(0.045, 0.16, 10).rotateX(-Math.PI / 2), new MeshStandardMaterial({ color: 0x3a3d2a, roughness: 0.5 }));
    nose.position.z = -0.29;
    const flame = new Mesh(new ConeGeometry(0.06, 0.5, 8, 1, true).rotateX(Math.PI / 2), new MeshBasicMaterial({
      color: new Color(6, 3, 0.8), transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
    flame.position.z = 0.45;
    const glow = new Sprite(new SpriteMaterial({ map: dotTexture(), color: new Color(5, 2.6, 0.9), blending: AdditiveBlending, depthWrite: false, toneMapped: false }));
    glow.position.z = 0.28;
    glow.scale.setScalar(0.9);
    r.add(body, nose, flame, glow);
    r.userData.last = new Vector3();
    return r;
  }

  update(dt: number, combat: Combat, time: number) {
    let n = 0;
    const live = new Set<number>();
    for (const p of combat.projectiles) {
      if (!p.alive) continue;
      live.add(p.id);
      const look = TRACER[p.weapon];
      if (look) {
        // a glowing streak behind the bullet, a bright head, sparks shed along the way
        if (n >= MAX_TRACERS) continue;
        const mo = this.muzzleOffset.get(p.id);
        _b.copy(p.pos);
        if (mo) {
          const k = Math.max(0, 1 - p.pos.distanceTo(mo.start) / 40);
          _b.addScaledVector(mo.off, k);
        }
        const sp = p.vel.length();
        const len = Math.min(look.len, p.age * sp + 0.25);
        _d.copy(p.vel).divideScalar(sp);
        _q.setFromUnitVectors(Z, _d);
        _m.compose(_b, _q, _s.set(look.width, look.width, len));
        this.cores.setMatrixAt(n, _m);
        this.cores.setColorAt(n, look.core);
        _m.compose(_b, _q, _s.set(look.width * 4, look.width * 4, len * 1.15));
        this.glows.setMatrixAt(n, _m);
        this.glows.setColorAt(n, look.glow);
        _b.toArray(this.headPos, n * 3);
        look.glow.toArray(this.headCol, n * 3);
        if (Math.random() < dt * 30) {
          _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.2).addScaledVector(_d, sp * 0.03);
          this.spark(_b.clone().addScaledVector(_d, -Math.random() * len), _v, look.glow, 0.18);
        }
        n++;
      } else if (p.weapon === 'rocket') {
        let r = this.rockets.get(p.id);
        if (!r) {
          r = this.rocketMesh();
          r.userData.started = false;
          this.group.add(r);
          this.rockets.set(p.id, r);
        }
        // drawn from the launcher's muzzle at first (as bullets are), then on its true path
        const mo = this.muzzleOffset.get(p.id);
        r.position.copy(p.pos);
        if (mo) r.position.addScaledVector(mo.off, Math.max(0, 1 - p.pos.distanceTo(mo.start) / 25));
        _d.copy(p.vel).normalize();
        r.quaternion.setFromUnitVectors(_v.set(0, 0, -1), _d);
        const flame = r.children[2];
        flame.scale.set(1, 1, 0.8 + Math.random() * 0.5);
        // a smoke trail: a puff every ~0.6 m, none in the first metres (it would fill the shooter's view)
        const last = r.userData.last as Vector3;
        if (!r.userData.started) { last.copy(r.position); r.userData.started = true; }
        const from = mo ? mo.start : last;
        while (last.distanceTo(r.position) > 0.6) {
          last.addScaledVector(_s.copy(r.position).sub(last).normalize(), 0.6);
          if (last.distanceTo(from) < 2.5) continue;
          _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.5);
          this.puff(last, _v, 0.6 + Math.random() * 0.3, 1.2 + Math.random() * 0.4, _c.setRGB(0.7, 0.68, 0.66), 0.6);
        }
        this.spark(_b.copy(p.pos).addScaledVector(_d, -0.45), _v.copy(_d).multiplyScalar(-4).add(_s.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5)),
          new Color(5, 2.4, 0.7), 0.25);
      } else {
        let g = this.grenades.get(p.id);
        if (!g) {
          g = this.grenadePool.pop() ?? new Mesh(this.grenadeGeo, this.grenadeMat.clone());
          this.group.add(g);
          this.grenades.set(p.id, g);
        }
        g.position.copy(p.pos);
        g.rotation.x += dt * p.vel.length();
        const blink = Math.sin(p.age * (6 + p.age * 8)) > 0.3 ? 3 : 0;
        (g.material as MeshStandardMaterial).emissive.setRGB(blink, blink * 0.1, 0);
      }
    }
    this.cores.count = this.glows.count = n;
    for (const im of [this.cores, this.glows]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    this.heads.geometry.setDrawRange(0, n);
    this.heads.geometry.attributes.position.needsUpdate = true;
    this.heads.geometry.attributes.color.needsUpdate = true;
    for (const [id, g] of this.grenades) {
      if (live.has(id)) continue;
      this.group.remove(g);
      this.grenadePool.push(g);
      this.grenades.delete(id);
    }
    for (const [id, r] of this.rockets) {
      if (live.has(id)) continue;
      this.group.remove(r);
      this.rocketPool.push(r);
      this.rockets.delete(id);
    }
    for (const id of this.muzzleOffset.keys()) if (!live.has(id)) this.muzzleOffset.delete(id);

    // explosions
    for (const b of this.blasts) {
      if (!b.alive) continue;
      b.t += dt;
      const k = b.t / 0.45;
      if (k >= 1) {
        b.alive = false;
        b.mesh.visible = b.ring.visible = false;
        continue;
      }
      const e = 1 - (1 - k) ** 3;
      b.mesh.scale.setScalar(b.radius * (0.25 + 0.55 * e));
      (b.mesh.material as MeshBasicMaterial).opacity = (1 - k) ** 1.5;
      b.ring.scale.setScalar(b.radius * (0.4 + 0.8 * e));
      (b.ring.material as MeshBasicMaterial).opacity = 0.35 * (1 - k);
    }
    for (const l of this.lights) {
      l.t += dt;
      l.light.intensity = l.t < 0.5 ? 260 * (1 - l.t / 0.5) ** 2 : 0;
    }

    // sparks
    const g = 9;
    for (let i = 0; i < MAX_SPARKS; i++) {
      if (this.sLife[i] <= 0) {
        this.sCol[i * 3] = this.sCol[i * 3 + 1] = this.sCol[i * 3 + 2] = 0;
        continue;
      }
      this.sLife[i] -= dt;
      const j = i * 3;
      this.sVel[j] += this.down.x * g * dt;
      this.sVel[j + 1] += this.down.y * g * dt;
      this.sVel[j + 2] += this.down.z * g * dt;
      const drag = 1 - 2.5 * dt;
      this.sVel[j] *= drag;
      this.sVel[j + 1] *= drag;
      this.sVel[j + 2] *= drag;
      this.sPos[j] += this.sVel[j] * dt;
      this.sPos[j + 1] += this.sVel[j + 1] * dt;
      this.sPos[j + 2] += this.sVel[j + 2] * dt;
      const f = Math.max(0, this.sLife[i] / this.sBase[i * 4 + 3]);
      this.sCol[j] = this.sBase[i * 4] * f;
      this.sCol[j + 1] = this.sBase[i * 4 + 1] * f;
      this.sCol[j + 2] = this.sBase[i * 4 + 2] * f;
    }
    this.sparks.geometry.attributes.position.needsUpdate = true;
    this.sparks.geometry.attributes.color.needsUpdate = true;

    // blood drops: heavier, they fall and darken (hidden by moving far away once dry)
    for (let i = 0; i < MAX_DROPS; i++) {
      const j = i * 3;
      if (this.dLife[i] <= 0) {
        if (this.dPos[j + 1] !== 1e6) { this.dPos[j] = this.dPos[j + 2] = 0; this.dPos[j + 1] = 1e6; }
        continue;
      }
      this.dLife[i] -= dt;
      this.dVel[j] += this.down.x * 16 * dt;
      this.dVel[j + 1] += this.down.y * 16 * dt;
      this.dVel[j + 2] += this.down.z * 16 * dt;
      const drag = 1 - 1.2 * dt;
      for (let a = 0; a < 3; a++) { this.dVel[j + a] *= drag; this.dPos[j + a] += this.dVel[j + a] * dt; }
      const f = Math.max(0, this.dLife[i] / this.dBase[i * 2 + 1]);
      const r = this.dBase[i * 2] * (0.55 + 0.45 * f);
      this.dCol[j] = r;
      this.dCol[j + 1] = r * 0.04;
      this.dCol[j + 2] = r * 0.05;
    }
    this.drops.geometry.attributes.position.needsUpdate = true;
    this.drops.geometry.attributes.color.needsUpdate = true;

    // smoke / mist puffs: drift, slow down, grow, fade
    for (const p of this.puffs) {
      if (!p.alive) continue;
      p.t += dt;
      const k = p.t / p.life;
      if (k >= 1) { p.alive = false; p.sprite.visible = false; continue; }
      p.vel.multiplyScalar(1 - 2 * dt);
      p.sprite.position.addScaledVector(p.vel, dt);
      p.sprite.scale.setScalar(p.size * (0.5 + 0.9 * Math.sqrt(k)));
      const m = p.sprite.material as SpriteMaterial;
      m.opacity = (m.userData.opacity as number) * (1 - k) * Math.min(1, k * 8);
    }
    // stains dry out slowly and fade after half a minute
    for (const s of this.splats) {
      if (!s.mesh.visible) continue;
      s.t += dt;
      if (s.t > 40) { s.mesh.visible = false; continue; }
      if (s.t > 30) (s.mesh.material as MeshBasicMaterial).opacity = 0.92 * (40 - s.t) / 10;
    }
    void time;
    void NormalBlending;
  }
}
