import { PerspectiveCamera, Vector3 } from 'three';
import type { Combat, Target } from '../shared/combat';
import { getTeam, TeamId } from '../shared/teams';
import { teamHex } from './hud';
import { icon, IconName } from './icons';
import { DEATH_TIME, Death, SOURCE_NAME } from './playerCombat';

const $ = (id: string) => document.getElementById(id)!;
const _back = new Vector3();
const _want = new Vector3();
const _from = new Vector3();
const _look = new Vector3();
const _k = new Vector3();
const ease = (x: number) => 1 - (1 - x) ** 3;

const WEAPON_ICON: Record<string, IconName> = {
  fists: 'fist', kick: 'kick', pistol: 'pistol', shotgun: 'shotgun', rifle: 'rifle', rocket: 'rocket', grenade: 'grenade',
};

function killerName(t: Target) {
  if (t.team.startsWith('bum:')) return '<span class="npc">Бродяга</span>';
  if (t.team.startsWith('gang:')) return '<span class="npc">Бандит</span>';
  const team = getTeam(t.team as TeamId);
  return `<span style="color:${teamHex(team.color)}">${team.name}</span>`;
}

/**
 * The death screen: the camera leaves the body (pulls up and back, slowly circling the spot, then turns to the
 * killer), the picture drains of colour, the card says who did it with what and counts down to the respawn.
 */
export class DeathScreen {
  private readonly el = $('death');
  private readonly kicker = this.el.querySelector('.kicker')!;
  private readonly title = this.el.querySelector('h2')!;
  private readonly by = this.el.querySelector('.by')!;
  private readonly bar = this.el.querySelector('.bar i') as HTMLElement;
  private readonly time = this.el.querySelector('.t')!;
  private shown: Death | null = null;
  /** Seconds since this death (the camera move); `final` deaths have no countdown to go by. */
  private age = 0;
  private readonly cam = new Vector3();

  constructor(private combat: Combat) {}

  get active() {
    return this.shown !== null;
  }

  /** Per frame: show / hide the card, move the camera. Returns true while the death camera owns the view. */
  update(death: Death | null, camera: PerspectiveCamera, dt: number): boolean {
    if (death !== this.shown) {
      this.shown = death;
      document.body.classList.toggle('dead', !!death);
      if (death) this.open(death, camera);
    }
    if (!death) return false;
    this.age += dt;
    const left = Math.max(0, death.t);
    this.bar.style.width = `${((1 - left / DEATH_TIME) * 100).toFixed(1)}%`;
    if (!death.final) this.time.textContent = left > 0.05 ? `Возрождение через ${left.toFixed(1)} с` : 'Возрождение…';
    this.moveCamera(death, camera);
    return true;
  }

  private open(d: Death, camera: PerspectiveCamera) {
    this.age = 0;
    this.cam.copy(camera.position);
    this.el.classList.toggle('final', d.final);
    // restart the CSS animations
    this.title.style.animation = 'none';
    void (this.title as HTMLElement).offsetWidth;
    this.title.style.animation = '';
    this.kicker.textContent = d.final ? 'Кристалла больше нет' : d.head ? 'В голову' : '';
    this.title.textContent = d.final ? 'Ты выбыл' : 'Ты погиб';
    if (d.killer && d.cause === 'killed') {
      const w = d.weapon ? `${icon(WEAPON_ICON[d.weapon] ?? 'swords')}<small>${SOURCE_NAME[d.weapon]}</small>` : '';
      this.by.innerHTML = `${killerName(d.killer)}${w}<small>· ${Math.round(d.dist)} м</small>`;
    } else {
      const why = d.cause === 'void' ? 'Упал в пустоту' : d.cause === 'fall' ? 'Разбился при падении' : 'Подорвал себя';
      this.by.innerHTML = `${icon('skull')}<small>${why}</small>`;
    }
    this.time.textContent = d.final ? 'Можно досмотреть матч' : '';
  }

  /**
   * Up and back from where you stood (walls stop it), circling slowly; the view goes from the body to the killer
   * if they are still around.
   */
  private moveCamera(d: Death, camera: PerspectiveCamera) {
    const k = ease(Math.min(1, this.age / 1.1));
    _back.copy(d.look).addScaledVector(d.up, -d.look.dot(d.up));
    if (_back.lengthSq() < 1e-4) _back.set(1, 0, 0).addScaledVector(d.up, -d.up.x);
    _back.normalize().negate().applyAxisAngle(d.up, this.age * 0.22);
    _from.copy(d.pos).addScaledVector(d.up, 0.6);
    _want.copy(_from).addScaledVector(d.up, 3.4).addScaledVector(_back, 4.6);
    const hit = this.combat.rayWorld(_from, _want);
    if (hit) _want.lerpVectors(_from, _want, Math.max(0, hit.t - 0.3 / _from.distanceTo(_want)));
    this.cam.lerpVectors(d.eye, _want, k);
    camera.position.copy(this.cam);
    // where you were looking, turning to the body, then to the killer (if still alive and not too far)
    _look.copy(d.eye).addScaledVector(d.look, 6).lerp(d.pos, ease(Math.min(1, this.age / 0.9)));
    const killer = d.killer;
    if (killer && killer.alive && killer.center.distanceTo(d.pos) < 70) {
      const kk = ease(Math.min(1, Math.max(0, (this.age - 1.1) / 1.2)));
      _look.lerp(_k.copy(killer.center).addScaledVector(d.up, 0.4), kk * 0.75);
    }
    camera.up.copy(d.up);
    camera.lookAt(_look);
    camera.updateMatrixWorld();
  }
}
