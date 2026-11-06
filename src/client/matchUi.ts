import { BLOCK_MATERIALS } from '../shared/blocks';
import { CURRENCY_LABEL, Economy, ITEM_ORDER, ITEMS, ShopItem, ShopOffer, STEP_LABEL } from '../shared/economy';
import { Bed, Match, MatchEvent } from '../shared/match';
import { getTeam, TEAMS } from '../shared/teams';
import { WEAPONS } from '../shared/weapons';
import type { GameAudio } from './audio';
import { Hud, teamHex } from './hud';
import { icon, IconName } from './icons';
import { formatTime } from './stats';

const $ = (id: string) => document.getElementById(id)!;


export type ShopTab = 'buy' | 'sell';

const ITEM_ICON: Record<string, IconName> = { bottle: 'bottle', apple: 'apple', fish: 'fish' };

function shopIcon(item: ShopItem): string {
  if (item.kind === 'blocks') return icon(item.material);
  if (item.kind === 'ammo') return icon('ammo');
  if (item.kind === 'heal') return icon('heart');
  if (item.kind === 'weapon') return icon(item.weapon === 'grenade' ? 'grenade' : item.weapon === 'pistol' ? 'pistol' : 'rifle');
  return icon(item.id === 'rod' ? 'rod' : 'shovel');
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

  constructor(private match: Match, private eco: Economy, private hud: Hud, private audio: GameAudio, private heal: () => boolean) {}

  toggleShop() {
    this.shopOpen = !this.shopOpen;
    if (this.shopOpen) this.tab = this.eco.sellValue > 0 ? 'sell' : 'buy';
    this.audio.select();
  }

  switchTab() {
    this.tab = this.tab === 'buy' ? 'sell' : 'buy';
    this.audio.select();
  }

  /** Buyable offers in key order (locked teasers get no key). */
  private buyable(): ShopOffer[] {
    return this.eco.offers().filter((o) => o.state !== 'locked');
  }

  /** Number key n (1-based) in the open tab. */
  choose(n: number) {
    if (this.tab === 'sell') this.sell(n);
    else this.buy(n);
  }

  private buy(n: number) {
    const offer = this.buyable()[n - 1];
    if (!offer) return;
    const item = offer.item;
    if (item.kind === 'heal' && this.eco.wallet[item.currency] >= item.price && !this.heal()) {
      this.audio.reject();
      this.hud.toast('Здоровье и так полное', '#ffb49e', 1);
      return;
    }
    const r = this.eco.buy(item);
    if (r === 'ok') {
      this.audio.coins();
      this.hud.toast(`Куплено: ${item.label}`, '#c6ffdb', 1.2);
    } else {
      this.audio.reject();
      this.hud.toast(r === 'full' ? 'Больше не унести' : `Не хватает: ${CURRENCY_LABEL[item.currency]}`, '#ff8e83', 1);
    }
  }

  private sell(n: number) {
    const id = ITEM_ORDER[n - 1];
    const got = id ? this.eco.sell(id) : n === ITEM_ORDER.length + 1 ? this.eco.sellAll() : 0;
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
    else if (e.type === 'bedBroken') {
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

  /** `extraPrompt`: interaction hint from elsewhere (pick up an item, fishing). */
  update(nearShop: boolean, reachable: Bed | null, extraPrompt = '') {
    const m = this.match;
    if (this.shopOpen && !nearShop) this.shopOpen = false;

    this.wallet.innerHTML = `<span class="cash" title="Деньги">${icon('coins')}${m.wallet.cash}</span>`
      + (m.wallet.crystal ? `<span class="crystal" title="Кристаллы">${icon('crystal')}${m.wallet.crystal}</span>` : '')
      + `<span class="time">${formatTime(m.time)}</span>`;

    const key = m.beds.map((b) => `${+b.alive}${m.membersAlive(b.team)}${+m.isOut(b.team)}`).join('');
    if (key !== this.bedsKey) {
      this.bedsKey = key;
      this.bedsEl.innerHTML = TEAMS.map((t) => {
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
    if (m.breaking) prompt = `Ломаешь кристалл: ${getTeam(m.breaking.bed.team).name}`;
    else if (reachable) prompt = `<b>E</b> держи — сломать кристалл (${getTeam(reachable.team).name})`;
    else if (nearShop && !this.shopOpen) prompt = '<b>E</b> магазин';
    else if (!this.shopOpen) prompt = extraPrompt;
    this.prompt.innerHTML = prompt;
    this.prompt.style.opacity = prompt ? '1' : '0';
    this.breakEl.style.opacity = m.breaking ? '1' : '0';
    this.breakBar.style.width = `${(m.breaking?.progress ?? 0) * 100}%`;

    this.shopEl.hidden = !this.shopOpen;
    if (this.shopOpen) this.renderShop();
  }

  private renderShop() {
    const eco = this.eco;
    const ws = eco.weapons;
    const offers = this.tab === 'buy' ? eco.offers() : [];
    const key = [this.tab, eco.wallet.cash, eco.wallet.crystal, ...ITEM_ORDER.map((i) => eco.items[i]), offers.map((o) => o.item.id + o.state).join(),
      ws.reserve.pistol, ws.reserve.rifle, ws.ammo.grenade, ...Object.values(eco.blocks.inventory)].join('|');
    if (key === this.shopKey) return;
    this.shopKey = key;
    const tabs = `<nav><span class="${this.tab === 'buy' ? 'on' : ''}">Купить</span><span class="${this.tab === 'sell' ? 'on' : ''}">Продать</span></nav>`;
    const head = `<h3>${icon('shop')}Магазин${tabs}</h3>`;
    const foot = `<footer><kbd>Q</kbd> вкладка<kbd>1</kbd>–<kbd>9</kbd> выбрать<kbd>E</kbd> закрыть</footer>`;
    let rows = '';
    if (this.tab === 'buy') {
      let n = 0;
      rows = offers.map(({ item, state }) => {
        const locked = state === 'locked';
        const k = locked ? `<kbd class="lock"></kbd>` : `<kbd>${++n}</kbd>`;
        let have = '';
        if (item.kind === 'blocks') have = `есть ${eco.blocks.inventory[item.material]}`;
        else if (item.kind === 'ammo') have = `запас ${ws.reserve[item.weapon]}`;
        else if (item.kind === 'weapon' && item.weapon === 'grenade') have = `есть ${ws.ammo.grenade} из ${WEAPONS.grenade.mag}`;
        const note = locked ? `откроется после: ${STEP_LABEL[item.needs!].toLowerCase()}` : have || item.note;
        const look = item.kind === 'blocks' ? `style="--c:#${BLOCK_MATERIALS[item.material].color.toString(16).padStart(6, '0')}"` : '';
        const cur = icon(item.currency === 'cash' ? 'coins' : 'crystal');
        return `<div class="item${state === 'money' ? ' poor' : ''}${locked ? ' locked' : ''}" ${look}>${k}${shopIcon(item)}<span class="label">${item.label}`
          + `${note ? `<em>${note}</em>` : ''}</span><span class="price ${item.currency}">${cur}${item.price}</span></div>`;
      }).join('');
    } else {
      rows = ITEM_ORDER.map((id, i) => {
        const n = eco.items[id];
        return `<div class="item${n ? '' : ' poor'}"><kbd>${i + 1}</kbd>${icon(ITEM_ICON[id])}<span class="label">${ITEMS[id].plural}`
          + `<em>${n} шт. · по ${ITEMS[id].sell}</em></span><span class="price cash">+${n * ITEMS[id].sell}</span></div>`;
      }).join('') + `<div class="item total${eco.sellValue ? '' : ' poor'}"><kbd>${ITEM_ORDER.length + 1}</kbd><span class="label">Продать всё</span>`
        + `<span class="price cash">${icon('coins')}+${eco.sellValue}</span></div>`;
    }
    this.shopEl.innerHTML = head + rows + foot;
  }
}
