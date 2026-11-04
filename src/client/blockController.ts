import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { BLOCK_MATERIALS, BLOCK_ORDER, BlockMaterial, BlockSystem, PlaceResult } from '../shared/blocks';
import { upOf } from '../shared/math';
import { moveBasis } from '../shared/movement';
import type { PlayerSim } from '../shared/sim';
import type { TeamId } from '../shared/teams';
import type { GameAudio } from './audio';
import type { Hud } from './hud';
import type { Input } from './input';
import { BlockView } from './render/blockView';

/** Seconds between blocks while LMB is held (fast bridging / pillaring). */
const REPEAT = 0.12;
const REJECT: Record<Exclude<PlaceResult, 'ok'>, string> = {
  resources: 'Нет блоков: купи в магазине (E)', player: 'Мешает игрок', range: 'Слишком далеко', occupied: 'Место занято',
};

/** Block mode: aim, preview, place (hold LMB), pick up own blocks (RMB), material choice, block HUD line. */
export class BlockController {
  active = false;
  material: BlockMaterial = 'wood';
  private cooldown = 0;
  private readonly view: BlockView;
  private readonly hudEl = document.getElementById('build-hud')!;

  constructor(private sim: PlayerSim, private input: Input, readonly blocks: BlockSystem, private audio: GameAudio,
    private hud: Hud, scene: Scene, private team: TeamId) {
    this.view = new BlockView(scene);
    input.onWheel = (delta) => {
      if (!this.active) return false;
      this.cycleMaterial(delta > 0 ? 1 : -1);
      return true;
    };
  }

  cycleMaterial(step: number) {
    const i = BLOCK_ORDER.indexOf(this.material);
    this.material = BLOCK_ORDER[(i + step + BLOCK_ORDER.length) % BLOCK_ORDER.length];
    this.audio.select();
  }

  update(dt: number, camera: PerspectiveCamera) {
    const { input, sim, blocks } = this;
    this.cooldown = Math.max(0, this.cooldown - dt);
    let preview: Vector3 | null = null;
    let ok = false;

    if (this.active && input.locked) {
      const up = upOf(sim.state.frame);
      const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      const flat = new Vector3(), right = new Vector3();
      moveBasis(sim.state.frame, input.yaw, flat, right);
      const target = blocks.target(camera.position, forward, sim.state.pos, up, flat);
      const check = () => target ? blocks.validate(target.center, sim.state.pos, sim.state.frame, camera.position, this.material) : null;
      let result = check();

      if (input.take('Mouse2')) {
        const block = blocks.aimedBlock(camera.position, forward);
        if (block && blocks.reclaim(block.collider.handle, this.team)) this.audio.remove();
        else {
          this.audio.reject();
          this.hud.toast(block ? 'Чужой блок — ломай оружием' : 'Наведи на свой блок', '#ffb49e', 1);
        }
        result = check();
      }
      const click = input.take('Mouse0');
      if (target && this.cooldown <= 0 && (click || input.down('Mouse0'))) {
        this.cooldown = REPEAT;
        const placed = blocks.place(target.center, sim.state.pos, sim.state.frame, camera.position, this.material, this.team);
        if (placed === 'ok') this.audio.place();
        else if (click && !(target.assisted && placed !== 'resources')) {
          this.audio.reject();
          this.hud.toast(REJECT[placed], '#ff8e83', 1.2);
        }
        result = check();
      }
      // bridging guesses that do not fit are hidden instead of shown in red
      if (target && result && !(target.assisted && result !== 'ok')) {
        preview = target.center;
        ok = result === 'ok';
      }
    }

    this.view.update(blocks, preview, ok);
    this.hudEl.style.display = this.active ? 'block' : 'none';
    const mats = BLOCK_ORDER.map((m) => {
      const label = `${BLOCK_MATERIALS[m].label} ${blocks.inventory[m]}`;
      return m === this.material ? `<strong>▸ ${label.toUpperCase()}</strong>` : `<span class="dim">${label}</span>`;
    }).join(' &nbsp; ');
    this.hudEl.innerHTML = `${mats} &nbsp; <span>Q/Z/колесо материал · ЛКМ ставить (держать) · ПКМ забрать свой · B выход</span>`;
  }
}
