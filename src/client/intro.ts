import { CatmullRomCurve3, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';

const _m = new Matrix4();
const _p = new Vector3();
const _ahead = new Vector3();
const _q = new Quaternion();
const look = (pos: Vector3, at: Vector3, up: Vector3, out = new Quaternion()) => out.setFromRotationMatrix(_m.lookAt(pos, at, up));
const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** Ease-in-out with a long soft landing. */
const settle = (x: number) => 1 - (1 - smooth(x)) ** 2;

export interface Pose { pos: Vector3; quat: Quaternion }
/** A hall door the flight comes in through: a point outside it and one inside (both at eye height). */
export interface Door { out: Vector3; in: Vector3 }

/**
 * The match start: the camera flies from high above the player's base (or from where the menu's camera is) down to
 * the hall, in through the door behind the player and into the player's eyes; then the game begins. Space / Enter /
 * click skip it.
 */
export class Intro {
  active = true;
  private time = 0;
  private skipped = false;
  private readonly path: CatmullRomCurve3;
  private readonly fromQ: Quaternion;
  private readonly cap = document.getElementById('intro-cap')!;

  /**
   * `eye`: where the player's camera will be, `up`: the player's up, `length`: seconds of flight, `start`: where the
   * camera is now (the menu's shot), `door`: the way into the hall (without one the camera drops straight in).
   */
  constructor(
    private readonly eye: Pose, private readonly up: Vector3, private readonly length = 3,
    opts: { start?: Pose; door?: Door } = {},
  ) {
    const { start, door } = opts;
    const back = new Vector3(0, 0, 1).applyQuaternion(eye.quat);
    back.addScaledVector(up, -back.dot(up)).normalize();
    const pts: Vector3[] = [];
    if (door) {
      // high above the street outside the door, down to it, through it, to the eyes
      const out = door.out.clone().sub(door.in);
      out.addScaledVector(up, -out.dot(up)).normalize();
      pts.push(start ? start.pos.clone() : door.out.clone().addScaledVector(up, 70).addScaledVector(out, 50));
      pts.push(door.out.clone().addScaledVector(up, 26).addScaledVector(out, 34));
      pts.push(door.out.clone().addScaledVector(out, 4).addScaledVector(up, 0.4), door.out.clone(), door.in.clone());
    } else {
      // a bend in the path: the camera swoops down behind the player rather than sliding along a straight line
      pts.push(start ? start.pos.clone() : eye.pos.clone().addScaledVector(up, 70).addScaledVector(back, 55));
      pts.push(eye.pos.clone().addScaledVector(up, 14).addScaledVector(back, 18));
    }
    pts.push(eye.pos.clone());
    this.path = new CatmullRomCurve3(pts, false, 'centripetal');
    this.path.arcLengthDivisions = 400;
    this.fromQ = start ? start.quat.clone() : look(pts[0], eye.pos, up);
    this.cap.hidden = false;
    this.cap.innerHTML = '<b style="--c:#fff">В бой</b>';
    this.cap.classList.add('show');
    document.body.classList.add('intro');
  }

  skip() {
    this.skipped = true;
  }

  /** Move the camera; returns false once it has landed (then the game takes over). */
  update(dt: number, camera: PerspectiveCamera): boolean {
    if (!this.active) return false;
    this.time = this.skipped ? this.length : this.time + dt;
    const u = clamp01(this.time / this.length);
    const k = settle(u);
    this.path.getPointAt(k, _p);
    camera.position.copy(_p);
    // look where the flight goes; turn from the start view into it, and into the player's view at the very end
    this.path.getPointAt(Math.min(1, k + 0.05), _ahead);
    if (_ahead.distanceToSquared(_p) < 1e-4) _q.copy(this.eye.quat);
    else look(_p, _ahead, this.up, _q);
    camera.quaternion.slerpQuaternions(this.fromQ, _q, smooth(clamp01(u * 3)));
    camera.quaternion.slerp(this.eye.quat, smooth(clamp01((k - 0.93) / 0.07)));
    if (u >= 1) {
      this.active = false;
      this.cap.hidden = true;
      this.cap.classList.remove('show');
      document.body.classList.remove('intro');
      camera.position.copy(this.eye.pos);
      camera.quaternion.copy(this.eye.quat);
      return false;
    }
    return true;
  }
}
