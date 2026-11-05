import { PerspectiveCamera, Scene, Vector3 } from 'three';
import {
  BLOCK_ORDER, BlockMaterial, BlockSystem, PIECE_COST, PIECE_KINDS, PIECE_LABEL, PieceKind, PlaceResult,
} from '../shared/blocks';
import { upOf } from '../shared/math';
import type { PlayerSim } from '../shared/sim';
import type { TeamId } from '../shared/teams';
import type { GameAudio } from './audio';
import type { Hud } from './hud';
import type { Input } from './input';
import { icon, IconName } from './icons';
import { BlockView } from './render/blockView';

const PIECE_ICON: Record<PieceKind, IconName> = { wall: 'wall', floor: 'wood', ramp: 'stairs' };

/** Seconds between pieces while LMB is held. */
const REPEAT = 0.22;
const REJECT: Record<Exclude<PlaceResult, 'ok'>, string> = {
  resources: 'Не хватает материала: купи в магазине (E)', player: 'Мешает игрок', occupied: 'Здесь уже построено',
};

/**
 * The shovel (slot 3): LMB puts a random piece — wall, floor or ramp — in front of you on the build grid.
 * The ghost shows what comes next. RMB picks up your own piece, Q / Z / wheel switch the material.
 */
export class BlockController {
  active = false;
  material: BlockMaterial = 'wood';
  /** The piece the next click builds (rolled after every placement). */
  next: PieceKind = this.roll();
  /** A piece was built (viewmodel swing). */
  onPlace: () => void = () => {};
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

  private roll(): PieceKind {
    return PIECE_KINDS[Math.floor(Math.random() * PIECE_KINDS.length)];
  }

  cycleMaterial(step: number) {
    const i = BLOCK_ORDER.indexOf(this.material);
    this.material = BLOCK_ORDER[(i + step + BLOCK_ORDER.length) % BLOCK_ORDER.length];
    this.audio.select();
  }

  update(dt: number, camera: PerspectiveCamera) {
    const { input, sim, blocks } = this;
    this.cooldown = Math.max(0, this.cooldown - dt);
    let preview = null;
    let ok = false;

    if (this.active && input.locked) {
      const up = upOf(sim.state.frame);
      const forward = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
      if (input.take('Mouse2')) {
        const block = blocks.aimedBlock(camera.position, forward);
        if (block && blocks.reclaim(block.collider.handle, this.team)) this.audio.remove();
        else {
          this.audio.reject();
          this.hud.toast(block ? 'Чужая постройка — ломай оружием' : 'Наведи на свою постройку', '#ffb49e', 1);
        }
      }
      let plan = blocks.plan(this.next, sim.state.pos, up, forward);
      const click = input.take('Mouse0');
      if (plan && this.cooldown <= 0 && (click || input.down('Mouse0'))) {
        this.cooldown = REPEAT;
        const placed = blocks.place(plan, this.material, this.team);
        if (placed === 'ok') {
          this.audio.place();
          this.onPlace();
          this.next = this.roll();
          plan = blocks.plan(this.next, sim.state.pos, up, forward);
        } else if (click) {
          this.audio.reject();
          this.hud.toast(REJECT[placed], '#ff8e83', 1.2);
        }
      }
      if (plan) {
        preview = plan;
        ok = blocks.validate(plan, this.material) === 'ok';
      }
    }

    this.view.update(blocks, preview, ok);
    this.hudEl.style.display = this.active ? 'flex' : 'none';
    if (this.active) {
      const mats = BLOCK_ORDER.map((m) =>
        `<span class="mat${m === this.material ? ' on' : ''}">${icon(m)}${blocks.inventory[m]}</span>`).join('');
      this.hudEl.innerHTML = `<span class="next">${icon(PIECE_ICON[this.next])}${PIECE_LABEL[this.next]}</span><span class="mats">${mats}</span>`
        + `<span class="hint">постройка = ${PIECE_COST} · ПКМ забрать · Q/Z материал</span>`;
    }
  }
}
