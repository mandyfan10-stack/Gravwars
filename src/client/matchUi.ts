import { BLOCK_MATERIALS } from '../shared/blocks';
import { Bed, CURRENCY_LABEL, Match, MatchEvent, SHOP } from '../shared/match';
import { getTeam, TEAMS } from '../shared/teams';
import type { GameAudio } from './audio';
import { Hud, teamHex } from './hud';

const $ = (id: string) => document.getElementById(id)!;

const formatTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

/** Bedwars UI: wallet, bed status row, interaction prompt, bed-break progress, shop panel, result banner. */
export class MatchUi {
  shopOpen = false;
  private readonly wallet = $('wallet');
  private readonly bedsEl = $('beds');
  private readonly prompt = $('prompt');
  private readonly breakEl = $('bed-break');
  private readonly breakBar = $('bed-break').firstElementChild as HTMLElement;
  private readonly shopEl = $('shop');
  private readonly resultEl = $('result');
  private bedsKey = '';

  constructor(private match: Match, private hud: Hud, private audio: GameAudio, private heal: () => boolean) {}

  toggleShop() {
    this.shopOpen = !this.shopOpen;
    this.audio.select();
  }

  /** Buy the n-th shop item (0-based). */
  buy(index: number) {
    const item = SHOP[index];
    if (!item) return;
    if (item.kind === 'heal' && !this.heal()) {
      this.audio.reject();
      this.hud.toast('Здоровье и так полное', '#ffb49e', 1);
      return;
    }
    if (this.match.buy(item) === 'ok') {
      this.audio.place();
      this.hud.toast(`Куплено: ${item.label}`, '#c6ffdb', 1);
    } else {
      this.audio.reject();
      this.hud.toast(`Не хватает: ${CURRENCY_LABEL[item.currency]}`, '#ff8e83', 1);
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
    } else if (e.type === 'win') this.showResult(`ПОБЕДА<small>Все кристаллы разрушены за ${formatTime(e.time)}</small>`, '#ffe08a');
    else if (e.type === 'lose') this.showResult('ВЫБЫЛ<small>Кристалла больше нет</small>', '#ff6b6b');
  }

  private showResult(html: string, color: string) {
    this.resultEl.innerHTML = html;
    this.resultEl.style.color = color;
    this.resultEl.classList.add('show');
  }

  update(nearShop: boolean, reachable: Bed | null) {
    const m = this.match;
    if (this.shopOpen && !nearShop) this.shopOpen = false;

    this.wallet.innerHTML = `<span class="copper">● ${m.wallet.copper}</span><span class="crystal">◆ ${m.wallet.crystal}</span><span class="time">${formatTime(m.time)}</span>`;

    const key = m.beds.map((b) => +b.alive).join('');
    if (key !== this.bedsKey) {
      this.bedsKey = key;
      this.bedsEl.innerHTML = TEAMS.map((t) => {
        const bed = m.bed(t.id);
        const mine = t.id === m.team ? ' mine' : '';
        return `<span class="bed${bed.alive ? '' : ' dead'}${mine}" style="color:${teamHex(t.color)}" title="${t.name}">${bed.alive ? '◆' : '✕'}</span>`;
      }).join('') + `<span class="goal">Цель: кристаллы врагов · осталось ${m.enemiesLeft}</span>`;
    }

    let prompt = '';
    if (m.breaking) prompt = `Ломаешь кристалл: ${getTeam(m.breaking.bed.team).name}`;
    else if (reachable) prompt = `Удерживай <b>E</b> — сломать кристалл (${getTeam(reachable.team).name})`;
    else if (nearShop && !this.shopOpen) prompt = '<b>E</b> — магазин';
    this.prompt.innerHTML = prompt;
    this.prompt.style.opacity = prompt ? '1' : '0';
    this.breakEl.style.opacity = m.breaking ? '1' : '0';
    this.breakBar.style.width = `${(m.breaking?.progress ?? 0) * 100}%`;

    this.shopEl.hidden = !this.shopOpen;
    if (this.shopOpen) {
      this.shopEl.innerHTML = '<h3>Магазин <small>цифры — купить · E — закрыть</small></h3>' + SHOP.map((item, i) => {
        const afford = m.wallet[item.currency] >= item.price;
        const icon = item.currency === 'copper' ? '●' : '◆';
        const have = item.kind === 'blocks' ? `<em>есть ${m.blocks.inventory[item.material]}</em>` : '';
        const color = item.kind === 'blocks' ? `style="border-left-color:#${BLOCK_MATERIALS[item.material].color.toString(16).padStart(6, '0')}"` : '';
        return `<div class="item${afford ? '' : ' poor'}" ${color}><kbd>${i + 1}</kbd>${item.label}${have}<span class="price ${item.currency}">${icon} ${item.price}</span></div>`;
      }).join('');
    }
  }
}
