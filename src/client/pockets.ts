import { PerspectiveCamera, Vector3 } from 'three';
import { MAX_HP } from '../shared/combat';
import { APPLE_HEAL, EAT_COOLDOWN, Economy, ITEM_ORDER, ITEMS, Pickup, Pickups } from '../shared/economy';
import { Fishing, FISHING } from '../shared/fishing';
import type { PlayerSim } from '../shared/sim';
import { isGun } from '../shared/weapons';
import type { GameAudio } from './audio';
import type { Hud } from './hud';
import { icon, IconName } from './icons';
import type { PlayerCombat } from './playerCombat';

const $ = (id: string) => document.getElementById(id)!;
const ITEM_ICON: Record<string, IconName> = { bottle: 'bottle', apple: 'apple', fish: 'fish' };
const PICK_NAME = { apple: 'яблоко', bottle: 'бутылку' } as const;
const _dir = new Vector3();

/**
 * Everything the player carries besides weapons: picking up apples / bottles (E), eating (F), the fishing rod
 * (LMB: cast, strike) and the pockets panel with item and ammo counts.
 */
export class Pockets {
  /** The rod is in hand (slot 6). */
  rod = false;
  readonly fishing: Fishing;
  private readonly el = $('pockets');
  private readonly bar = $('fish-bar');
  private readonly zone = this.bar.querySelector('.zone') as HTMLElement;
  private readonly mark = this.bar.querySelector('.mark') as HTMLElement;
  private eatT = 0;
  private key = '';
  /** Item in reach (for the prompt and E). */
  near: Pickup | null = null;

  constructor(private eco: Economy, readonly pickups: Pickups, private sim: PlayerSim, private player: PlayerCombat,
    private hud: Hud, private audio: GameAudio, ponds: ConstructorParameters<typeof Fishing>[0]) {
    this.fishing = new Fishing(ponds);
  }

  /** E away from the shop: pick up the item in reach. True if something was taken. */
  interact(): boolean {
    const it = this.near;
    if (!it) return false;
    this.pickups.take(it);
    this.eco.items[it.kind]++;
    this.audio.pickup();
    this.hud.toast(`+1 ${ITEMS[it.kind].name.toLowerCase()}`, '#e8e2d6', 0.8);
    this.near = null;
    return true;
  }

  /** F: eat an apple. */
  eat() {
    if (this.eatT > 0) return;
    if (this.eco.items.apple <= 0) { this.audio.reject(); this.hud.toast('Нет яблок', '#ffb49e', 0.8); return; }
    if (this.player.me.hp >= MAX_HP) { this.audio.reject(); this.hud.toast('Здоровье и так полное', '#ffb49e', 0.8); return; }
    this.eco.eat();
    this.player.heal(APPLE_HEAL);
    this.audio.eat();
    this.eatT = EAT_COOLDOWN;
  }

  /** Take the rod / put it away. */
  setRod(on: boolean) {
    if (!on && this.rod) this.fishing.cancel();
    this.rod = on;
  }

  /** LMB with the rod in hand. */
  useRod(camera: PerspectiveCamera) {
    camera.getWorldDirection(_dir);
    this.fishing.use(camera.position, _dir);
  }

  /** Per frame: pickups in reach, fishing timers and events, HUD. Returns the prompt line for the centre of the screen. */
  update(dt: number, camera: PerspectiveCamera, onCast: () => void): string {
    this.eatT = Math.max(0, this.eatT - dt);
    this.pickups.tick(dt);
    const alive = this.player.me.alive;
    this.near = alive ? this.pickups.nearest(this.sim.state.pos) : null;

    const f = this.fishing;
    if (!this.rod || !alive) f.cancel();
    f.tick(dt, this.sim.state.pos);
    for (const e of f.events.splice(0)) {
      if (e.type === 'cast') { this.audio.cast(); onCast(); }
      else if (e.type === 'splash') this.audio.splash();
      else if (e.type === 'bite') this.audio.bite();
      else if (e.type === 'catch') {
        this.eco.items.fish++;
        this.audio.reel();
        this.hud.toast('+1 рыба', '#bfe6ff', 1.2);
      } else if (e.type === 'noWater') {
        this.audio.reject();
        this.hud.toast('Забрасывай в пруд — он в парке', '#ffb49e', 1.2);
      } else if (e.type === 'miss' && e.reason !== 'away') {
        this.hud.toast(e.reason === 'early' ? 'Рано — рыба ушла' : e.reason === 'late' ? 'Сорвалась' : 'Мимо — рыба ушла', '#ffb49e', 1);
      }
    }

    // strike bar
    const biting = f.phase === 'bite';
    this.bar.style.opacity = biting ? '1' : '0';
    if (biting) {
      this.zone.style.left = `${f.zoneAt * 100}%`;
      this.zone.style.width = `${FISHING.zone * 100}%`;
      this.mark.style.left = `${f.marker * 100}%`;
    }

    this.renderPockets();

    let prompt = '';
    if (this.near) prompt = `<b>E</b> подобрать ${PICK_NAME[this.near.kind]}`;
    if (this.rod) {
      if (f.phase === 'idle' && !this.near) prompt = f.aimWater(camera.position, camera.getWorldDirection(_dir)) ? '<b>ЛКМ</b> забросить' : '';
      else if (f.phase === 'wait' || f.phase === 'cast') prompt = 'Ждём поклёвку…';
      else if (biting) prompt = '<b>ЛКМ</b> подсечь, когда метка в зелёной зоне';
    }
    return prompt;
  }

  /** Items + spare ammo; only rows that matter (owned guns), counts dim at zero. */
  private renderPockets() {
    const eco = this.eco;
    const ws = eco.weapons;
    const guns = (['pistol', 'rifle'] as const).filter((w) => isGun(w) && ws.owned[w]);
    const key = [...ITEM_ORDER.map((i) => eco.items[i]), ...guns.map((w) => ws.reserve[w] + ws.ammo[w]), this.eatT > 0].join();
    if (key === this.key) return;
    this.key = key;
    const items = ITEM_ORDER.map((id) => `<span class="${eco.items[id] ? '' : 'zero'}" title="${ITEMS[id].plural}">${icon(ITEM_ICON[id])}${eco.items[id]}</span>`).join('');
    const ammo = guns.map((w) => `<span title="Патроны: ${w === 'pistol' ? 'пистолет' : 'автомат'}">${icon(w === 'pistol' ? 'pistol' : 'rifle')}`
      + `<i>${ws.ammo[w] + ws.reserve[w]}</i></span>`).join('');
    const hint = eco.items.apple > 0 ? '<span class="hint"><kbd>F</kbd> съесть</span>' : '';
    this.el.innerHTML = items + hint + (ammo ? `<span class="sep"></span>${icon('ammo', 'ammo-ic')}${ammo}` : '');
  }
}
