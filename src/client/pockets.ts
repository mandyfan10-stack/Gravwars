import { PerspectiveCamera, Vector3 } from 'three';
import { MAX_HP } from '../shared/combat';
import { EAT_COOLDOWN, Economy, ItemId, ITEMS, Pickup, PickupKind, Pickups } from '../shared/economy';
import { Fishing, FISHING } from '../shared/fishing';
import type { PlayerSim } from '../shared/sim';
import type { GameAudio } from './audio';
import type { Hud } from './hud';
import type { PlayerCombat } from './playerCombat';

const $ = (id: string) => document.getElementById(id)!;
const PICK_NAME: Record<PickupKind, string> = { apple: 'яблоко', bottle: 'бутылку', cash: 'деньги', fish: 'рыбу', medkit: 'аптечку' };
const _dir = new Vector3();
const _side = new Vector3();
const _fwd = new Vector3();

/**
 * Everything the player carries besides weapons: picking up items (E), eating and healing, spilling the pockets on
 * death, the fishing rod (LMB: cast, strike).
 */
export class Pockets {
  /** The rod is in hand (slot 6). */
  rod = false;
  readonly fishing: Fishing;
  private readonly bar = $('fish-bar');
  private readonly zone = this.bar.querySelector('.zone') as HTMLElement;
  private readonly mark = this.bar.querySelector('.mark') as HTMLElement;
  private eatT = 0;
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
    if (it.kind === 'cash') {
      this.eco.wallet.cash += it.amount;
      this.audio.coins();
      this.hud.toast(`+${it.amount} денег`, '#e2c27a', 0.9);
    } else {
      const n = Math.max(1, it.amount);
      this.eco.items[it.kind] += n;
      this.audio.pickup();
      this.hud.toast(`+${n} ${(n > 1 ? ITEMS[it.kind].plural : ITEMS[it.kind].name).toLowerCase()}`, '#e8e2d6', 0.8);
    }
    this.near = null;
    return true;
  }

  /** F: eat an apple. */
  eat() {
    if (this.eco.items.apple <= 0) { this.audio.reject(); this.hud.toast('Нет яблок', '#ffb49e', 0.8); return; }
    this.consume('apple');
  }

  /** Eat / apply one item that heals (apple, fish, medkit). False if it did nothing. */
  consume(id: ItemId): boolean {
    if (this.eatT > 0 || !ITEMS[id].heal || this.eco.items[id] <= 0) return false;
    if (this.player.me.hp >= MAX_HP) { this.audio.reject(); this.hud.toast('Здоровье и так полное', '#ffb49e', 0.8); return false; }
    this.eco.take(id);
    this.player.heal(ITEMS[id].heal);
    if (id === 'medkit') this.audio.patch();
    else this.audio.eat();
    this.eatT = EAT_COOLDOWN;
    return true;
  }

  /**
   * Died at `pos`: the pockets spill out around the body (items and half of the cash). `lost`: fell into the void,
   * everything is gone with you.
   */
  spill(pos: Vector3, up: Vector3, lost: boolean) {
    const piles = this.eco.spill();
    if (lost) return;
    // a small ring around the body, so that the piles do not sit inside each other
    _side.set(1, 0, 0);
    if (Math.abs(_side.dot(up)) > 0.9) _side.set(0, 0, 1);
    _side.addScaledVector(up, -_side.dot(up)).normalize();
    _fwd.crossVectors(up, _side);
    piles.forEach((p, i) => {
      const a = (i / Math.max(1, piles.length)) * Math.PI * 2;
      const at = pos.clone().addScaledVector(_side, Math.cos(a) * 0.9).addScaledVector(_fwd, Math.sin(a) * 0.9);
      if (!this.pickups.drop(p.kind, at, up, p.amount)) this.pickups.drop(p.kind, pos, up, p.amount);
    });
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

    let prompt = '';
    if (this.near) {
      const n = this.near.kind !== 'cash' && this.near.amount > 1 ? ` ×${this.near.amount}` : '';
      prompt = `<b>E</b> подобрать ${PICK_NAME[this.near.kind]}${n}`;
    }
    if (this.rod) {
      if (f.phase === 'idle' && !this.near) prompt = f.aimWater(camera.position, camera.getWorldDirection(_dir)) ? '<b>ЛКМ</b> забросить' : '';
      else if (f.phase === 'wait' || f.phase === 'cast') prompt = 'Ждём поклёвку…';
      else if (biting) prompt = '<b>ЛКМ</b> подсечь, когда метка в зелёной зоне';
    }
    return prompt;
  }
}
