export class Input {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  yaw = 0;
  pitch = 0;
  sensitivity = 0.0022;
  locked = false;
  private wheelJump = 0;
  private wantMenuInSpec = false;
  /** Mouse-move hooks, in order: the first that returns true takes the move (the view does not turn). */
  readonly mouseHooks: ((dx: number, dy: number) => boolean)[] = [];
  onWheel: (delta: number) => boolean = () => false;

  /** A match exists: the menu button and a click on the canvas take the mouse (before that the menu is the lobby). */
  armed = false;
  /** True while typing into an active in-match chat input (suppresses movement & Escape pause). */
  typing = false;

  constructor(private canvas: HTMLCanvasElement, private overlay: HTMLElement) {
    document.getElementById('start-game')!.addEventListener('click', () => this.lock());
    canvas.addEventListener('click', () => { if (!this.locked && this.armed) this.requestLock(); });
    document.addEventListener('pointerlockchange', () => this.setLocked(document.pointerLockElement === canvas));
    window.addEventListener('keydown', (e) => {
      if (this.typing) return;
      if (e.code === 'Tab') e.preventDefault();
      if (e.code === 'Escape') {
        if (this.locked) {
          this.wantMenuInSpec = true;
          document.exitPointerLock();
          return;
        }
        if (document.body.classList.contains('spectating') && this.armed) {
          this.overlay.classList.toggle('hidden');
          return;
        }
      }
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      for (const hook of this.mouseHooks) if (hook(e.movementX, e.movementY)) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      const lim = Math.PI / 2 - 0.01;
      this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      const code = `Mouse${e.button}`;
      if (!this.keys.has(code)) this.pressed.add(code);
      this.keys.add(code);
    });
    document.addEventListener('mouseup', (e) => this.keys.delete(`Mouse${e.button}`));
    window.addEventListener('wheel', (e) => {
      if (!this.locked) return;
      if (this.onWheel(e.deltaY)) e.preventDefault();
      else this.wheelJump = 3;
    }, { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  lock() {
    if (this.armed) this.requestLock();
  }

  private requestLock() {
    try {
      const res = this.canvas.requestPointerLock() as unknown;
      if (res && typeof (res as Promise<unknown>).catch === 'function') {
        (res as Promise<unknown>).catch(() => {});
      }
    } catch {}
  }

  /** Pointer lock state (also used by the screenshot script, where headless Chrome has no pointer lock). */
  setLocked(on: boolean) {
    this.locked = on;
    const spectating = document.body.classList.contains('spectating');
    // Do NOT pop up the pause menu when alt-tabbing / losing window focus in Spectator mode
    if (on || !spectating || this.wantMenuInSpec) {
      this.overlay.classList.toggle('hidden', on);
    }
    this.wantMenuInSpec = false;
    document.body.classList.toggle('playing', on);
    if (!on) { this.keys.clear(); this.pressed.clear(); }
    document.dispatchEvent(new Event('game-lock'));
  }

  down(code: string) {
    return this.keys.has(code);
  }

  /** Edge-triggered key press (consumed). */
  take(code: string) {
    const had = this.pressed.has(code);
    this.pressed.delete(code);
    return had;
  }

  endFrame() {
    this.pressed.clear();
  }

  axis(pos: string, neg: string) {
    return (this.down(pos) ? 1 : 0) - (this.down(neg) ? 1 : 0);
  }

  /** Called once per simulation tick. */
  jump() {
    if (this.wheelJump > 0) {
      this.wheelJump--;
      return true;
    }
    return this.down('Space');
  }
}