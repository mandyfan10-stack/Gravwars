import { BoxGeometry, CylinderGeometry, Group, Mesh, MeshBasicMaterial, MeshLambertMaterial, PerspectiveCamera, Quaternion, Scene, Vector3 } from 'three';
import { upOf } from '../../shared/math';
import { NPC, Npc, NpcCar, NpcManager } from '../../shared/npcs';
import type { GameAssets } from './assets';
import { bottleMeshes } from './pickupView';
import { PlayerModel } from './playerModel';

/** Bums: worn brown coat, dirt; gangs: dark clothes with a deep purple accent. */
const LOOK = { bum: { color: 0x6a5a44, grime: 0.85 }, gang: { color: 0x4b2a5c, grime: 0 } };
const CORPSE_TIME = 1.4;
/** Indicators (? / !) only for NPCs this close. */
const MARK_RANGE = 40;
/** Marker height over the character's centre, m. */
const MARK_HEIGHT = 1.15;
const _p = new Vector3();
const _up = new Vector3();
const _d = new Vector3();

interface View {
  npc: Npc;
  model: PlayerModel;
  bottle: Group | null;
  hp: number;
  shots: number;
  throws: number;
  /** After a throw: the swing plays out before the pistol comes back. */
  throwT: number;
  corpseT: number;
  lastPos: Vector3;
  lastFrame: Quaternion;
  lastYaw: number;
  mark: HTMLElement;
}

interface CarView {
  car: NpcCar;
  group: Group;
  bodyMat: MeshLambertMaterial;
  wheels: Mesh[];
  color: number;
}

const _carYawQ = new Quaternion();
const _yAxis = new Vector3(0, 1, 0);

function buildCarGroup(color: number): { group: Group; bodyMat: MeshLambertMaterial; wheels: Mesh[] } {
  const g = new Group();
  const bodyMat = new MeshLambertMaterial({ color });
  const darkMat = new MeshLambertMaterial({ color: 0x22262b });
  const glassMat = new MeshLambertMaterial({ color: 0x7ba5b8 });
  const headMat = new MeshBasicMaterial({ color: 0xfff3b8 });
  const tailMat = new MeshBasicMaterial({ color: 0xff4433 });

  const chassis = new Mesh(new BoxGeometry(1.7, 0.55, 3.4), bodyMat);
  chassis.position.y = -0.35;
  g.add(chassis);

  const cabin = new Mesh(new BoxGeometry(1.48, 0.5, 1.75), bodyMat);
  cabin.position.set(0, 0.14, 0.15);
  g.add(cabin);

  const glass = new Mesh(new BoxGeometry(1.52, 0.36, 1.55), glassMat);
  glass.position.set(0, 0.15, 0.15);
  g.add(glass);

  const bumperF = new Mesh(new BoxGeometry(1.76, 0.22, 0.2), darkMat);
  bumperF.position.set(0, -0.48, -1.7);
  g.add(bumperF);

  const bumperB = new Mesh(new BoxGeometry(1.76, 0.22, 0.2), darkMat);
  bumperB.position.set(0, -0.48, 1.7);
  g.add(bumperB);

  for (const sx of [-0.58, 0.58]) {
    const hl = new Mesh(new BoxGeometry(0.28, 0.16, 0.08), headMat);
    hl.position.set(sx, -0.28, -1.71);
    g.add(hl);
    const tl = new Mesh(new BoxGeometry(0.28, 0.16, 0.08), tailMat);
    tl.position.set(sx, -0.28, 1.71);
    g.add(tl);
  }

  const wheelGeo = new CylinderGeometry(0.34, 0.34, 0.26, 12);
  wheelGeo.rotateZ(Math.PI / 2);
  const wheels: Mesh[] = [];
  for (const [wx, wz] of [[-0.82, -1.05], [0.82, -1.05], [-0.82, 1.05], [0.82, 1.05]]) {
    const w = new Mesh(wheelGeo, darkMat);
    w.position.set(wx, -0.6, wz);
    g.add(w);
    wheels.push(w);
  }
  return { group: g, bodyMat, wheels };
}

/**
 * City NPCs in street clothes (bums: a worn coat, beanie and beard, a bottle while drinking; gang: hoodie, jeans, a
 * pistol) and NPC cars driving around the islands. Over NPC heads: "?" while they are getting suspicious of you, "!" once they come for you.
 */
export class NpcView {
  private readonly views: View[];
  private readonly carViews: CarView[];

  constructor(scene: Scene, private npcs: NpcManager, assets: GameAssets, private playerId = 0) {
    const layer = document.getElementById('markers')!;
    this.views = npcs.npcs.map((npc) => {
      const look = LOOK[npc.kind];
      const model = new PlayerModel(assets, look.color, npc.kind === 'gang' ? 'pistol' : 'fists', look.grime, npc.kind);
      let bottle: Group | null = null;
      if (npc.kind === 'bum') {
        bottle = bottleMeshes();
        // in the right hand, neck up
        bottle.scale.setScalar(1.2);
        bottle.rotation.z = -Math.PI / 2;
        bottle.position.set(0, -0.12, 0.03);
        bottle.visible = false;
        model.bone('handR').add(bottle);
      }
      scene.add(model.group);
      const mark = document.createElement('div');
      mark.className = 'npc-mark';
      layer.append(mark);
      return { npc, model, bottle, hp: npc.target.hp, shots: 0, throws: 0, throwT: 0, corpseT: 0, lastPos: new Vector3(), lastFrame: new Quaternion(), lastYaw: 0, mark };
    });
    this.carViews = npcs.cars.map((car) => {
      const { group, bodyMat, wheels } = buildCarGroup(car.color);
      scene.add(group);
      return { car, group, bodyMat, wheels, color: car.color };
    });
  }

  update(dt: number, alpha: number, camera: PerspectiveCamera) {
    for (const cv of this.carViews) {
      const car = cv.car;
      if (car.state === 'dead') {
        cv.group.visible = false;
        continue;
      }
      cv.group.visible = true;
      if (cv.color !== car.color) {
        cv.color = car.color;
        cv.bodyMat.color.setHex(car.color);
      }
      if (car.state === 'crashing') {
        cv.bodyMat.emissive.setHex(Math.floor(car.crashT * 16) % 2 === 0 ? 0x661a08 : 0x220500);
      } else {
        cv.bodyMat.emissive.setHex(0x000000);
      }
      if (car.prevPos.distanceToSquared(car.pos) > 36) _p.copy(car.pos);
      else _p.lerpVectors(car.prevPos, car.pos, alpha);
      cv.group.position.copy(_p).addScaledVector(car.up, (car.scale - 1) * 0.6);
      cv.group.scale.setScalar(car.scale);
      _carYawQ.setFromAxisAngle(_yAxis, car.yaw);
      cv.group.quaternion.copy(car.quat).multiply(_carYawQ);
      const spin = car.vel.length() * dt * 2.5;
      for (const w of cv.wheels) w.rotation.x -= spin;
    }

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
      let fired = n.shotsTotal !== v.shots;
      v.shots = n.shotsTotal;
      // gang: the pistol up with a growing glint while winding up a burst; a grenade in hand before a throw
      if (n.kind === 'gang') {
        const threw = n.throwsTotal !== v.throws;
        v.throws = n.throwsTotal;
        if (threw) { v.throwT = 0.5; fired = true; m.release(); }
        v.throwT = Math.max(0, v.throwT - dt);
        const nade = (n.fire === 'windup' && n.throwing) || v.throwT > 0;
        if (nade && m.held !== 'grenade') m.setHeld('grenade');
        else if (!nade && m.held !== 'pistol') m.setHeld('pistol');
        const winding = n.fire === 'windup' && !n.throwing;
        const meleeSpark = n.fire === 'meleeWindup';
        m.setGlint(meleeSpark ? 1 : winding ? 1 - n.windT / NPC.gang.windup : n.fire === 'burst' ? 1 : 0);
      }
      if (v.bottle) v.bottle.visible = n.state === 'drink';
      m.update(dt, { speed: Math.sqrt(Math.max(0, s.vel.lengthSq() - vUp * vUp)), grounded: s.onGround, vUp, fired });

      // suspicion marker over the head; dazed (bottle): a spinning ring of dots instead
      const a = this.npcs.awareness(n, this.playerId);
      const stun = (n.target.stun ?? 0) > 0;
      const dist = _d.copy(_p).sub(camera.position).length();
      _d.copy(_p).addScaledVector(_up, MARK_HEIGHT).project(camera);
      if ((a < 0.08 && !stun) || dist > MARK_RANGE || _d.z > 1) { v.mark.style.display = 'none'; continue; }
      const hostile = n.foe?.id === this.playerId;
      // winding up at you: the "!" turns into a pulsing red warning (a burst or a grenade is coming)
      const aiming = hostile && n.fire !== 'free';
      v.mark.style.display = '';
      v.mark.textContent = stun ? '' : hostile ? '!' : '?';
      v.mark.className = `npc-mark${stun ? ' stun' : aiming ? ' hostile aim' : hostile ? ' hostile' : ''}`;
      v.mark.style.opacity = hostile || stun ? '1' : String(0.35 + a * 0.65);
      v.mark.style.setProperty('--fill', `${Math.round(a * 100)}%`);
      v.mark.style.transform = `translate(${((_d.x * 0.5 + 0.5) * w).toFixed(1)}px, ${((-_d.y * 0.5 + 0.5) * h).toFixed(1)}px)`;
    }
  }
}
