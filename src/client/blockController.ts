import { PerspectiveCamera, Scene, Vector3 } from 'three';
import {
  BLOCK_ORDER, BlockMaterial, BlockSystem, PIECE_LABEL, PieceKind, PlaceResult,
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
/** Radial menu (hold Q): sector directions on screen (radians, 0 = right, clockwise as y grows down). */
const RADIAL: { kind: PieceKind; angle: number }[] = [
  { kind: 'wall', angle: -Math.PI / 2 },
  { kind: 'ramp', angle: Math.PI / 6 },
  { kind: 'floor', angle: (5 * Math.PI) / 6 },
];
/** Mouse travel (px) that picks a sector; a shorter Q press is a tap (next hotbar slot). */
const RADIAL_DEAD = 18;
const TAP_TIME = 0.2;
const REJECT: Record<Exclude<PlaceResult, 'ok'>, string> = {
  resources: 'Не хватает материала: купи в магазине (E)', player: 'Мешает игрок', occupied: 'Здесь уже построено',
};

/**
 * The shovel: LMB puts the chosen piece — wall, floor or ramp — in front of you on the build grid (the ghost shows
 * where). Hold Q for the radial menu, move the mouse towards a shape and let go; a quick Q tap still switches the
 * hotbar slot. RMB picks up your own piece, Z / wheel switch the material.
 */
export class BlockController {
  active = false;
  material: BlockMaterial = 'wood';
  /** The piece the next click builds (chosen in the radial menu). */
  next: PieceKind = 'wall';
  /** Radial menu state: open while Q is held. */
  private radial = { open: false, t: 0, x: 0, y: 0, hover: null as PieceKind | null };
  private readonly radialEl = document.getElementById('build-radial')!;
  /** Q was tapped, not held (the key handler moves to the next hotbar slot). */
  tapped = false;
  /** A piece was built (viewmodel swing). */
  onPlace: () => void = () => {};
  private cooldown = 0;
  private readonly view: BlockView;
  private readonly hudEl = document.getElementById('build-hud')!;

  constructor(private sim: PlayerSim, private input: Input, readonly blocks: BlockSystem, private audio: GameAudio,
    private hud: Hud, scene: Scene, private team: TeamId) {
    this.view = new BlockView(scene);
    // while the radial menu is open the mouse picks a sector instead of turning the view
    input.mouseHooks.push((dx, dy) => {
      if (!this.radial.open) return false;
      const r = this.radial;
      r.x += dx;
      r.y += dy;
      const len = Math.hypot(r.x, r.y);
      if (len > 90) { r.x *= 90 / len; r.y *= 90 / len; }
      return true;
    });
    this.radialEl.innerHTML = RADIAL.map(({ kind, angle }) =>
      `<div class="sector" data-kind="${kind}" style="--x:${Math.cos(angle).toFixed(3)};--y:${Math.sin(angle).toFixed(3)}">${icon(PIECE_ICON[kind])}<span>${PIECE_LABEL[kind]}</span></div>`).join('')
      + '<i class="dot"></i>';
    input.onWheel = (delta) => {
      if (!this.active) return false;
      this.cycleMaterial(delta > 0 ? 1 : -1);
      return true;
    };
  }

  /** Per frame: Q held opens the radial menu, releasing it over a sector picks that shape. */
  private updateRadial(dt: number) {
    const r = this.radial;
    const held = this.active && this.input.locked && this.input.down('KeyQ');
    if (held && !r.open) Object.assign(r, { open: true, t: 0, x: 0, y: 0, hover: null });
    if (r.open) {
      r.t += dt;
      r.hover = null;
      if (Math.hypot(r.x, r.y) > RADIAL_DEAD) {
        const a = Math.atan2(r.y, r.x);
        let best = Infinity;
        for (const s of RADIAL) {
          const d = Math.abs(Math.atan2(Math.sin(a - s.angle), Math.cos(a - s.angle)));
          if (d < best) { best = d; r.hover = s.kind; }
        }
      }
      if (!held) {
        r.open = false;
        if (r.hover) {
          if (r.hover !== this.next) this.audio.select();
          this.next = r.hover;
        } else if (r.t < TAP_TIME) this.tapped = true;
      }
    }
    const show = r.open && r.t > 0.08;
    this.radialEl.hidden = !show;
    if (show) {
      for (const el of this.radialEl.querySelectorAll<HTMLElement>('.sector')) {
        el.classList.toggle('hover', el.dataset.kind === r.hover);
        el.classList.toggle('on', el.dataset.kind === this.next);
      }
      this.radialEl.querySelector<HTMLElement>('.dot')!.style.transform = `translate(${r.x * 0.5}px, ${r.y * 0.5}px)`;
    }
  }

  cycleMaterial(step: number) {
    const i = BLOCK_ORDER.indexOf(this.material);
    this.material = BLOCK_ORDER[(i + step + BLOCK_ORDER.length) % BLOCK_ORDER.length];
    this.audio.select();
  }

  update(dt: number, camera: PerspectiveCamera) {
    const { input, sim, blocks } = this;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.updateRadial(dt);
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
        + `<span class="hint">1 материал = 1 постройка · Q (держать) — форма · колесо/Z — материал · ПКМ — забрать</span>`;
    }
  }
}
