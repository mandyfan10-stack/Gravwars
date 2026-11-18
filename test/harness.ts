import { Vector3 } from 'three';
import { TICK_DT, WORLD } from '../src/shared/constants';
import { faceOfTeam, FaceId, generateMap, MapData, TILE } from '../src/shared/map';
import { emptyInput, MoveInput } from '../src/shared/movement';
import { buildPhysicsWorld, initRapier, PhysicsWorld, Rapier } from '../src/shared/physics';
import { PlayerSim } from '../src/shared/sim';

export interface SimHarness {
  readonly R: Rapier;
  readonly map: MapData;
  readonly world: PhysicsWorld;
  readonly sim: PlayerSim;
  readonly G: number;
  readonly RED: FaceId;
  readonly RX: number;
  readonly perfBudgetMul: number;
  check(name: string, ok: boolean, info?: string): void;
  run(ticks: number, input: Partial<MoveInput> | ((i: number) => Partial<MoveInput>)): void;
  planarSpeed(): number;
  place(x: number, y: number, z: number, yaw?: number): void;
  failedCount(): number;
}

export async function createHarness(): Promise<SimHarness> {
  const R = await initRapier();
  const map = generateMap();
  const world = buildPhysicsWorld(R, map);
  const sim = new PlayerSim(R, world, map, 'red');
  const s = sim.state;
  const G = -WORLD.cubeHalf;
  const RED = faceOfTeam(map, 'red')!.id;
  const RX = TILE / 2;
  const perfBudgetMul = process.env.CI ? 2.5 : 1;
  let failed = 0;

  return {
    R,
    map,
    world,
    sim,
    G,
    RED,
    RX,
    perfBudgetMul,
    check(name: string, ok: boolean, info = '') {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`);
      if (!ok) failed++;
    },
    run(ticks: number, input: Partial<MoveInput> | ((i: number) => Partial<MoveInput>)) {
      for (let i = 0; i < ticks; i++) {
        const inp = { ...emptyInput(), yaw: s.yaw, pitch: s.pitch, ...(typeof input === 'function' ? input(i) : input) };
        sim.tick(inp, TICK_DT);
      }
    },
    planarSpeed() {
      const up = new Vector3(0, 1, 0).applyQuaternion(s.frame);
      return s.vel.clone().addScaledVector(up, -s.vel.dot(up)).length();
    },
    place(x: number, y: number, z: number, yaw = 0) {
      s.pos.set(x, y, z);
      s.vel.set(0, 0, 0);
      s.frame.identity();
      s.yaw = yaw;
      s.onGround = false;
      sim.mover.place(s);
    },
    failedCount() {
      return failed;
    },
  };
}
