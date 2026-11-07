import { BLOCK_MATERIALS } from '../shared/blocks';
import { CURRENCY_LABEL, Economy, ITEMS, MAX_MEDKITS, SELLABLE, SHOP, SHOP_ROWS, SHOP_SHORT, ShopItem } from '../shared/economy';
import { Bed, BED_HP, Match, MatchEvent } from '../shared/match';
import { CRYSTAL } from '../shared/combat';
import { getTeam, TEAMS } from '../shared/teams';
import { isGun, WEAPONS } from '../shared/weapons';
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

const SHOP_ITEM = new Map(SHOP.map((i) => [i.id, i]));
/** Russian plural: 1 монета, 2 монеты, 5 монет. */
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const lack = (n: number, cur: 'cash' | 'crystal') =>
  `Не хватает ${n} ${cur === 'cash' ? plural(n, 'монеты', 'монет', 'монет') : plural(n, 'кристалла', 'кристаллов', 'кристаллов')}`;

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
  /** Shop item whose details are shown (under the cursor), '' = none. */
  private shopHover = '-';
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

  /** Where an item stands for the player: tile class, the tile's status line, the details' verdict. */
  private itemState(item: ShopItem) {
    const eco = this.eco, ws = eco.weapons;
    const cur = eco.wallet[item.currency];
    let status = '';
    if (item.kind === 'weapon' && item.weapon === 'grenade') status = `есть ${ws.ammo.grenade} из ${WEAPONS.grenade.mag}`;
    else if (item.kind === 'weapon') {
      const w = WEAPONS[item.weapon];
      status = (w.pellets ?? 1) > 1 ? `${w.pellets} дробин` : w.radius ? `взрыв ${w.radius} м` : `магазин ${w.mag}`;
    } else if (item.kind === 'ammo') status = ws.owned[item.weapon] ? `запас ${ws.reserve[item.weapon]}` : 'нет оружия';
    else if (item.kind === 'blocks') status = `есть ${eco.blocks.inventory[item.material]}`;
    else if (item.kind === 'item' && item.item === 'medkit') status = `есть ${eco.items.medkit} из ${MAX_MEDKITS}`;
    else if (item.id === 'builder') status = item.note ?? '';
    else if (item.id === 'hook') status = 'до 30 м';
    else if (item.id === 'rod') status = 'рыбалка';
    const owned = item.step ? eco.has(item.step) : item.kind === 'weapon' && isGun(item.weapon) && ws.owned[item.weapon];
    if (owned) return { cls: 'owned', status: 'куплено', why: 'Уже есть' };
    const full = (item.kind === 'weapon' && item.weapon === 'grenade' && ws.ammo.grenade + item.count > WEAPONS.grenade.mag)
      || (item.kind === 'item' && item.item === 'medkit' && eco.items.medkit + item.count > MAX_MEDKITS);
    if (full) return { cls: 'full', status, why: 'Больше не унести' };
    if (cur < item.price) return { cls: 'poor', status, why: lack(item.price - cur, item.currency) };
    if (item.kind === 'ammo' && !ws.owned[item.weapon]) return { cls: 'na', status, why: `Клик — купить (${WEAPONS[item.weapon].name.toLowerCase()} ещё не куплен)` };
    return { cls: '', status, why: 'Клик — купить' };
  }

  private renderShop() {
    const eco = this.eco;
    const ws = eco.weapons;
    const key = [this.tab, eco.wallet.cash, eco.wallet.crystal, ...SELLABLE.map((i) => eco.items[i]), eco.items.medkit,
      ...Object.values(ws.owned), ...Object.values(ws.reserve), ws.ammo.grenade, eco.has('hook'), eco.has('rod'), eco.has('builder'),
      ...Object.values(eco.blocks.inventory)].join('|');
    if (key !== this.shopKey) {
      this.shopKey = key;
      this.shopHover = '-';
      const tab = (id: ShopTab, label: string) => `<button class="${this.tab === id ? 'on' : ''}" data-act="tab" data-id="${id}">${label}</button>`;
      const money = `<span class="money"><span class="cash">${icon('coins')}${eco.wallet.cash}</span>`
        + `<span class="crystal">${icon('crystal')}${eco.wallet.crystal}</span></span>`;
      const head = `<h3>${icon('shop')}Магазин<nav>${tab('buy', 'Купить')}${tab('sell', 'Продать')}</nav>${money}`
        + `<button class="x" data-act="close" title="Закрыть (E)">×</button></h3>`;
      const price = (cur: 'cash' | 'crystal', n: number | string) => `<span class="price ${cur}">${icon(cur === 'cash' ? 'coins' : 'crystal')}${n}</span>`;
      let body = '';
      if (this.tab === 'buy') {
        const cols = Math.max(...SHOP_ROWS.map((r) => r.ids.length));
        const pad = (ids: (string | null)[]) => [...ids, ...Array<null>(cols - ids.length).fill(null)];
        body = '<div class="rows">' + SHOP_ROWS.map((row) => `<h5>${row.label}</h5>` + pad(row.ids).map((id) => {
          const item = id ? SHOP_ITEM.get(id) : undefined;
          if (!item) return '<i class="slot"></i>';
          const st = this.itemState(item);
          const count = 'count' in item && item.count > 1 && !(item.kind === 'weapon' && isGun(item.weapon)) ? `<small>×${item.count}</small>` : '';
          const look = item.kind === 'blocks' ? ` style="--c:#${BLOCK_MATERIALS[item.material].color.toString(16).padStart(6, '0')}"` : '';
          return `<div class="tile ${st.cls}" data-act="buy" data-id="${item.id}"${look}>${shopIcon(item)}${price(item.currency, item.price)}`
            + `<b>${SHOP_SHORT[item.id] ?? item.label}${count}</b><em>${st.status}</em></div>`;
        }).join('')).join('') + '</div>';
      } else {
        body = '<div class="rows sell">' + SELLABLE.map((id) => {
          const n = eco.items[id];
          return `<div class="tile${n ? '' : ' poor'}" data-act="sell" data-id="${id}">${icon(ITEM_ICON[id])}${price('cash', `+${n * ITEMS[id].sell}`)}`
            + `<b>${ITEMS[id].plural}</b><em>${n} шт. · по ${ITEMS[id].sell}</em></div>`;
        }).join('') + `<div class="tile all${eco.sellValue ? '' : ' poor'}" data-act="sell" data-id="all"><b>Продать всё</b>${price('cash', `+${eco.sellValue}`)}</div></div>`;
      }
      const foot = `<footer><span class="details"></span><span class="keys"><kbd>Q</kbd> вкладка<kbd>E</kbd> закрыть</span></footer>`;
      this.shopEl.className = `panel ${this.tab}`;
      this.shopEl.innerHTML = head + body + foot;
    }
    // the details line: what the item under the cursor is, and whether it can be bought now
    const t = this.cursor.target;
    const hover = t && t.dataset.act === this.tab ? t.dataset.id ?? '' : '';
    if (hover === this.shopHover) return;
    this.shopHover = hover;
    const el = this.shopEl.querySelector<HTMLElement>('.details');
    if (!el) return;
    if (this.tab === 'sell') {
      const id = SELLABLE.find((i) => i === hover);
      el.innerHTML = id ? `<b>${ITEMS[id].plural}</b><span>${this.eco.items[id]} шт. × ${ITEMS[id].sell}</span><span class="why">Клик — продать</span>`
        : hover === 'all' ? '<b>Вся добыча</b><span class="why">Клик — продать</span>' : 'Бутылки, яблоки и рыба — с улиц, деревьев и прудов';
      return;
    }
    const item = SHOP_ITEM.get(hover);
    if (!item) {
      el.innerHTML = 'Клик — купить. Наведи на предмет — подробности';
      return;
    }
    const st = this.itemState(item);
    const w = item.kind === 'weapon' ? WEAPONS[item.weapon] : null;
    const stats = !w ? '' : w.radius ? (item.note ? '' : `взрыв ${w.radius} м, ${w.damage} урона`)
      : isGun(w.id) ? `урон ${w.damage}${(w.pellets ?? 1) > 1 ? ` × ${w.pellets}` : ''}` : '';
    const text = [stats, item.note].filter(Boolean).join(' · ');
    el.innerHTML = `<b>${item.label}</b>${text ? `<span>${text}</span>` : ''}<span class="why ${st.cls}">${st.why}</span>`;
  }
}
