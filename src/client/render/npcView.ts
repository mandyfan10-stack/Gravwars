import { Group, Mesh, MeshBasicMaterial, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { upOf } from '../../shared/math';
import type { Npc, NpcManager } from '../../shared/npcs';
import type { GameAssets } from './assets';
import { bottleMeshes } from './pickupView';
import { PlayerModel } from './playerModel';

/** Bums: worn brown coat, dirt; gangs: dark clothes with a deep purple accent. */
const LOOK = { bum: { color: 0x6a5a44, grime: 0.85 }, gang: { color: 0x4b2a5c, grime: 0 } };
const CORPSE_TIME = 1.4;
/** Indicators (? / !) only for NPCs this close. */
const MARK_RANGE = 40;
/** Marker height over the character's centre, m. */
const MARK_HEIGHT = 0.8;
/** Height of the eyes on the head bone; tuned by screenshot. */
const EYE_Y = 0.155;
const _p = new Vector3();
const _up = new Vector3();
const _d = new Vector3();

/** Blank white eyes over the face (head bone space, model units). */
function whiteEyes() {
  const g = new Group();
  const m = new MeshBasicMaterial({ color: 0xf4f1e8 });
  for (const s of [-1, 1]) {
    const e = new Mesh(new RoundedBoxGeometry(0.075, 0.05, 0.012, 1, 0.008), m);
    e.position.set(s * 0.07, EYE_Y, 0.195);
    g.add(e);
  }
  return g;
}

interface View {
  npc: Npc;
  model: PlayerModel;
  bottle: Group | null;
  hp: number;
  shots: number;
  corpseT: number;
  lastPos: Vector3;
  lastFrame: Quaternion;
  lastYaw: number;
  mark: HTMLElement;
}

/**
 * City NPCs: the soldier model in street clothes (bums: dirty, white eyes, a bottle while drinking; gang: dark, a
 * pistol). Over their heads: "?" while they are getting suspicious of you, "!" once they come for you.
 */
export class NpcView {
  private readonly views: View[];

  constructor(scene: Scene, private npcs: NpcManager, assets: GameAssets, private playerId = 0) {
    const layer = document.getElementById('markers')!;
    this.views = npcs.npcs.map((npc) => {
      const look = LOOK[npc.kind];
      const model = new PlayerModel(assets, look.color, npc.kind === 'gang' ? 'pistol' : 'fists', look.grime);
      let bottle: Group | null = null;
      if (npc.kind === 'bum') {
        model.bone('head').add(whiteEyes());
        bottle = bottleMeshes();
        // held up in front of the chest, neck tilted toward the mouth
        bottle.rotation.set(-0.5, 0, -Math.PI / 2, 'XYZ');
        bottle.scale.setScalar(1 / 2.05 * 1.2);
        bottle.position.set(-0.1, 0.14, 0.2);
        bottle.visible = false;
        model.bone('torso').add(bottle);
      }
      scene.add(model.group);
      const mark = document.createElement('div');
      mark.className = 'npc-mark';
      layer.append(mark);
      return { npc, model, bottle, hp: npc.target.hp, shots: 0, corpseT: 0, lastPos: new Vector3(), lastFrame: new Quaternion(), lastYaw: 0, mark };
    });
  }

  update(dt: number, alpha: number, camera: PerspectiveCamera) {
    const w = window.innerWidth, h = window.innerHeight;
    for (const v of this.views) {
      const n = v.npc;
      const m = v.model;
      if (n.state === 'dead' || !n.target.alive) {
        v.mark.style.display = 'none';
        if (v.hp > 0) { v.hp = 0; v.corpseT = CORPSE_TIME; m.hit(); m.die(); }
        v.corpseT -= dt;
        m.group.visible = v.corpseT > 0;
        if (m.group.visible) { m.setPose(v.lastPos, v.lastFrame, v.lastYaw); m.update(dt, null); }
        continue;
      }
      if (v.hp === 0) m.revive();
      if (n.target.hp < v.hp) m.hit();
      v.hp = n.target.hp;
      m.group.visible = true;
      const s = n.sim.state;
      if (n.prevPos.distanceToSquared(s.pos) > 25) _p.copy(s.pos);
      else _p.lerpVectors(n.prevPos, s.pos, alpha);
      m.setPose(_p, s.frame, s.yaw);
      v.lastPos.copy(_p);
      v.lastFrame.copy(s.frame);
      v.lastYaw = s.yaw;
      upOf(s.frame, _up);
      const vUp = s.vel.dot(_up);
      const fired = n.shotsTotal !== v.shots;
      v.shots = n.shotsTotal;
      if (v.bottle) v.bottle.visible = n.state === 'drink';
      m.update(dt, { speed: Math.sqrt(Math.max(0, s.vel.lengthSq() - vUp * vUp)), grounded: s.onGround, vUp, fired });

      // suspicion marker over the head
      const a = this.npcs.awareness(n, this.playerId);
      const dist = _d.copy(_p).sub(camera.position).length();
      _d.copy(_p).addScaledVector(_up, MARK_HEIGHT).project(camera);
      if (a < 0.08 || dist > MARK_RANGE || _d.z > 1) { v.mark.style.display = 'none'; continue; }
      const hostile = n.foe?.id === this.playerId;
      v.mark.style.display = '';
      v.mark.textContent = hostile ? '!' : '?';
      v.mark.className = `npc-mark${hostile ? ' hostile' : ''}`;
      v.mark.style.opacity = hostile ? '1' : String(0.35 + a * 0.65);
      v.mark.style.setProperty('--fill', `${Math.round(a * 100)}%`);
      v.mark.style.transform = `translate(${((_d.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-_d.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
    }
  }
}
