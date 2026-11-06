import type { Input } from './input';

/**
 * A mouse cursor for the shop and the inventory that works without leaving pointer lock: while a panel is open the
 * mouse moves this arrow instead of the view (the game keeps running, WASD still walks). Clicks go to the element
 * under it that has a `data-act` attribute.
 */
export class Cursor {
  x = window.innerWidth / 2;
  y = window.innerHeight / 2;
  private readonly el = document.getElementById('cursor')!;
  private hover: HTMLElement | null = null;
  private on = false;

  constructor(private input: Input) {
    input.onMouseMove = (dx, dy) => {
      if (!this.on) return false;
      this.moveTo(this.x + dx, this.y + dy);
      return true;
    };
  }

  get active() {
    return this.on;
  }

  /** Show the cursor (the view stops turning). It starts in the middle of the screen. */
  open() {
    if (this.on) return;
    this.on = true;
    this.moveTo(window.innerWidth / 2, window.innerHeight / 2);
  }

  close() {
    this.on = false;
    this.setHover(null);
    this.el.hidden = true;
  }

  moveTo(x: number, y: number) {
    this.x = Math.max(0, Math.min(window.innerWidth - 1, x));
    this.y = Math.max(0, Math.min(window.innerHeight - 1, y));
  }

  /** The clickable element under the cursor (null: nothing). */
  get target(): HTMLElement | null {
    return this.hover;
  }

  private setHover(el: HTMLElement | null) {
    if (el === this.hover) return;
    this.hover?.classList.remove('hover');
    this.hover = el;
    el?.classList.add('hover');
  }

  /** Per frame: draw the arrow, find what it points at. Returns the element clicked this frame (LMB), if any. */
  update(): HTMLElement | null {
    this.el.hidden = !this.on;
    if (!this.on) return null;
    this.el.style.transform = `translate(${this.x}px, ${this.y}px)`;
    const under = document.elementFromPoint(this.x, this.y) as HTMLElement | null;
    this.setHover(under?.closest<HTMLElement>('[data-act]') ?? null);
    return this.input.take('Mouse0') ? this.hover : null;
  }
}
