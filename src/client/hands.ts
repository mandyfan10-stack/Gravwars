import { PerspectiveCamera, Vector3 } from 'three';
import { MAX_HP } from '../shared/combat';
import { APPLE_EAT_TIME, EAT_COOLDOWN, Economy, ItemId, ITEMS } from '../shared/economy';
import { Holdable, holdables, Hotbar, isHeldGun, isItem, SlotRef } from '../shared/inventory';
import { HOOK, PlayerSim } from '../shared/sim';
import { THROW, Throws } from '../shared/throwables';
import { WEAPONS } from '../shared/weapons';
import type { GameAudio } from './audio';
import type { BlockController } from './blockController';
import type { Cursor } from './cursor';
import type { Hud } from './hud';
import { icon, IconName } from './icons';
import type { PlayerCombat } from './playerCombat';
import type { Pockets } from './pockets';
import type { ViewModel, ViewTool } from './render/viewmodel';

const $ = (id: string) => document.getElementById(id)!;
const _dir = new Vector3();

export const HOLD_ICON: Record<Holdable, IconName> = {
  pistol: 'pistol', shotgun: 'shotgun', rifle: 'rifle', crossbow: 'crossbow', rocket: 'rocket', grenade: 'grenade', build: 'shovel', hook: 'hook', rod: 'rod',
  apple: 'apple', bottle: 'bottle', fish: 'fish', medkit: 'heart',
};
export const HOLD_NAME: Record<Holdable, string> = {
  pistol: 'Пистолет', shotgun: 'Дробовик', rifle: 'Автомат', crossbow: 'Арбалет', rocket: 'Ракетница', grenade: 'Гранаты', build: 'Строительство',
  hook: 'Крюк-кошка', rod: 'Удочка', apple: ITEMS.apple.name, bottle: ITEMS.bottle.name, fish: ITEMS.fish.name, medkit: ITEMS.medkit.name,
};
/** What the buttons do with it in hand (weapon panel). */
export const HOLD_USE: Record<Holdable, string> = {
  pistol: 'ЛКМ — огонь · R — перезарядка', shotgun: 'ЛКМ — выстрел дробью · R — перезарядка', rifle: 'ЛКМ — огонь · R — перезарядка',
  crossbow: 'Зажать ЛКМ — заряд (до 3 ур.), отпустить — выстрел · ПКМ — зум',
  rocket: `ЛКМ — ракета: взрыв ${WEAPONS.rocket.radius} м · R — перезарядка`, grenade: 'ЛКМ — бросить гранату',
  hook: `ЛКМ — зацепиться (до ${HOOK.range} м) и подтянуться · ЛКМ или пробел — отпустить`,
  build: 'ЛКМ — строить · ПКМ — забрать свою постройку · Q/Z — материал', rod: 'ЛКМ — забросить в пруд, ЛКМ — подсечь',
  apple: `Зажать ЛКМ (1 с) — съесть (+${ITEMS.apple.heal}) · F — взять в руки · G — бросить`, fish: `ЛКМ — съесть (+${ITEMS.fish.heal}) · G — бросить`,
  bottle: `ЛКМ или G — бросить: разбивается, оглушает на ${THROW.stun} с`, medkit: 'ЛКМ — вылечиться полностью · G — бросить',
};

/**
 * What is in the hands: the 9-slot hotbar (1–9, Q), using the held item (LMB: eat, heal, throw a bottle), throwing (G).
 */
export class Hands {
  readonly bar = new Hotbar();
  /** Put away: bare fists even though the selected slot holds something (press its key again). */
  bare = false;
  /** Building mode toggled directly with B (KeyB). */
  buildMode = false;
  /** Legacy flag (inventory window removed — only 9 hotbar slots). */
  invOpen = false;
  private useT = 0;
  /** Progress of holding LMB to eat an apple (0..APPLE_EAT_TIME). */
  appleEatT = 0;
  private readonly hotbarEl = $('hotbar');
  private readonly invEl = $('inv');
  private hotbarKey = '';
  /** Inventory cell under the cursor (unused now). */
  hovered: SlotRef | null = null;
  /** Colliders the grappling hook can bite (not people). */
  hookFilter: ((c: { handle: number }) => boolean) | undefined;
  /** The hook was thrown / let go (sound, viewmodel). */
  onHook: (thrown: boolean) => void = () => {};
  private fireWas = false;

  constructor(private eco: Economy, private player: PlayerCombat, private build: BlockController, private pockets: Pockets,
    private throws: Throws, private sim: PlayerSim, private audio: GameAudio, private hud: Hud, private viewModel: ViewModel,
    _cursor: Cursor) {}

  /** Thing in hand (null = fists). */
  get held(): Holdable | null {
    if (this.buildMode) return 'build';
    return this.bare ? null : this.bar.held;
  }

  /** Progress 0..1 while holding LMB to eat an apple. */
  get appleEatProgress(): number {
    return this.held === 'apple' && this.appleEatT > 0 ? Math.min(1, this.appleEatT / APPLE_EAT_TIME) : 0;
  }

  /** F: equip apple into hands (instead of eating immediately). */
  equipApple() {
    if (this.eco.items.apple <= 0) {
      this.audio.reject();
      this.hud.toast('Нет яблок', '#ffb49e', 0.8);
      return;
    }
    this.bar.sync(holdables(this.eco));
    let idx = this.bar.bar.indexOf('apple');
    if (idx < 0) {
      idx = this.bar.sel;
      this.bar.bar[idx] = 'apple';
    }
    this.buildMode = false;
    this.bar.sel = idx;
    this.bare = false;
    this.audio.select();
  }

  /** Toggle building mode (B). */
  toggleBuild() {
    this.buildMode = !this.buildMode;
    this.audio.select();
  }

  /** The pocket item in hand, if any (LMB uses it instead of a weapon). */
  get item() {
    const h = this.held;
    return isItem(h) ? h : null;
  }

  /** Key 1–9: that slot; the same key again puts it away (fists). */
  select(i: number) {
    if (this.buildMode) {
      this.buildMode = false;
      this.bar.sel = i;
      this.bare = false;
    } else if (i === this.bar.sel && this.bar.bar[i]) this.bare = !this.bare;
    else { this.bar.sel = i; this.bare = false; }
    this.appleEatT = 0;
    this.audio.select();
  }

  cycle(step: 1 | -1) {
    this.buildMode = false;
    this.bar.cycle(step);
    this.bare = false;
    this.appleEatT = 0;
  }

  /** What the hands show instead of a weapon (viewmodel, weapon panel). */
  get tool(): ViewTool {
    const h = this.held;
    return h === 'build' || h === 'rod' || h === 'hook' ? h : isItem(h) ? h : null;
  }

  /** G: throw one of the held item. */
  throwHeld(camera: PerspectiveCamera) {
    const h = this.held;
    if (!this.player.me.alive) return;
    if (!isItem(h)) {
      if (h) { this.audio.reject(); this.hud.toast(h === 'grenade' ? 'Гранату — ЛКМ' : 'Это не выбросить', '#ffb49e', 0.9); }
      return;
    }
    this.toss(h, camera);
  }

  private toss(id: ItemId, camera: PerspectiveCamera) {
    if (this.useT > 0 || !this.eco.take(id)) return;
    this.useT = THROW.interval;
    this.appleEatT = 0;
    camera.getWorldDirection(_dir);
    this.throws.throw(id, 0, camera.position, _dir, this.sim.state.vel, this.sim.gravityDown());
    this.viewModel.toss();
    this.audio.toss();
  }

  /** LMB with a non-apple item in hand. */
  private use(camera: PerspectiveCamera) {
    const id = this.item;
    if (!id || id === 'apple' || this.useT > 0) return;
    if (id === 'bottle') { this.toss(id, camera); return; }
    if (this.pockets.consume(id)) this.useT = 0.5;
  }

  toggleInventory() {
    // Inventory window removed: only 9 hotbar slots exist.
    this.invOpen = false;
  }

  assign(_n: number) {}

  /**
   * Per frame. `fire`: LMB is held in play (no panel open).
   */
  update(dt: number, camera: PerspectiveCamera, fire: boolean, _click: HTMLElement | null) {
    this.useT = Math.max(0, this.useT - dt);
    this.bar.sync(holdables(this.eco));
    const h = this.held;
    // hands: weapons through the weapon state; build tool, rod and items instead of it
    this.build.active = h === 'build';
    this.pockets.setRod(h === 'rod');
    const weapon = isHeldGun(h) || h === 'grenade' ? h : h === null ? 'fists' : null;
    if (weapon && this.player.weapons.current !== weapon) this.player.pendingSelect = weapon;

    const pressed = fire && !this.fireWas;
    if (h === 'apple' && fire && this.player.me.alive && this.eco.items.apple > 0) {
      if (this.useT <= 0) {
        if (this.player.me.hp >= MAX_HP) {
          if (pressed) {
            this.audio.reject();
            this.hud.toast('Здоровье и так полное', '#ffb49e', 0.8);
          }
          this.appleEatT = 0;
        } else {
          this.appleEatT += dt;
          if (this.appleEatT >= APPLE_EAT_TIME) {
            if (this.pockets.consume('apple')) {
              this.useT = EAT_COOLDOWN;
            }
            this.appleEatT = 0;
          }
        }
      }
    } else {
      this.appleEatT = 0;
      if (fire && isItem(h)) this.use(camera);
    }

    // grappling hook: a click throws it, a click while it pulls lets go
    this.fireWas = fire;
    if (h !== 'hook' && this.sim.hook?.phase === 'pull') this.sim.releaseHook();
    if (h === 'hook' && pressed && this.player.me.alive) {
      if (this.sim.hook?.phase === 'pull') { this.sim.releaseHook(); this.onHook(false); }
      else if (this.sim.throwHook(camera.position, camera.getWorldDirection(_dir), this.hookFilter)) this.onHook(true);
    }
    this.viewModel.setTool(this.tool);
    this.renderHotbar();
    this.invEl.hidden = true;
  }

  /** Count shown on a slot (items, grenades, rounds of a gun). */
  private count(h: Holdable): number | null {
    const ws = this.eco.weapons;
    if (isItem(h)) return this.eco.items[h];
    if (h === 'grenade') return ws.ammo.grenade;
    if (isHeldGun(h)) return ws.ammo[h] + ws.reserve[h];
    return null;
  }

  private cell(h: Holdable | null, extra = '') {
    if (!h) return extra;
    const n = this.count(h);
    return `${icon(HOLD_ICON[h])}${n !== null ? `<b>${n}</b>` : ''}${extra}`;
  }

  private renderHotbar() {
    const b = this.bar;
    const key = [b.sel, this.bare, ...b.bar.map((h) => h && `${h}${this.count(h)}`)].join();
    if (key === this.hotbarKey) return;
    this.hotbarKey = key;
    this.hotbarEl.innerHTML = b.bar.map((h, i) =>
      `<div class="slot${i === b.sel && !this.bare ? ' on' : ''}${h ? '' : ' empty'}" title="${h ? HOLD_NAME[h] : ''}"><kbd>${i + 1}</kbd>${this.cell(h)}</div>`).join('');
  }
}
