import { Vector3 } from 'three';
import { BLOCK_ORDER } from '../shared/blocks';
import { Economy, ITEMS, Pickups } from '../shared/economy';
import { Holdable, holdables, SlotRef } from '../shared/inventory';
import { upOf } from '../shared/math';
import type { PlayerSim } from '../shared/sim';
import { isGun, WEAPONS, WeaponId } from '../shared/weapons';
import type { GameAudio } from './audio';
import type { Cursor } from './cursor';
import type { Hands } from './hands';
import { HOLD_ICON, HOLD_NAME, HOLD_USE } from './hands';
import type { Hud } from './hud';
import { icon } from './icons';

const _fwd = new Vector3();

/**
 * Interactive inventory modal (`I`): 9-slot hotbar + 9-slot backpack.
 * Lets the player reorder slots by clicking, inspect detailed stats of the selected item/weapon, and drop items.
 */
export class InventoryUi {
  open = false;
  private readonly el = document.getElementById('inv')!;
  private carrying: SlotRef | null = null;
  private selected: SlotRef | null = null;
  private lastGridKey = '';
  private lastAsideKey = '';
  private domReady = false;
  private barCells: HTMLButtonElement[] = [];
  private packCells: HTMLButtonElement[] = [];
  private asideEl: HTMLElement | null = null;
  onDropRemote?: (holdable: Holdable, dir: Vector3) => void;

  constructor(
    private eco: Economy,
    private hands: Hands,
    private cursor: Cursor,
    private audio: GameAudio,
    private hud: Hud,
    private sim: PlayerSim,
    private pickups: Pickups,
  ) {}

  toggle(closeShop?: () => void) {
    if (!this.open && closeShop) closeShop();
    this.open = !this.open;
    this.hands.invOpen = this.open;
    this.carrying = null;
    if (this.open) {
      this.cursor.open();
      if (!this.selected) this.selected = { where: 'bar', i: this.hands.bar.sel };
      this.lastGridKey = '';
      this.lastAsideKey = '';
      this.render();
    } else {
      this.cursor.close();
      this.el.hidden = true;
    }
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.hands.invOpen = false;
    this.carrying = null;
    this.cursor.close();
    this.el.hidden = true;
  }

  update(click: HTMLElement | null, camForward: Vector3) {
    this.el.hidden = !this.open;
    if (!this.open) return;
    this.hands.bar.sync(holdables(this.eco));
    if (click) this.onClick(click, camForward);
    this.render();
  }

  private onClick(el: HTMLElement, camForward: Vector3) {
    const act = el.dataset.act;
    if (act === 'slot') {
      const where = el.dataset.where === 'pack' ? 'pack' : 'bar';
      const i = Number(el.dataset.i);
      if (Number.isNaN(i)) return;
      const ref: SlotRef = { where, i };
      if (!this.carrying) {
        this.selected = ref;
        if (this.hands.bar.get(ref)) {
          this.carrying = ref;
          this.audio.select();
        }
      } else {
        if (this.carrying.where !== ref.where || this.carrying.i !== ref.i) {
          this.hands.bar.swap(this.carrying, ref);
          this.audio.place();
        } else {
          this.audio.select();
        }
        this.carrying = null;
        this.selected = ref;
      }
      this.lastGridKey = '';
      this.lastAsideKey = '';
    } else if (act === 'drop') {
      this.dropSelected(camForward);
    } else if (act === 'close-inv') {
      this.close();
    }
  }

  dropSelected(camForward: Vector3) {
    const ref = this.carrying ?? this.selected;
    const h = ref ? this.hands.bar.get(ref) : null;
    if (!h) {
      this.audio.reject();
      return;
    }
    if (h === 'build') {
      this.audio.reject();
      this.hud.toast('Лопату стройки нельзя выбросить', '#ffb49e', 1.1);
      return;
    }
    if (this.onDropRemote) {
      this.onDropRemote(h, camForward);
      this.carrying = null;
      this.audio.toss();
      this.lastGridKey = '';
      this.lastAsideKey = '';
      return;
    }
    const res = this.eco.dropFromSlot(h);
    if (!res) {
      this.audio.reject();
      this.hud.toast('Нечего выбрасывать', '#ffb49e', 1);
      return;
    }
    const up = upOf(this.sim.state.frame);
    const dropPos = this.sim.state.pos.clone().addScaledVector(_fwd.copy(camForward).normalize(), 1.5);
    this.pickups.drop(res.kind, dropPos, up, res.amount);
    this.hands.bar.sync(holdables(this.eco));
    this.carrying = null;
    this.audio.toss();
    this.hud.toast(`Выброшено: ${HOLD_NAME[h]}`, '#d8e8ff', 1.1);
    this.lastGridKey = '';
    this.lastAsideKey = '';
  }

  private count(h: Holdable): number | null {
    const ws = this.eco.weapons;
    if (h in this.eco.items) return this.eco.items[h as keyof typeof this.eco.items];
    if (h === 'grenade') return ws.ammo.grenade;
    if (isGun(h as WeaponId)) {
      const w = h as WeaponId;
      return ws.ammo[w] + ws.reserve[w];
    }
    return null;
  }

  private statsHtml(h: Holdable | null): string {
    if (!h) {
      return `<h4>Пустой слот</h4><p class="dim">Кликни по предмету, затем по любому слоту пояса или рюкзака, чтобы поменять местами.</p>`;
    }
    const rows: [string, string][] = [];
    if (isGun(h as WeaponId)) {
      const w = WEAPONS[h as WeaponId];
      const ws = this.eco.weapons;
      rows.push(['Урон', String(w.damage)]);
      rows.push(['Скорость пули', `${w.speed} м/с`]);
      rows.push(['Магазин / Запас', `${ws.ammo[w.id]} / ${ws.reserve[w.id]}`]);
      rows.push(['Темп / Задержка', `${w.interval.toFixed(2)} с`]);
      rows.push(['Перезарядка', `${w.reload.toFixed(2)} с`]);
      if (w.id === 'revolver') rows.push(['Особенность', 'Рикошет 20 HP по живым целям']);
      if (w.id === 'crossbow') rows.push(['Заряд', '0–3 ур., пробитие со 2-го ур.']);
      if (w.id === 'shotgun') rows.push(['Дробь', `${w.pellets} дробин за выстрел`]);
      if (w.id === 'rocket') rows.push(['Взрыв', `радиус ${w.radius} м · 50% по кристаллу`]);
    } else if (h === 'grenade') {
      const w = WEAPONS.grenade;
      rows.push(['Штук с собой', `${this.eco.weapons.ammo.grenade} / ${w.mag}`]);
      rows.push(['Макс. урон', String(w.damage)]);
      rows.push(['Радиус взрыва', `${w.radius} м`]);
    } else if (h in ITEMS) {
      const it = ITEMS[h as keyof typeof ITEMS];
      rows.push(['Количество', String(this.eco.items[h as keyof typeof this.eco.items])]);
      if (it.heal) rows.push(['Восстановление', `+${it.heal} HP`]);
      if (h === 'bottle') rows.push(['Эффект', 'Оглушает NPC при попадании']);
    } else if (h === 'build') {
      const inv = this.eco.blocks.inventory;
      rows.push(['Дерево / Камень / Металл', `${inv.wood} / ${inv.stone} / ${inv.metal}`]);
    } else if (h === 'hook') {
      rows.push(['Дальность', '35 м']);
    } else if (h === 'rod') {
      rows.push(['Применение', 'Рыбалка в прудах и фонтанах']);
    }
    const equip: string[] = [];
    if (this.eco.has('armor')) equip.push('Бронежилет (спасёт от смерти)');
    if (this.eco.has('jetpack')) equip.push('Реактивный ранец (топливо: патроны)');
    const eqHtml = equip.length ? `<p class="dim" style="margin-top:8px">Снаряжение: ${equip.join(' · ')}</p>` : '';
    const dropBtn = h !== 'build' ? `<button class="drop-btn" data-act="drop">Выкинуть</button>` : '';
    return `<h4>${icon(HOLD_ICON[h])}<span>${HOLD_NAME[h]}</span></h4>`
      + `<p class="dim">${HOLD_USE[h]}</p>`
      + `<dl class="stat-list">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`
      + eqHtml
      + dropBtn;
  }

  private ensureDom() {
    if (this.domReady) return;
    this.domReady = true;
    const makeGrid = (where: 'bar' | 'pack', target: HTMLButtonElement[]) =>
      Array.from({ length: 9 }, (_, i) => {
        const kbd = where === 'bar' ? `<kbd>${i + 1}</kbd>` : '';
        return `<button class="cell empty" data-act="slot" data-where="${where}" data-i="${i}">${kbd}<span class="slot-body"></span></button>`;
      }).join('');
    this.el.innerHTML =
      `<h3>Инвентарь<small style="font-size:12px;color:var(--muted);font-weight:500">Пояс 1–9 и рюкзак</small></h3>`
      + `<div class="cols">`
      + `<div><div class="dim" style="font-size:11px;margin-bottom:4px">Быстрый пояс (1–9)</div><div class="grid bar">${makeGrid('bar', this.barCells)}</div>`
      + `<div class="dim" style="font-size:11px;margin-bottom:4px">Рюкзак</div><div class="grid pack">${makeGrid('pack', this.packCells)}</div></div>`
      + `<aside></aside>`
      + `</div>`
      + `<footer><kbd>ЛКМ по слоту</kbd><span>взять / поменять</span><kbd style="margin-left:10px">I</kbd><span>закрыть</span></footer>`;
    this.barCells = [...this.el.querySelectorAll<HTMLButtonElement>('.grid.bar .cell')];
    this.packCells = [...this.el.querySelectorAll<HTMLButtonElement>('.grid.pack .cell')];
    this.asideEl = this.el.querySelector('aside');
  }

  private render() {
    this.ensureDom();
    const b = this.hands.bar;
    const hoverEl = this.cursor.target;
    const hWhere = hoverEl?.dataset.act === 'slot' ? (hoverEl.dataset.where === 'pack' ? 'pack' : 'bar') : null;
    const hIdx = hoverEl?.dataset.act === 'slot' ? Number(hoverEl.dataset.i) : -1;
    const activeRef: SlotRef | null = hWhere && !Number.isNaN(hIdx) ? { where: hWhere, i: hIdx } : (this.carrying ?? this.selected);
    const matsKey = BLOCK_ORDER.map((m) => this.eco.blocks.inventory[m]).join(',');

    // Update fixed slot buttons ONLY when item contents / selection / carry change (never recreate buttons on hover!)
    const gridKey = [
      ...b.bar.map((h) => h && `${h}:${this.count(h)}`),
      '/',
      ...b.pack.map((h) => h && `${h}:${this.count(h)}`),
      this.carrying ? `c:${this.carrying.where}${this.carrying.i}` : '',
      this.selected ? `s:${this.selected.where}${this.selected.i}` : '',
    ].join('|');
    if (gridKey !== this.lastGridKey) {
      this.lastGridKey = gridKey;
      const syncCells = (where: 'bar' | 'pack', items: (Holdable | null)[], cells: HTMLButtonElement[]) => {
        for (let i = 0; i < cells.length; i++) {
          const btn = cells[i];
          const h = items[i];
          const cnt = h ? this.count(h) : null;
          btn.classList.toggle('empty', !h);
          btn.classList.toggle('carry', this.carrying?.where === where && this.carrying.i === i);
          btn.classList.toggle('sel', this.selected?.where === where && this.selected.i === i);
          const body = btn.querySelector('.slot-body')!;
          const nextBody = h ? `${icon(HOLD_ICON[h])}${cnt !== null ? `<b>${cnt}</b>` : ''}` : '';
          if (body.innerHTML !== nextBody) body.innerHTML = nextBody;
        }
      };
      syncCells('bar', b.bar, this.barCells);
      syncCells('pack', b.pack, this.packCells);
    }

    // Update fixed-size inspector panel ONLY when inspected item or stats change
    const inspectItem = activeRef ? b.get(activeRef) : null;
    const asideKey = `${inspectItem ?? 'empty'}|${inspectItem ? this.count(inspectItem) : ''}|${matsKey}|${this.eco.has('armor')}|${this.eco.has('jetpack')}`;
    if (asideKey !== this.lastAsideKey && this.asideEl) {
      this.lastAsideKey = asideKey;
      this.asideEl.innerHTML = this.statsHtml(inspectItem);
    }
  }
}
