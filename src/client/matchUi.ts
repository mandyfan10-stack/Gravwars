import { BLOCK_MATERIALS } from '../shared/blocks';
import { CURRENCY_LABEL, Economy, ITEMS, MAX_MEDKITS, SELLABLE, SHOP_GROUPS, ShopItem, shopGroup } from '../shared/economy';
import { Bed, BED_HP, Match, MatchEvent } from '../shared/match';
import { CRYSTAL } from '../shared/combat';
import { getTeam, TEAMS } from '../shared/teams';
import { WEAPONS } from '../shared/weapons';
import type { GameAudio } from './audio';
import type { Cursor } from './cursor';
import { Hud, teamHex } from './hud';
import { icon, IconName } from './icons';
import { formatTime } from './stats';

const $ = (id: string) => document.getElementById(id)!;


export type ShopTab = 'buy' | 'sell';

const ITEM_ICON: Record<string, IconName> = { bottle: 'bottle', apple: 'apple', fish: 'fish', medkit: 'heart' };

function shopIcon(item: ShopItem): string {
  if (item.kind === 'blocks') return icon(item.material);
  if (item.kind === 'ammo') return icon('ammo');
  if (item.kind === 'item') return icon(ITEM_ICON[item.item]);
  if (item.kind === 'weapon') return icon(item.weapon === 'fists' ? 'rifle' : item.weapon);
  return icon(item.id === 'rod' ? 'rod' : item.id === 'hook' ? 'hook' : 'shovel');
}

/** Bedwars UI: wallet, bed status row, interaction prompt, bed-break progress, shop (buy / sell), result banner. */
export class MatchUi {
  shopOpen = false;
  tab: ShopTab = 'buy';
  private readonly wallet = $('wallet');
  private readonly bedsEl = $('beds');
  private readonly prompt = $('prompt');
  private readonly breakEl = $('bed-break');
  private readonly breakBar = $('bed-break').firstElementChild as HTMLElement;
  private readonly shopEl = $('shop');
  private readonly resultEl = $('result');
  private bedsKey = '';
  private shopKey = '';
  /** When the "your crystal is under attack" warning last went off (it repeats at most every few seconds). */
  private alarmAt = -1e9;
  /** The crystal you hit last and when (its HP bar stays up for a moment after). */
  private hitBed: Bed | null = null;
  private hitAt = -1e9;

  constructor(private match: Match, private eco: Economy, private hud: Hud, private audio: GameAudio, private cursor: Cursor) {}

  toggleShop() {
    this.shopOpen = !this.shopOpen;
    if (this.shopOpen) {
      this.tab = this.eco.sellValue > 0 ? 'sell' : 'buy';
      this.cursor.open();
    } else this.cursor.close();
    this.shopKey = '';
    this.audio.select();
  }

  switchTab() {
    this.tab = this.tab === 'buy' ? 'sell' : 'buy';
    this.audio.select();
  }

  /** A click in the shop window. */
  private click(el: HTMLElement) {
    const { act, id } = el.dataset;
    if (act === 'close') this.toggleShop();
    else if (act === 'tab') { if (id !== this.tab) this.switchTab(); }
    else if (act === 'buy') this.buy(id!);
    else if (act === 'sell') this.sell(id!);
  }

  private buy(id: string) {
    const offer = this.eco.offers().find((o) => o.item.id === id);
    if (!offer) return;
    const item = offer.item;
    const r = this.eco.buy(item);
    if (r === 'ok') {
      this.audio.coins();
      this.hud.toast(`Куплено: ${item.label}`, '#c6ffdb', 1.2);
    } else {
      this.audio.reject();
      this.hud.toast(r === 'full' ? 'Больше не унести' : `Не хватает: ${CURRENCY_LABEL[item.currency]}`, '#ff8e83', 1);
    }
  }

  private sell(id: string) {
    const got = id === 'all' ? this.eco.sellAll() : SELLABLE.includes(id as never) ? this.eco.sell(id as never) : 0;
    if (got > 0) {
      this.audio.coins();
      this.hud.toast(`Продано: +${got}`, '#c6ffdb', 1);
    } else {
      this.audio.reject();
      this.hud.toast('Нечего продавать', '#ffb49e', 1);
    }
  }

  /** Feedback for match events (the 3D side is handled by the caller). */
  onEvent(e: MatchEvent) {
    const name = (team: string) => {
      const t = getTeam(team as never);
      return `<span style="color:${teamHex(t.color)}">${t.name}</span>`;
    };
    if (e.type === 'pickup') this.audio.select();
    else if (e.type === 'bedHit') {
      const now = performance.now() / 1000;
      if (e.team === this.match.team && !e.byPlayer) {
        if (now - this.alarmAt > 6 && e.hp > 0) {
          this.alarmAt = now;
          this.hud.toast('Твой кристалл атакуют!', '#ff8e83', 1.6);
          this.audio.alarm();
        }
      } else if (e.byPlayer) {
        this.hitBed = this.match.bed(e.team);
        this.hitAt = now;
      }
    } else if (e.type === 'bedBroken') {
      this.hud.killfeed(e.team === this.match.team ? 'Твой кристалл разрушен!' : `Кристалл: ${name(e.team)} — разрушен`);
      this.hud.toast(e.team === this.match.team ? 'Кристалл потерян — смерть станет последней' : `Кристалл разрушен · осталось ${this.match.enemiesLeft}`,
        e.team === this.match.team ? '#ff6b6b' : '#ffe08a', 2.2);
    } else if (e.type === 'win') this.showResult(`${icon('trophy')}Победа<small>Все команды врагов уничтожены за ${formatTime(e.time)}</small>`, '#ffd23b');
    else if (e.type === 'lose') this.showResult(`${icon('skull')}Выбыл<small>Кристалла больше нет — это была последняя жизнь</small>`, '#ff6b6b');
  }

  private showResult(html: string, color: string) {
    this.resultEl.innerHTML = html;
    this.resultEl.style.color = '#fff';
    (this.resultEl.firstElementChild as SVGElement | null)?.style.setProperty('color', color);
    this.resultEl.classList.add('show');
  }

  /**
   * `sight`: the enemy crystal under the crosshair; `extraPrompt`: interaction hint from elsewhere (pick up an item,
   * fishing); `click`: cursor click this frame.
   */
  update(nearShop: boolean, sight: { bed: Bed; dist: number } | null, extraPrompt = '', click: HTMLElement | null = null) {
    const m = this.match;
    if (this.shopOpen && !nearShop) this.toggleShop();
    if (this.shopOpen && click) this.click(click);

    this.wallet.innerHTML = `<span class="cash" title="Деньги">${icon('coins')}${m.wallet.cash}</span>`
      + (m.wallet.crystal ? `<span class="crystal" title="Кристаллы">${icon('crystal')}${m.wallet.crystal}</span>` : '')
      + `<span class="time">${formatTime(m.time)}</span>`;

    const key = m.beds.map((b) => `${+b.alive}${m.membersAlive(b.team)}${+m.isOut(b.team)}`).join('');
    if (key !== this.bedsKey) {
      this.bedsKey = key;
      this.bedsEl.innerHTML = TEAMS.filter((t) => m.beds.some((b) => b.team === t.id)).map((t) => {
        const bed = m.bed(t.id);
        const mine = t.id === m.team ? ' mine' : '';
        const out = m.isOut(t.id);
        // without a crystal the team lives as long as its members: show how many are left
        const inner = out ? icon('skull') : bed.alive ? icon('crystal') : `${icon('crystal')}<b>${m.membersAlive(t.id)}</b>`;
        const state = out ? 'выбыли' : bed.alive ? 'кристалл цел' : `кристалл сломан, бойцов: ${m.membersAlive(t.id)}`;
        return `<span class="bed${bed.alive ? '' : ' dead'}${out ? ' out' : ''}${mine}" style="--c:${teamHex(t.color)}" title="${t.name}: ${state}">${inner}</span>`;
      }).join('') + `<span class="goal">врагов<b>${m.enemiesLeft}</b></span>`;
    }

    let prompt = '';
    const near = sight && sight.dist <= CRYSTAL.range;
    if (sight && !this.shopOpen && sight.dist < 20) {
      const name = getTeam(sight.bed.team).name;
      prompt = near ? `Кристалл: ${name} — стреляй или бей` : `Кристалл: ${name} — подойди ближе, ломается только с ${CRYSTAL.range} м`;
    } else if (nearShop && !this.shopOpen) prompt = '<b>E</b> магазин';
    else if (!this.shopOpen) prompt = extraPrompt;
    this.prompt.innerHTML = prompt;
    this.prompt.style.opacity = prompt ? '1' : '0';
    // HP bar of the crystal you aim at within reach (or hit a moment ago)
    const recent = performance.now() / 1000 - this.hitAt < 2.5 ? this.hitBed : null;
    const bar = near ? sight!.bed : recent && sight?.bed === recent ? recent : null;
    const show = !!bar && bar.alive;
    this.breakEl.style.opacity = show ? '1' : '0';
    if (show) {
      this.breakBar.style.width = `${(bar!.hp / BED_HP) * 100}%`;
      this.breakBar.style.background = teamHex(getTeam(bar!.team).color);
    }

    this.shopEl.hidden = !this.shopOpen;
    if (this.shopOpen) this.renderShop();
  }

  private renderShop() {
    const eco = this.eco;
    const ws = eco.weapons;
    const offers = this.tab === 'buy' ? eco.offers() : [];
    const key = [this.tab, eco.wallet.cash, eco.wallet.crystal, ...SELLABLE.map((i) => eco.items[i]), eco.items.medkit, offers.map((o) => o.item.id + o.state).join(),
      ...Object.values(ws.reserve), ws.ammo.grenade, eco.has('hook'), ...Object.values(eco.blocks.inventory)].join('|');
    if (key === this.shopKey) return;
    this.shopKey = key;
    const tab = (id: ShopTab, label: string) => `<button class="${this.tab === id ? 'on' : ''}" data-act="tab" data-id="${id}">${label}</button>`;
    const money = `<span class="money"><span class="cash">${icon('coins')}${eco.wallet.cash}</span>`
      + `<span class="crystal">${icon('crystal')}${eco.wallet.crystal}</span></span>`;
    const head = `<h3>${icon('shop')}Магазин<nav>${tab('buy', 'Купить')}${tab('sell', 'Продать')}</nav>${money}`
      + `<button class="x" data-act="close" title="Закрыть (E)">×</button></h3>`;
    let body = '';
    if (this.tab === 'buy') {
      body = '<div class="groups">' + SHOP_GROUPS.map((g) => {
        const cards = offers.filter((o) => shopGroup(o.item) === g.id).map(({ item, state }) => {
          let have = '';
          if (item.kind === 'blocks') have = `есть ${eco.blocks.inventory[item.material]}`;
          else if (item.kind === 'ammo') have = ws.owned[item.weapon] ? `запас ${ws.reserve[item.weapon]}` : 'сначала нужно оружие';
          else if (item.kind === 'weapon' && item.weapon === 'grenade') have = `есть ${ws.ammo.grenade} из ${WEAPONS.grenade.mag}`;
          else if (item.kind === 'item' && item.item === 'medkit') have = `есть ${eco.items.medkit} из ${MAX_MEDKITS}`;
          const note = [item.note, have].filter(Boolean).join(' · ');
          const look = item.kind === 'blocks' ? `style="--c:#${BLOCK_MATERIALS[item.material].color.toString(16).padStart(6, '0')}"` : '';
          const cur = icon(item.currency === 'cash' ? 'coins' : 'crystal');
          return `<div class="card${state === 'money' ? ' poor' : ''}" data-act="buy" data-id="${item.id}" ${look}>${shopIcon(item)}`
            + `<span class="label">${item.label}${note ? `<em>${note}</em>` : ''}</span><span class="price ${item.currency}">${cur}${item.price}</span></div>`;
        }).join('');
        return cards ? `<section><h5>${g.label}</h5>${cards}</section>` : '';
      }).join('') + '</div>';
    } else {
      body = '<div class="sell">' + SELLABLE.map((id) => {
        const n = eco.items[id];
        return `<div class="card${n ? '' : ' poor'}" data-act="sell" data-id="${id}">${icon(ITEM_ICON[id])}<span class="label">${ITEMS[id].plural}`
          + `<em>${n} шт. · по ${ITEMS[id].sell}</em></span><span class="price cash">+${n * ITEMS[id].sell}</span></div>`;
      }).join('') + `<div class="card total${eco.sellValue ? '' : ' poor'}" data-act="sell" data-id="all"><span class="label">Продать всё</span>`
        + `<span class="price cash">${icon('coins')}+${eco.sellValue}</span></div></div>`;
    }
    const foot = `<footer>${this.tab === 'buy' ? 'Клик — купить' : 'Клик — продать'}<kbd>Q</kbd> вкладка<kbd>E</kbd> закрыть</footer>`;
    this.shopEl.className = `panel ${this.tab}`;
    this.shopEl.innerHTML = head + body + foot;
  }
}
