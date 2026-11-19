import {
  Camera, Color, CylinderGeometry, GreaterDepth, Group, Mesh, NormalBlending, OctahedronGeometry, Quaternion, Scene,
  ShaderMaterial, SphereGeometry, Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { OutlineSettings } from '../settings';
import type { BotManager } from '../../shared/bots';
import type { Pickups } from '../../shared/economy';
import type { Match } from '../../shared/match';
import type { NpcManager } from '../../shared/npcs';
import { getTeam, TeamId } from '../../shared/teams';
import type { RemotePlayerSnapshot } from '../../shared/net/protocol';

const _v = new Vector3();
const _q = new Quaternion();
const _qYaw = new Quaternion();
const _yAxis = new Vector3(0, 1, 0);
const _colA = new Color();
const _colB = new Color();

function makeOutlineMaterial(hex: string) {
  return new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(hex) },
      uStrength: { value: 1.0 },
      uMaxDist: { value: 25.0 },
      uFadeStart: { value: 18.0 },
      uTime: { value: 0 },
    },
    vertexShader: `
      varying vec3 vNormalView;
      varying vec3 vViewPos;
      varying float vDist;
      void main() {
        vNormalView = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDist = length(mv.xyz);
        vViewPos = -mv.xyz;
        // Pull silhouette ~0.55 m toward camera so GreaterDepth NEVER self-occludes against the character's own front surface;
        // pixels draw ONLY when a solid wall sits between the camera and the character/object.
        float pull = min(0.55, max(0.0, vDist - 0.35));
        vec3 shifted = mv.xyz + normalize(vViewPos) * pull;
        gl_Position = projectionMatrix * vec4(shifted, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uStrength;
      uniform float uMaxDist;
      uniform float uFadeStart;
      uniform float uTime;
      varying vec3 vNormalView;
      varying vec3 vViewPos;
      varying float vDist;
      void main() {
        if (vDist > uMaxDist) discard;
        vec3 N = normalize(vNormalView);
        vec3 V = normalize(vViewPos);
        float ndv = abs(dot(N, V));
        float rim = pow(clamp(1.0 - ndv, 0.0, 1.0), 1.85);
        float distFade = 1.0 - smoothstep(uFadeStart, uMaxDist, vDist);
        float pulse = 0.94 + 0.06 * sin(uTime * 3.0);
        float alpha = clamp((0.06 + rim * 1.05) * uStrength * distFade * pulse, 0.0, 0.92);
        vec3 col = uColor * (0.88 + rim * 1.15);
        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    depthTest: true,
    depthFunc: GreaterDepth,
    depthWrite: false,
    blending: NormalBlending,
  });
}

function buildCharGeo() {
  const head = new SphereGeometry(0.19, 10, 8).translate(0, 0.66, 0).toNonIndexed();
  const torso = new RoundedBoxGeometry(0.48, 0.76, 0.28, 2, 0.08).translate(0, 0.12, 0).toNonIndexed();
  const legL = new RoundedBoxGeometry(0.19, 0.62, 0.2, 2, 0.04).translate(-0.12, -0.52, 0).toNonIndexed();
  const legR = new RoundedBoxGeometry(0.19, 0.62, 0.2, 2, 0.04).translate(0.12, -0.52, 0).toNonIndexed();
  return mergeGeometries([head, torso, legL, legR]);
}

function buildCrystalGeo() {
  const core = new CylinderGeometry(0.05, 0.72, 2.0, 6, 1).translate(0, 1.0, 0);
  const bot = new CylinderGeometry(0.72, 0.05, 2.0, 6, 1).translate(0, -1.0, 0);
  return mergeGeometries([core, bot]);
}

function buildCarGeo() {
  return new RoundedBoxGeometry(2.1, 1.32, 4.4, 2, 0.18);
}

export interface OutlineContext {
  playerTeam: TeamId;
  spectator: boolean;
  match: Match;
  bots: BotManager;
  npcs: NpcManager;
  pickups: Pickups;
  remotePlayers?: readonly RemotePlayerSnapshot[];
}

/**
 * Renders through-wall X-Ray silhouettes (occluded parts only, using GreaterDepth against the main scene
 * depth buffer) for crystals, teammates, and in spectator mode for all combatants, pickups, NPCs & cars.
 */
export class OutlineSystem {
  readonly scene = new Scene();
  private readonly charGeo = buildCharGeo();
  private readonly crystalGeo = buildCrystalGeo();
  private readonly itemGeo = new OctahedronGeometry(0.36, 0);
  private readonly carGeo = buildCarGeo();

  private readonly matAlly: ShaderMaterial;
  private readonly matEnemy: ShaderMaterial;
  private readonly matItem: ShaderMaterial;
  private readonly matNpc: ShaderMaterial;
  private readonly crystalMats = new Map<string, ShaderMaterial>();

  private readonly poolAlly: Mesh[] = [];
  private readonly poolEnemy: Mesh[] = [];
  private readonly poolItem: Mesh[] = [];
  private readonly poolNpc: Mesh[] = [];
  private readonly poolCar: Mesh[] = [];
  private readonly crystalMeshes = new Map<string, Mesh>();
  private readonly seenCrystals = new Set<string>();
  private readonly holder = new Group();

  constructor(private settings: OutlineSettings) {
    this.matAlly = makeOutlineMaterial(settings.colorAlly);
    this.matEnemy = makeOutlineMaterial(settings.colorEnemy);
    this.matItem = makeOutlineMaterial(settings.colorItem);
    this.matNpc = makeOutlineMaterial(settings.colorNpc);
    this.scene.add(this.holder);
  }

  private borrow(pool: Mesh[], used: number, geo: typeof this.charGeo, mat: ShaderMaterial): Mesh {
    if (used < pool.length) {
      const m = pool[used];
      m.visible = true;
      return m;
    }
    const m = new Mesh(geo, mat);
    m.frustumCulled = false;
    this.holder.add(m);
    pool.push(m);
    return m;
  }

  private hideRest(pool: Mesh[], from: number) {
    for (let i = from; i < pool.length; i++) pool[i].visible = false;
  }

  update(ctx: OutlineContext, camera: Camera, time: number) {
    const s = this.settings;
    if (!s.enabled) {
      this.holder.visible = false;
      return;
    }
    this.holder.visible = true;

    const spec = ctx.spectator;
    const maxDist = spec ? s.specDistance : s.playerDistance;
    const fadeStart = maxDist * 0.72;

    const syncMat = (mat: ShaderMaterial, hex: string, dist: number) => {
      mat.uniforms.uColor.value.set(hex);
      mat.uniforms.uStrength.value = s.strength;
      mat.uniforms.uMaxDist.value = dist;
      mat.uniforms.uFadeStart.value = dist * 0.72;
      mat.uniforms.uTime.value = time;
    };
    syncMat(this.matAlly, s.colorAlly, maxDist);
    syncMat(this.matEnemy, s.colorEnemy, maxDist);
    syncMat(this.matItem, s.colorItem, Math.min(maxDist, 100));
    syncMat(this.matNpc, s.colorNpc, Math.min(maxDist, 110));

    // Crystals: own crystal always shown in normal play if within crystal range (map-wide); all crystals in spectator
    const seenCrystals = this.seenCrystals;
    seenCrystals.clear();
    for (const bed of ctx.match.beds) {
      if (!bed.alive) continue;
      if (!s.showCrystal) continue;
      if (!spec && bed.team !== ctx.playerTeam) continue;
      seenCrystals.add(bed.team);
      let m = this.crystalMeshes.get(bed.team);
      let cMat = this.crystalMats.get(bed.team);
      if (!m || !cMat) {
        cMat = makeOutlineMaterial(s.colorCrystal);
        m = new Mesh(this.crystalGeo, cMat);
        m.frustumCulled = false;
        this.holder.add(m);
        this.crystalMeshes.set(bed.team, m);
        this.crystalMats.set(bed.team, cMat);
      }
      if (spec) _colA.copy(_colB.set(bed.team === ctx.playerTeam ? s.colorCrystal : s.colorEnemy));
      const crysDist = spec ? Math.max(maxDist, 280) : 340;
      if (spec) cMat.uniforms.uColor.value.copy(_colA);
      else cMat.uniforms.uColor.value.set(s.colorCrystal);
      cMat.uniforms.uStrength.value = s.strength * (bed.stage === 2 ? 1.15 : 0.95);
      cMat.uniforms.uMaxDist.value = crysDist;
      cMat.uniforms.uFadeStart.value = crysDist * 0.85;
      cMat.uniforms.uTime.value = time;
      m.position.copy(bed.pos);
      m.quaternion.setFromUnitVectors(_yAxis, bed.up);
      m.visible = true;
    }
    for (const [team, m] of this.crystalMeshes) {
      if (!seenCrystals.has(team)) m.visible = false;
    }

    let allyCount = 0;
    let enemyCount = 0;
    const camPos = camera.position;

    const pushFighter = (pos: Vector3, frame: Quaternion, yaw: number, team: string, alive: boolean) => {
      if (!alive) return;
      if (pos.distanceToSquared(camPos) > maxDist * maxDist) return;
      const isAlly = team === ctx.playerTeam;
      if (!spec && !isAlly) return;
      if (isAlly && !s.showAllies) return;
      if (!isAlly && (!spec || !s.showEnemies)) return;

      const m = isAlly
        ? this.borrow(this.poolAlly, allyCount++, this.charGeo, this.matAlly)
        : this.borrow(this.poolEnemy, enemyCount++, this.charGeo, this.matEnemy);
      m.position.copy(pos);
      m.quaternion.copy(frame).multiply(_qYaw.setFromAxisAngle(_yAxis, yaw));
      m.scale.setScalar(1);
    };

    for (const b of ctx.bots.bots) {
      if (b.out || !b.target.alive) continue;
      pushFighter(b.sim.state.pos, b.sim.state.frame, b.sim.state.yaw, b.team, true);
    }

    if (ctx.remotePlayers) {
      for (const r of ctx.remotePlayers) {
        if (!r.alive) continue;
        _v.set(...r.pos);
        _q.set(...r.frame);
        pushFighter(_v, _q, r.yaw, r.team, true);
      }
    }

    this.hideRest(this.poolAlly, allyCount);
    this.hideRest(this.poolEnemy, enemyCount);

    let itemCount = 0;
    if (spec && s.showItems) {
      const limSq = Math.min(maxDist, 100) ** 2;
      for (const p of ctx.pickups.items) {
        if (!p.alive || p.pos.distanceToSquared(camPos) > limSq) continue;
        const m = this.borrow(this.poolItem, itemCount++, this.itemGeo, this.matItem);
        m.position.copy(p.pos).addScaledVector(p.up, 0.3);
        m.quaternion.setFromUnitVectors(_yAxis, p.up).multiply(_qYaw.setFromAxisAngle(_yAxis, time * 1.4));
      }
    }
    this.hideRest(this.poolItem, itemCount);

    let npcCount = 0;
    if (spec && s.showNpcs) {
      const limSq = Math.min(maxDist, 110) ** 2;
      for (const n of ctx.npcs.npcs) {
        if (!n.target.alive || n.sim.state.pos.distanceToSquared(camPos) > limSq) continue;
        const m = this.borrow(this.poolNpc, npcCount++, this.charGeo, this.matNpc);
        m.position.copy(n.sim.state.pos);
        m.quaternion.copy(n.sim.state.frame).multiply(_qYaw.setFromAxisAngle(_yAxis, n.sim.state.yaw));
      }
    }
    this.hideRest(this.poolNpc, npcCount);

    let carCount = 0;
    if (spec && s.showCars) {
      const limSq = Math.min(maxDist, fadeStart + 35) ** 2;
      for (const c of ctx.npcs.cars) {
        if (c.pos.distanceToSquared(camPos) > limSq) continue;
        const m = this.borrow(this.poolCar, carCount++, this.carGeo, this.matNpc);
        m.position.copy(c.pos).addScaledVector(c.up, 0.72 * c.scale);
        m.quaternion.copy(c.quat).multiply(_qYaw.setFromAxisAngle(_yAxis, c.yaw));
        m.scale.setScalar(c.scale);
      }
    }
    this.hideRest(this.poolCar, carCount);
  }

  /** Free all outline geometries and ShaderMaterials (including pools that were never borrowed). */
  dispose() {
    this.charGeo.dispose();
    this.crystalGeo.dispose();
    this.itemGeo.dispose();
    this.carGeo.dispose();
    this.matAlly.dispose();
    this.matEnemy.dispose();
    this.matItem.dispose();
    this.matNpc.dispose();
    for (const m of this.crystalMats.values()) m.dispose();
    this.crystalMats.clear();
    this.crystalMeshes.clear();
    this.poolAlly.length = 0;
    this.poolEnemy.length = 0;
    this.poolItem.length = 0;
    this.poolNpc.length = 0;
    this.poolCar.length = 0;
    this.holder.clear();
  }
}
