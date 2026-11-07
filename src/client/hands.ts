import { PerspectiveCamera, Vector3 } from 'three';
import { Economy, ItemId, ITEMS } from '../shared/economy';
import { Holdable, holdables, Hotbar, HOTBAR_SIZE, isHeldGun, isItem, SlotRef } from '../shared/inventory';
import { HOOK, PlayerSim } from '../shared/sim';
import { THROW, Throws } from '../shared/throwables';
import { isGun, WEAPONS } from '../shared/weapons';
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
  pistol: 'pistol', shotgun: 'shotgun', rifle: 'rifle', rocket: 'rocket', grenade: 'grenade', build: 'shovel', hook: 'hook', rod: 'rod',
  apple: 'apple', bottle: 'bottle', fish: 'fish', medkit: 'heart',
};
export const HOLD_NAME: Record<Holdable, string> = {
  pistol: 'Пистолет', shotgun: 'Дробовик', rifle: 'Автомат', rocket: 'Ракетница', grenade: 'Гранаты', build: 'Строительство',
  hook: 'Крюк-кошка', rod: 'Удочка', apple: ITEMS.apple.name, bottle: ITEMS.bottle.name, fish: ITEMS.fish.name, medkit: ITEMS.medkit.name,
};
/** What the buttons do with it in hand (inventory tooltip, weapon panel). */
const HOLD_USE: Record<Holdable, string> = {
  pistol: 'ЛКМ — огонь · R — перезарядка', shotgun: 'ЛКМ — выстрел дробью · R — перезарядка', rifle: 'ЛКМ — огонь · R — перезарядка',
  rocket: `ЛКМ — ракета: взрыв ${WEAPONS.rocket.radius} м · R — перезарядка`, grenade: 'ЛКМ — бросить гранату',
  hook: `ЛКМ — зацепиться (до ${HOOK.range} м) и подтянуться · ЛКМ или пробел — отпустить`,
  build: 'ЛКМ — строить · ПКМ — забрать свою постройку · Q/Z — материал', rod: 'ЛКМ — забросить в пруд, ЛКМ — подсечь',
  apple: `ЛКМ или F — съесть (+${ITEMS.apple.heal}) · G — бросить`, fish: `ЛКМ — съесть (+${ITEMS.fish.heal}) · G — бросить`,
  bottle: `ЛКМ или G — бросить: разбивается, оглушает на ${THROW.stun} с`, medkit: 'ЛКМ — вылечиться полностью · G — бросить',
};

/**
 * What is in the hands: the hotbar (1–9, Q), using the held item (LMB: eat, heal, throw a bottle), throwing (G),
 * and the inventory window (I) where the slots are arranged with the cursor.
 */
export class Hands {
  readonly bar = new Hotbar();
  /** Put away: bare fists even though the selected slot holds something (press its key again). */
  bare = false;
  /** Inventory window open. */
  invOpen = false;
  private useT = 0;
  /** Picked up in the inventory window, waiting to be put somewhere. */
  private carry: SlotRef | null = null;
  private readonly hotbarEl = $('hotbar');
  private readonly invEl = $('inv');
  private hotbarKey = '';
  private invKey = '';
  /** Inventory cell under the cursor (number keys move it to that hotbar slot). */
  hovered: SlotRef | null = null;
  /** Colliders the grappling hook can bite (not people). */
  hookFilter: ((c: { handle: number }) => boolean) | undefined;
  /** The hook was thrown / let go (sound, viewmodel). */
  onHook: (thrown: boolean) => void = () => {};
  private fireWas = false;

  constructor(private eco: Economy, private player: PlayerCombat, private build: BlockController, private pockets: Pockets,
    private throws: Throws, private sim: PlayerSim, private audio: GameAudio, private hud: Hud, private viewModel: ViewModel,
    private cursor: Cursor) {}

  /** Thing in hand (null = fists). */
  get held(): Holdable | null {
    return this.bare ? null : this.bar.held;
  }

  /** The pocket item in hand, if any (LMB uses it instead of a weapon). */
  get item() {
    const h = this.held;
    return isItem(h) ? h : null;
  }

  /** Key 1–9: that slot; the same key again puts it away (fists). */
  select(i: number) {
    if (i === this.bar.sel && this.bar.bar[i]) this.bare = !this.bare;
    else { this.bar.sel = i; this.bare = false; }
    this.audio.select();
  }

  cycle(step: 1 | -1) {
    this.bar.cycle(step);
    this.bare = false;
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
    camera.getWorldDirection(_dir);
    this.throws.throw(id, 0, camera.position, _dir, this.sim.state.vel, this.sim.gravityDown());
    this.viewModel.toss();
    this.audio.toss();
  }

  /** LMB with an item in hand. */
  private use(camera: PerspectiveCamera) {
    const id = this.item;
    if (!id || this.useT > 0) return;
    if (id === 'bottle') { this.toss(id, camera); return; }
    if (this.pockets.consume(id)) this.useT = 0.5;
  }

  toggleInventory() {
    this.invOpen = !this.invOpen;
    this.carry = null;
    if (this.invOpen) this.cursor.open();
    else this.cursor.close();
    this.audio.select();
  }

  /** Number key over an inventory cell: swap it with that hotbar slot. */
  assign(n: number) {
    if (!this.hovered) return;
    if (this.hovered.where === 'bar' && this.hovered.i === n) return;
    this.bar.swap(this.hovered, { where: 'bar', i: n });
    this.carry = null;
    this.audio.select();
  }

  /**
   * Per frame. `fire`: LMB is held in play (no panel open). `click`: the element clicked with the cursor this frame.
   */
  update(dt: number, camera: PerspectiveCamera, fire: boolean, click: HTMLElement | null) {
    this.useT = Math.max(0, this.useT - dt);
    this.bar.sync(holdables(this.eco));
    const h = this.held;
    // hands: weapons through the weapon state; build tool, rod and items instead of it
    this.build.active = h === 'build';
    this.pockets.setRod(h === 'rod');
    const weapon = isHeldGun(h) || h === 'grenade' ? h : h === null ? 'fists' : null;
    if (weapon && this.player.weapons.current !== weapon) this.player.pendingSelect = weapon;
    if (fire && isItem(h)) this.use(camera);
    // grappling hook: a click throws it, a click while it pulls lets go
    const pressed = fire && !this.fireWas;
    this.fireWas = fire;
    if (h !== 'hook' && this.sim.hook?.phase === 'pull') this.sim.releaseHook();
    if (h === 'hook' && pressed && this.player.me.alive) {
      if (this.sim.hook?.phase === 'pull') { this.sim.releaseHook(); this.onHook(false); }
      else if (this.sim.throwHook(camera.position, camera.getWorldDirection(_dir), this.hookFilter)) this.onHook(true);
    }
    this.viewModel.setTool(this.tool);
    this.renderHotbar();
    if (this.invOpen) this.renderInventory(click);
    this.invEl.hidden = !this.invOpen;
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

  private renderInventory(click: HTMLElement | null) {
    if (click) {
      const act = click.dataset.act;
      if (act === 'close') { this.toggleInventory(); return; }
      if (act === 'cell') {
        const ref: SlotRef = { where: click.dataset.where as SlotRef['where'], i: Number(click.dataset.i) };
        if (!this.carry) { if (this.bar.get(ref)) this.carry = ref; }
        else {
          if (this.carry.where !== ref.where || this.carry.i !== ref.i) this.bar.swap(this.carry, ref);
          this.carry = null;
        }
        this.audio.select();
      }
    }
    const t = this.cursor.target;
    this.hovered = t?.dataset.act === 'cell' ? { where: t.dataset.where as SlotRef['where'], i: Number(t.dataset.i) } : null;
    const hov = this.hovered ? this.bar.get(this.hovered) : null;
    const show = this.carry ? this.bar.get(this.carry) : hov;
    const ws = this.eco.weapons;
    const key = [...this.bar.bar, '|', ...this.bar.pack, this.carry?.where, this.carry?.i, show, ...this.bar.bar.map((h) => h && this.count(h)),
      ...this.bar.pack.map((h) => h && this.count(h)), this.eco.wallet.cash, ...Object.values(this.eco.blocks.inventory)].join();
    if (key === this.invKey) return;
    this.invKey = key;
    const grid = (where: SlotRef['where']) => (where === 'bar' ? this.bar.bar : this.bar.pack).map((h, i) => {
      const carried = this.carry?.where === where && this.carry.i === i;
      const k = where === 'bar' ? `<kbd>${i + 1}</kbd>` : '';
      return `<div class="cell${h ? '' : ' empty'}${carried ? ' carry' : ''}" data-act="cell" data-where="${where}" data-i="${i}">${k}${this.cell(h)}</div>`;
    }).join('');
    let info = '<p class="dim">Наведи на предмет</p>';
    if (show) {
      const n = this.count(show);
      const ammo = isHeldGun(show) && isGun(show) ? `в магазине ${ws.ammo[show]} из ${WEAPONS[show].mag}, запас ${ws.reserve[show]}`
        : show === 'build' ? Object.entries(this.eco.blocks.inventory).map(([m, c]) => `${m === 'wood' ? 'дерево' : m === 'stone' ? 'камень' : 'металл'} ${c}`).join(' · ')
          : n !== null ? `${n} шт.${isItem(show) && ITEMS[show].sell ? ` · продаётся по ${ITEMS[show].sell}` : ''}` : '';
      info = `<h4>${icon(HOLD_ICON[show])}${HOLD_NAME[show]}</h4>${ammo ? `<p class="dim">${ammo}</p>` : ''}<p>${HOLD_USE[show]}</p>`;
    }
    this.invEl.innerHTML = `<h3>Инвентарь<button class="x" data-act="close" title="Закрыть (I)">×</button></h3>`
      + `<div class="cols"><div><h5>Рюкзак</h5><div class="grid">${grid('pack')}</div>`
      + `<h5>Пояс</h5><div class="grid bar">${grid('bar')}</div></div><aside>${info}</aside></div>`
      + `<footer>Клик — взять, клик по другой ячейке — положить · наведи и нажми <kbd>1</kbd>–<kbd>${HOTBAR_SIZE}</kbd> — на пояс · <kbd>I</kbd> закрыть</footer>`;
  }
}
