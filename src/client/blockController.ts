import { PerspectiveCamera, Scene, Vector3 } from 'three';
import {
  Block, BLOCK_ORDER, BlockKind, BlockMaterial, BlockSystem, PIECE_LABEL, PIECE_VARIANTS, PieceVariant, PlaceResult, VARIANT_LABEL,
} from '../shared/blocks';
import { upOf } from '../shared/math';
import type { PlayerSim } from '../shared/sim';
import type { TeamId } from '../shared/teams';
import type { GameAudio } from './audio';
import type { Hud } from './hud';
import type { Input } from './input';
import { icon, IconName } from './icons';
import { BlockView } from './render/blockView';

const PIECE_ICON: Record<BlockKind, IconName> = { block: 'block', wall: 'wall', floor: 'wood', ramp: 'stairs' };

/** Seconds between pieces while LMB is held (snappy global-grid building). */
const REPEAT = 0.16;
const BLOCK_REPEAT = 0.11;
/** Radial menu (hold Q): sector directions on screen (radians, 0 = right, clockwise as y grows down). */
const RADIAL: { kind: BlockKind; angle: number }[] = [
  { kind: 'wall', angle: -Math.PI / 2 },
  { kind: 'block', angle: 0 },
  { kind: 'floor', angle: Math.PI / 2 },
  { kind: 'ramp', angle: Math.PI },
];
const SUB_ANGLES = [-0.46, 0, 0.46] as const;
const SUB_RADIUS = 128;
/** Mouse travel (px) that picks a sector; a shorter Q press is a tap (next hotbar slot). */
const RADIAL_DEAD = 18;
const OUTER_RING = 98;
const TAP_TIME = 0.2;
const REJECT: Record<Exclude<PlaceResult, 'ok'>, string> = {
  resources: 'Не хватает материала: купи в магазине (E)',
  player: 'Мешает игрок',
  occupied: 'Здесь уже построено',
  blocked: 'Мешает постройка или кристалл',
};

/**
 * The shovel: LMB puts the chosen shape — 1×1 fortification block, wall, floor or ramp (plus plain / hole / door
 * sub-variants in the outer radial ring or on R) on the global grid. Hold Q for the radial menu; a quick Q tap switches
 * the hotbar slot. RMB picks up your own piece, Z / wheel switch the material.
 */
export class BlockController {
  active = false;
  material: BlockMaterial = 'wood';
  /** The build item the next click places (chosen in the radial menu). */
  next: BlockKind = 'block';
  /** Sub-variant: plain / hole / door (for wall & floor; plain for block & ramp). */
  variant: PieceVariant = 'plain';
  /** Radial menu state: open while Q is held. */
  private radial = { open: false, t: 0, x: 0, y: 0, hover: null as BlockKind | null, hoverVar: null as PieceVariant | null };
  private readonly radialEl = document.getElementById('build-radial')!;
  /** Q was tapped, not held (the key handler moves to the next hotbar slot). */
  tapped = false;
  /** A piece was built (viewmodel swing). */
  onPlace: () => void = () => {};
  onBlockPlaced?: (block: Block) => void;
  onBlockReclaimed?: (block: Block) => void;
  private cooldown = 0;
  private readonly view: BlockView;
  private readonly hudEl = document.getElementById('build-hud')!;

  constructor(private sim: PlayerSim, private input: Input, readonly blocks: BlockSystem, private audio: GameAudio,
    private hud: Hud, scene: Scene, private team: TeamId) {
    this.view = new BlockView(scene);
    // while the radial menu is open the mouse picks a sector (+ outer variant ring) instead of turning the view
    input.mouseHooks.push((dx, dy) => {
      if (!this.radial.open) return false;
      const r = this.radial;
      r.x += dx;
      r.y += dy;
      const len = Math.hypot(r.x, r.y);
      if (len > 152) { r.x *= 152 / len; r.y *= 152 / len; }
      return true;
    });
    const subHtml = RADIAL.filter((s) => s.kind === 'wall' || s.kind === 'floor').map(({ kind, angle }) =>
      PIECE_VARIANTS.map((v, i) => {
        const a = angle + SUB_ANGLES[i];
        const short = v === 'plain' ? 'Обычн.' : v === 'hole' ? 'Проём' : kind === 'wall' ? 'Дверь' : 'Люк';
        return `<div class="sub" data-kind="${kind}" data-var="${v}" style="--sx:${(Math.cos(a) * SUB_RADIUS).toFixed(1)}px;--sy:${(Math.sin(a) * SUB_RADIUS).toFixed(1)}px">${short}</div>`;
      }).join('')).join('');
    this.radialEl.innerHTML = RADIAL.map(({ kind, angle }) =>
      `<div class="sector" data-kind="${kind}" style="--x:${Math.cos(angle).toFixed(3)};--y:${Math.sin(angle).toFixed(3)}">${icon(PIECE_ICON[kind])}<span>${PIECE_LABEL[kind]}</span></div>`).join('')
      + subHtml
      + '<i class="dot"></i>';
    input.onWheel = (delta) => {
      if (!this.active) return false;
      this.cycleMaterial(delta > 0 ? 1 : -1);
      return true;
    };
  }

  /** Effective variant for the currently chosen piece (`wall`/`floor` use chosen variant, `block`/`ramp` stay plain). */
  get activeVariant(): PieceVariant {
    return this.next === 'wall' || this.next === 'floor' ? this.variant : 'plain';
  }

  /** Per frame: Q held opens the radial menu, releasing it over a sector/sub-sector picks that shape & variant. */
  private updateRadial(dt: number) {
    const r = this.radial;
    const held = this.active && this.input.locked && this.input.down('KeyQ');
    if (held && !r.open) Object.assign(r, { open: true, t: 0, x: 0, y: 0, hover: null, hoverVar: null });
    if (r.open) {
      r.t += dt;
      r.hover = null;
      r.hoverVar = null;
      const dist = Math.hypot(r.x, r.y);
      if (dist > RADIAL_DEAD) {
        const a = Math.atan2(r.y, r.x);
        let best = Infinity;
        let bestAngle = 0;
        for (const s of RADIAL) {
          const d = Math.abs(Math.atan2(Math.sin(a - s.angle), Math.cos(a - s.angle)));
          if (d < best) { best = d; r.hover = s.kind; bestAngle = s.angle; }
        }
        if ((r.hover === 'wall' || r.hover === 'floor') && dist > OUTER_RING) {
          const relA = Math.atan2(Math.sin(a - bestAngle), Math.cos(a - bestAngle));
          r.hoverVar = relA < -0.22 ? 'plain' : relA > 0.22 ? 'door' : 'hole';
        }
      }
      if (!held) {
        r.open = false;
        if (r.hover) {
          const changed = r.hover !== this.next || (r.hoverVar !== null && r.hoverVar !== this.variant);
          if (changed) this.audio.select();
          this.next = r.hover;
          if (r.hoverVar) this.variant = r.hoverVar;
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
      for (const el of this.radialEl.querySelectorAll<HTMLElement>('.sub')) {
        const showSub = el.dataset.kind === (r.hover ?? this.next);
        el.style.display = showSub ? '' : 'none';
        el.classList.toggle('hover', showSub && el.dataset.var === r.hoverVar);
        el.classList.toggle('on', el.dataset.kind === this.next && el.dataset.var === this.variant);
      }
      this.radialEl.querySelector<HTMLElement>('.dot')!.style.transform = `translate(${r.x * 0.5}px, ${r.y * 0.5}px)`;
    }
  }

  cycleMaterial(step: number) {
    const i = BLOCK_ORDER.indexOf(this.material);
    this.material = BLOCK_ORDER[(i + step + BLOCK_ORDER.length) % BLOCK_ORDER.length];
    this.audio.select();
  }

  cycleVariant(step = 1) {
    if (this.next !== 'wall' && this.next !== 'floor') this.next = 'wall';
    const i = PIECE_VARIANTS.indexOf(this.variant);
    this.variant = PIECE_VARIANTS[(i + step + PIECE_VARIANTS.length) % PIECE_VARIANTS.length];
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
        const reclaimed = block ? blocks.reclaim(block.collider.handle, this.team) : null;
        if (reclaimed) {
          this.audio.remove();
          this.onBlockReclaimed?.(reclaimed);
        } else {
          this.audio.reject();
          this.hud.toast(block ? 'Чужая постройка — ломай оружием' : 'Наведи на свою постройку', '#ffb49e', 1);
        }
      }
      const variant = this.activeVariant;
      let plan = blocks.plan(this.next, sim.state.pos, up, forward, camera.position, forward, variant);
      const click = input.take('Mouse0');
      if (plan && this.cooldown <= 0 && (click || input.down('Mouse0'))) {
        this.cooldown = this.next === 'block' ? BLOCK_REPEAT : REPEAT;
        const placed = blocks.place(plan, this.material, this.team);
        if (placed === 'ok') {
          for (const b of blocks.blocks.values()) {
            if (b.key === plan.key) { this.onBlockPlaced?.(b); break; }
          }
          this.audio.place();
          this.onPlace();
          plan = blocks.plan(this.next, sim.state.pos, up, forward, camera.position, forward, variant);
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
      const varHint = this.next === 'wall' || this.next === 'floor'
        ? `<span class="vars">${PIECE_VARIANTS.map((v) =>
          `<span class="var${v === this.variant ? ' on' : ''}">${v === 'plain' ? 'Обычн.' : v === 'hole' ? 'Проём' : this.next === 'wall' ? 'Дверь' : 'Люк'}</span>`).join('')}</span>`
        : '';
      this.hudEl.innerHTML = `<span class="next">${icon(PIECE_ICON[this.next])}${PIECE_LABEL[this.next]}</span>${varHint}<span class="mats">${mats}</span>`
        + `<span class="hint">Q (держать) — форма/вид · R — ${VARIANT_LABEL[this.variant]} · колесо/Z — материал · ПКМ — забрать</span>`;
    }
  }
}
