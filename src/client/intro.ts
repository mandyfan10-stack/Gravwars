import { CatmullRomCurve3, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { MapData } from '../shared/map';
import { getTeam, TeamId } from '../shared/teams';

interface Key { pos: Vector3; quat: Quaternion; t: number; caption?: string; color?: string }

const Z = new Vector3(0, 0, 1);
const _m = new Matrix4();
const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
const look = (pos: Vector3, at: Vector3, up: Vector3) => new Quaternion().setFromRotationMatrix(_m.lookAt(pos, at, up));
const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * The match intro: the camera starts far out with the whole map in view, swings around the central city, flies past
 * every base (its crystal, the team's name in a caption), and comes down into the player's eyes exactly when the
 * music hits. Space / Esc / Enter / click skip it.
 */
export class Intro {
  active = true;
  /** Optional clock (s since the intro started), e.g. the music's: keeps the landing on the beat when frames lag. */
  clock: (() => number) | null = null;
  private time = 0;
  private skipped = false;
  private readonly keys: Key[];
  private readonly curve: CatmullRomCurve3;
  private readonly cap = document.getElementById('intro-cap')!;
  private captionAt = -1;

  /**
   * `teams`: the teams in the match, `mine`: the player's; `eye`: where the player's camera will be;
   * `about(team)`: caption text for a base (who plays there); `length`: seconds until the camera arrives.
   */
  constructor(map: MapData, teams: TeamId[], mine: TeamId, eye: { pos: Vector3; quat: Quaternion }, about: (t: TeamId) => string, length: number) {
    const keys: Key[] = [];
    const O = new Vector3();
    // 1. the whole map from far out, 2. lower, swinging round the central city
    const p0 = new Vector3(720, -820, 760);
    keys.push({ pos: p0, quat: look(p0, O, Z), t: 0, caption: `${teams.length} острова вокруг города`, color: '#fff' });
    const p1 = new Vector3(-260, -420, 300);
    keys.push({ pos: p1, quat: look(p1, new Vector3(0, -60, 0), Z), t: 0 });
    // 3. the bases, the player's last
    const order = teams.filter((t) => t !== mine).concat(teams.includes(mine) ? [mine] : []);
    for (const tid of order) {
      const s = map.statues.find((x) => x.team === tid);
      if (!s) continue;
      const bed = new Vector3(...s.bed), up = new Vector3(...s.up);
      const side = new Vector3().crossVectors(up, Z).normalize();
      const team = getTeam(tid);
      const a = bed.clone().addScaledVector(up, 46).addScaledVector(Z, 72).addScaledVector(side, 34);
      const b = bed.clone().addScaledVector(up, 22).addScaledVector(Z, 34).addScaledVector(side, -20);
      keys.push({ pos: a, quat: look(a, bed, up), t: 0, caption: about(tid), color: hex(team.color) });
      if (tid !== mine) keys.push({ pos: b, quat: look(b, bed, up), t: 0 });
    }
    // 4. down into the player's eyes
    keys.push({ pos: eye.pos.clone(), quat: eye.quat.clone(), t: 0, caption: 'В бой', color: '#fff' });
    // timing: the opening and the landing get a fixed share, the bases split the rest
    const n = keys.length;
    const open = 4.2, land = 4.2;
    keys[1].t = open;
    const per = (length - open - land) / Math.max(1, n - 3);
    for (let i = 2; i < n - 1; i++) keys[i].t = open + (i - 1) * per;
    keys[n - 1].t = length;
    this.keys = keys;
    this.curve = new CatmullRomCurve3(keys.map((k) => k.pos), false, 'centripetal');
    this.cap.hidden = false;
    document.body.classList.add('intro');
  }

  /** Jump to the end (the camera lands at once). */
  skip() {
    this.skipped = true;
  }

  /** Move the camera; returns false once it has landed (then the game takes over). */
  update(dt: number, camera: PerspectiveCamera): boolean {
    if (!this.active) return false;
    const keys = this.keys, n = keys.length;
    this.time = this.skipped ? keys[n - 1].t : this.clock ? this.clock() : this.time + dt;
    let i = 0;
    while (i < n - 2 && this.time >= keys[i + 1].t) i++;
    const k0 = keys[i], k1 = keys[i + 1];
    let u = Math.min(1, Math.max(0, (this.time - k0.t) / (k1.t - k0.t)));
    // ease out of the start and into the landing; the middle keeps moving
    if (i === 0 || i === n - 2) u = smooth(u);
    camera.position.copy(this.curve.getPoint((i + u) / (n - 1)));
    camera.quaternion.slerpQuaternions(k0.quat, k1.quat, i === n - 2 ? smooth(u) : u);
    // captions: the latest key that has one
    let c = -1;
    for (let k = 0; k <= i; k++) if (keys[k].caption) c = k;
    if (u > 0.98 && keys[i + 1].caption) c = i + 1;
    if (c !== this.captionAt) {
      this.captionAt = c;
      const key = keys[c];
      this.cap.innerHTML = key ? `<b style="--c:${key.color}">${key.caption}</b><small>Пробел — пропустить</small>` : '';
      this.cap.classList.remove('show');
      void this.cap.offsetWidth; // restart the fade-in
      this.cap.classList.add('show');
    }
    if (this.time >= keys[n - 1].t) {
      this.active = false;
      this.cap.hidden = true;
      document.body.classList.remove('intro');
      camera.position.copy(keys[n - 1].pos);
      camera.quaternion.copy(keys[n - 1].quat);
      return false;
    }
    return true;
  }
}
