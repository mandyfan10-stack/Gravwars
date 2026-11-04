import { Quaternion, Scene, Vector3 } from 'three';
import { Combat, MAX_HP, Target } from '../shared/combat';
import { PLAYER_HEIGHT, WORLD } from '../shared/constants';
import type { MapData } from '../shared/map';
import { upOf } from '../shared/math';
import { getTeam, TeamId, TEAMS } from '../shared/teams';
import { PlayerModel } from './render/playerModel';

interface Dummy {
  model: PlayerModel;
  base: Vector3;
  frame: Quaternion;
  yaw: number;
  hop: number;
  phase: number;
  target: Target;
}

/**
 * Demo players / shooting targets: show how other teams look from your point of view.
 * One at every team spawn, a few on the red island streets, two on each core face.
 */
export class Dummies {
  private readonly list: Dummy[] = [];

  constructor(private scene: Scene, private combat: Combat, map: MapData) {
    for (const t of TEAMS) {
      const sp = map.spawns[t.id];
      const q = new Quaternion(...sp.quat);
      const base = new Vector3(...sp.pos);
      if (t.id === 'red') base.add(new Vector3(3, 0, -1).applyQuaternion(q));
      this.add(t.id, base, q, sp.yaw + Math.PI);
    }
    for (const [x, z, t] of [[0, -14, 'blue'], [-2, -22, 'green'], [14, 2, 'yellow'], [22, -1.5, 'pink']] as [number, number, TeamId][])
      this.add(t, new Vector3(x, -87 + PLAYER_HEIGHT / 2 + 0.03, z), new Quaternion(), Math.atan2(x, z), t === 'green' ? 1.2 : 0);
    for (const f of map.faces) {
      const q = new Quaternion(...f.quat);
      const n = new Vector3(...f.normal);
      const c = n.clone().multiplyScalar(WORLD.coreHalf);
      const team = f.team as TeamId;
      this.add(team, c.clone().add(new Vector3(5, PLAYER_HEIGHT / 2, 4).applyQuaternion(q)), q, 0.6);
      this.add(team, c.clone().add(new Vector3(-6, PLAYER_HEIGHT / 2, -2).applyQuaternion(q)), q, 2.4, 1.6);
    }
  }

  private add(team: TeamId, base: Vector3, frame: Quaternion, yaw: number, hop = 0) {
    const model = new PlayerModel(getTeam(team).color);
    this.scene.add(model.group);
    // id 0 is the local player
    const target: Target = {
      id: this.list.length + 1, team, center: base.clone(), up: upOf(frame), hp: MAX_HP, alive: true, respawnIn: 0,
    };
    this.combat.targets.push(target);
    this.list.push({ model, base, frame, yaw, hop, phase: Math.random() * 10, target });
  }

  update(time: number, dt: number) {
    for (const d of this.list) {
      d.model.group.visible = d.target.alive;
      if (!d.target.alive) continue;
      const h = d.hop > 0 ? Math.max(0, Math.sin(time * 3 + d.phase)) * d.hop : 0;
      const up = upOf(d.frame);
      d.target.center.copy(d.base).addScaledVector(up, h);
      d.model.setPose(d.target.center, d.frame, d.yaw + Math.sin(time * 0.4 + d.phase) * 0.6);
      d.model.update(dt, PLAYER_HEIGHT / 2 + h);
    }
  }
}
