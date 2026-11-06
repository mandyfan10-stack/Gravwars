import { AdditiveBlending, Color, Mesh, MeshBasicMaterial, Quaternion, Scene, SphereGeometry, Vector3 } from 'three';
import type { BotManager } from '../../shared/bots';
import { upOf } from '../../shared/math';
import { getTeam } from '../../shared/teams';
import type { GameAssets } from './assets';
import { PlayerModel } from './playerModel';

const _p = new Vector3();
const _up = new Vector3();
/** How long a dead bot's death animation stays visible, s. */
const CORPSE_TIME = 1.4;

interface View {
  model: PlayerModel;
  hp: number;
  shots: number;
  /** > 0 while showing the death animation where the bot fell. */
  corpseT: number;
  lastPos: Vector3;
  lastFrame: Quaternion;
  lastYaw: number;
  /** Spawn protection shell (visible while the bot is protected). */
  shell: Mesh;
}

const shellGeo = new SphereGeometry(1, 24, 16);

/** Draws bots with the animated character, interpolated between simulation ticks. */
export class BotView {
  private readonly views: View[];

  constructor(scene: Scene, private bots: BotManager, assets: GameAssets) {
    this.views = bots.bots.map((b) => {
      const model = new PlayerModel(assets, getTeam(b.team).color, 'fists');
      scene.add(model.group);
      const shell = new Mesh(shellGeo, new MeshBasicMaterial({
        color: new Color(getTeam(b.team).color).multiplyScalar(0.9), transparent: true, opacity: 0.18, blending: AdditiveBlending, depthWrite: false,
      }));
      shell.scale.set(0.7, 1.12, 0.7);
      shell.visible = false;
      model.group.add(shell);
      return { model, hp: b.target.hp, shots: 0, corpseT: 0, lastPos: new Vector3(), lastFrame: new Quaternion(), lastYaw: 0, shell };
    });
  }

  /** alpha: fraction of the current tick already elapsed (0..1). */
  update(dt: number, alpha: number) {
    this.bots.bots.forEach((b, i) => {
      const v = this.views[i];
      const m = v.model;
      const alive = b.target.alive && !b.out;
      if (!alive) {
        // just died: play the death animation where it happened (the bot itself is parked far away)
        if (v.hp > 0) {
          v.hp = 0;
          v.corpseT = CORPSE_TIME;
          m.hit();
          m.die();
        }
        v.corpseT -= dt;
        m.group.visible = v.corpseT > 0;
        if (m.group.visible) {
          m.setPose(v.lastPos, v.lastFrame, v.lastYaw);
          m.update(dt, null);
        }
        return;
      }
      v.shell.visible = !!b.target.guard;
      if (b.target.guard) (v.shell.material as MeshBasicMaterial).opacity = 0.12 + 0.08 * Math.sin(performance.now() / 160);
      if (v.hp === 0) m.revive();
      if (b.target.hp < v.hp) m.hit();
      v.hp = b.target.hp;
      m.group.visible = true;
      const w = b.weapons.current;
      const held = w === 'rifle' || w === 'pistol' ? w : 'fists';
      if (held !== m.held) m.setHeld(held);
      const s = b.sim.state;
      // big jumps (portal, respawn) are not interpolated
      if (b.prevPos.distanceToSquared(s.pos) > 25) _p.copy(s.pos);
      else _p.lerpVectors(b.prevPos, s.pos, alpha);
      m.setPose(_p, s.frame, s.yaw);
      v.lastPos.copy(_p);
      v.lastFrame.copy(s.frame);
      v.lastYaw = s.yaw;
      upOf(s.frame, _up);
      const vUp = s.vel.dot(_up);
      const fired = b.shotsTotal !== v.shots;
      v.shots = b.shotsTotal;
      m.update(dt, { speed: Math.sqrt(Math.max(0, s.vel.lengthSq() - vUp * vUp)), grounded: s.onGround, vUp, fired });
    });
  }
}
