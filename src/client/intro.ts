import { Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';

const _m = new Matrix4();
const look = (pos: Vector3, at: Vector3, up: Vector3) => new Quaternion().setFromRotationMatrix(_m.lookAt(pos, at, up));
const smooth = (x: number) => x * x * (3 - 2 * x);
/** Ease-in-out with a long soft landing. */
const settle = (x: number) => 1 - (1 - smooth(x)) ** 2;

/**
 * The match start: the camera drops from high above the player's base straight into the player's eyes and the game
 * begins. Space / Enter / click skip it.
 */
export class Intro {
  active = true;
  private time = 0;
  private skipped = false;
  private readonly from: Vector3;
  private readonly via: Vector3;
  private readonly fromQ: Quaternion;
  private readonly cap = document.getElementById('intro-cap')!;

  /** `eye`: where the player's camera will be, `up`: the player's up, `length`: seconds of flight. */
  constructor(private readonly eye: { pos: Vector3; quat: Quaternion }, up: Vector3, private readonly length = 3) {
    const back = new Vector3(0, 0, 1).applyQuaternion(eye.quat);
    back.addScaledVector(up, -back.dot(up)).normalize();
    this.from = eye.pos.clone().addScaledVector(up, 70).addScaledVector(back, 55);
    // a bend in the path: the camera swoops down behind the player rather than sliding along a straight line
    this.via = eye.pos.clone().addScaledVector(up, 14).addScaledVector(back, 18);
    this.fromQ = look(this.from, eye.pos, up);
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
    const u = Math.min(1, this.time / this.length);
    const k = settle(u);
    // quadratic Bézier from → via → eye
    const a = 1 - k;
    camera.position.set(0, 0, 0).addScaledVector(this.from, a * a).addScaledVector(this.via, 2 * a * k).addScaledVector(this.eye.pos, k * k);
    camera.quaternion.slerpQuaternions(this.fromQ, this.eye.quat, smooth(Math.min(1, u * 1.15)));
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
