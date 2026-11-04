import { PerspectiveCamera, Scene, Vector3 } from 'three';
import {
  BUILD_COST, BUILD_MATERIALS, BuildKind, BuildMaterial, BuildPlan, BuildResult, BuildSystem, planBuild,
} from '../shared/building';
import { buildAim } from '../shared/buildAim';
import { upOf } from '../shared/math';
import { moveBasis } from '../shared/movement';
import type { PhysicsWorld, Rapier } from '../shared/physics';
import type { PlayerSim } from '../shared/sim';
import type { GameAudio } from './audio';
import { BuildWheel } from './buildWheel';
import type { Hud } from './hud';
import type { Input } from './input';
import { BuildView } from './render/buildView';

const KIND_ORDER: BuildKind[] = ['floor', 'wall', 'ramp'];
const KIND_LABEL = { wall: 'СТЕНА', floor: 'ПОЛ', ramp: 'ПАНДУС' } as const;
const REJECT: Record<Exclude<BuildResult, 'ok'>, string> = {
  duplicate: 'Уже построено', resources: 'Не хватает материалов', player: 'Слишком близко к игроку',
  range: 'Слишком далеко', occupied: 'Место занято',
};

/** Build mode: aiming, preview, placing / reclaiming pieces, the radial wheel and the build HUD line. */
export class BuildController {
  active = false;
  kind: BuildKind = 'floor';
  material: BuildMaterial = 'wood';
  turns = 0;
  private cooldown = 0;
  private plan: BuildPlan | null = null;
  private result: BuildResult | null = null;
  private readonly view: BuildView;
  private readonly wheel: BuildWheel;
  private readonly hudEl = document.getElementById('build-hud')!;

  constructor(private R: Rapier, private world: PhysicsWorld, private sim: PlayerSim, private input: Input,
    readonly buildings: BuildSystem, private audio: GameAudio, private hud: Hud, scene: Scene) {
    this.view = new BuildView(scene);
    this.wheel = new BuildWheel(() => audio.select());
    input.onMouseMove = (dx, dy) => this.wheel.move(dx, dy);
    input.onWheel = (delta) => {
      if (!this.active) return false;
      this.kind = KIND_ORDER[(KIND_ORDER.indexOf(this.kind) + (delta > 0 ? 1 : 2)) % 3];
      audio.select();
      return true;
    };
  }

  /** Enter build mode with the given piece. */
  select(kind: BuildKind) {
    this.active = true;
    this.kind = kind;
  }

  rotate() {
    this.turns = (this.turns + 1) % 4;
  }

  update(dt: number, camera: PerspectiveCamera) {
    const { input, sim, buildings } = this;
    const choice = this.wheel.update(dt, this.active && input.locked, (key) => input.down(key), this.kind, this.material);
    this.kind = choice.kind;
    this.material = choice.material;
    this.cooldown = Math.max(0, this.cooldown - dt);

    if (this.active && input.locked) {
      const up = upOf(sim.state.frame);
      const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const flat = new Vector3(), right = new Vector3();
      moveBasis(sim.state.frame, input.yaw, flat, right);
      const hit = this.world.castRayAndGetNormal(new this.R.Ray(camera.position, forward), 7, true, undefined, undefined, sim.mover.collider);
      const aimHit = hit ? { pos: camera.position.clone().addScaledVector(forward, hit.timeOfImpact), piece: buildings.byCollider(hit.collider.handle) } : null;
      const point = buildAim(this.kind, camera.position, sim.state.pos, up, forward, flat, aimHit);
      // stacking a wall on a wall keeps the lower wall's orientation
      const stack = this.kind === 'wall' && aimHit?.piece?.plan.kind === 'wall' && point.distanceTo(aimHit.piece.plan.cell.clone().addScaledVector(up, 3)) < .01;
      const orientation = stack ? new Vector3(0, 0, -1).applyQuaternion(aimHit!.piece!.plan.rotation) : flat;
      const plan = (this.plan = planBuild(this.kind, point, up, orientation, stack ? 0 : this.turns));
      this.result = buildings.validate(plan, sim.state.pos, sim.state.frame, camera.position, this.material);

      if (!this.wheel.active && input.take('Mouse2')) {
        const piece = hit && buildings.reclaim(hit.collider.handle);
        if (piece) {
          this.audio.remove();
          this.hud.toast(`Разобрано: +${Math.floor(BUILD_COST / 2)} ${BUILD_MATERIALS[piece.material].label.toLowerCase()}`, '#c6ffdb', 1);
        } else {
          this.audio.reject();
          this.hud.toast('Наведи на постройку', '#ffb49e', 1);
        }
      }
      const click = input.take('Mouse0');
      if (!this.wheel.active && this.cooldown <= 0 && (click || input.down('Mouse0'))) {
        this.cooldown = .16;
        const result = buildings.place(plan, sim.state.pos, sim.state.frame, camera.position, this.material);
        if (result === 'ok') this.audio.place();
        else if (click) {
          this.audio.reject();
          this.hud.toast(REJECT[result], '#ff8e83', 1);
        }
        this.result = buildings.validate(plan, sim.state.pos, sim.state.frame, camera.position, this.material);
      }
    } else {
      this.plan = null;
      this.result = null;
    }

    this.view.update(buildings, this.plan, this.result);
    this.hudEl.style.display = this.active ? 'block' : 'none';
    this.hudEl.innerHTML = `<strong>${KIND_LABEL[this.kind]} · ${BUILD_MATERIALS[this.material].label.toUpperCase()}</strong> &nbsp; ${buildings.resources[this.material]} / ${BUILD_COST} &nbsp; <span>Q деталь · Z материал · R поворот · ЛКМ строить · ПКМ разобрать · B выход</span>`;
  }
}
