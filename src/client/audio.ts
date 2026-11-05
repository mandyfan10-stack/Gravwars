/** Small procedural effects, inspired by the supplied prototype; no external audio assets. */
export class GameAudio {
  private ctx: AudioContext | null = null;
  volume = 0.45;
  unlock() {
    this.ctx ??= new AudioContext();
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }
  private tone(type: OscillatorType, from: number, to: number, duration: number, volume: number, delay = 0) {
    const c = this.ctx; if (!c || !this.volume) return;
    const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(from,t); o.frequency.exponentialRampToValueAtTime(Math.max(1,to),t+duration);
    g.gain.setValueAtTime(Math.max(0.0001,volume*this.volume),t); g.gain.exponentialRampToValueAtTime(0.0001,t+duration);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t+duration+.01);
  }
  private noiseBuf: AudioBuffer | null = null;
  /** Filtered white noise burst; `delay` s from now; `type` of the sweeping filter. */
  private noise(duration: number, volume: number, from: number, to: number, delay = 0, type: BiquadFilterType = 'lowpass', q = 0.7) {
    const c = this.ctx; if (!c || !this.volume || volume <= 0.0005) return;
    if (!this.noiseBuf) {
      this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const a = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < a.length; i++) a[i] = Math.random() * 2 - 1;
    }
    const src=c.createBufferSource(), f=c.createBiquadFilter(), g=c.createGain(), t=c.currentTime+delay;
    src.buffer=this.noiseBuf; f.type=type; f.Q.value=q; f.frequency.setValueAtTime(from,t);f.frequency.exponentialRampToValueAtTime(Math.max(20,to),t+duration);
    g.gain.setValueAtTime(volume*this.volume,t);g.gain.exponentialRampToValueAtTime(.0001,t+duration);
    src.connect(f).connect(g).connect(c.destination);src.start(t, Math.random()*1.5);src.stop(t+duration+.01);
  }
  /** A short metallic click: a band-passed tick plus a tiny ring. */
  private click(volume: number, pitch: number, delay = 0) {
    this.noise(.025, volume, pitch, pitch * .8, delay, 'bandpass', 4);
    this.tone('square', pitch * .5, pitch * .45, .03, volume * .25, delay);
  }
  place() { this.noise(.15,.12,900,300);this.tone('triangle',160,100,.14,.09);this.tone('square',420,320,.05,.04,.05); }
  remove() { this.noise(.23,.14,1300,220);this.tone('triangle',220,80,.18,.09); }
  select() { this.tone('triangle',520,640,.06,.045); }
  reject() { this.tone('square',180,120,.1,.035); }
  /**
   * Gunshot: supersonic crack + muzzle blast + low thump + a tail that rolls off the buildings. Far shots arrive late
   * (speed of sound), quieter and duller.
   */
  shot(pistol = false, dist = 0) {
    const near = 1 / (1 + dist / 18);
    const delay = dist / 343;
    const dull = Math.max(0.15, 1 - dist / 120);
    const v = pistol ? 0.85 : 1;
    if (dist < 60) this.noise(.03, .16 * v * near, 9000 * dull, 4000 * dull, delay, 'highpass');
    this.noise(pistol ? .11 : .14, .22 * v * near, 3200 * dull, 260, delay);
    this.tone('sine', pistol ? 150 : 110, 38, pistol ? .12 : .16, .2 * v * near, delay);
    this.noise(pistol ? .45 : .6, .05 * v * Math.sqrt(near), 1400 * dull, 120, delay + .03);
  }
  /** Bullet whine off a hard surface. */
  ricochet(dist = 0) {
    const near = 1 / (1 + dist / 10);
    const f = 2400 + Math.random() * 1600;
    this.tone('sine', f, f * .55, .28, .05 * near);
    this.noise(.05, .06 * near, 6000, 2000, 0, 'highpass');
  }
  /** Bullet hitting the world near the player. */
  impact(material: 'wood' | 'stone' | 'metal' | 'concrete', dist = 0) {
    const near = 1 / (1 + dist / 6);
    if (material === 'wood') { this.noise(.08, .1 * near, 1800, 300); this.tone('triangle', 240, 120, .06, .05 * near); }
    else if (material === 'metal') { this.tone('triangle', 1900, 1500, .18, .05 * near); this.click(.07 * near, 3200); }
    else this.noise(.06, .08 * near, 3000, 600);
  }
  /** Pulled the trigger on an empty gun. */
  dry() { this.click(.09, 2600); }
  /**
   * Reload in stages over `total` s: magazine out, magazine in, and (empty) the slide / bolt is pulled and released.
   */
  reload(pistol: boolean, total: number, empty: boolean) {
    const end = total - (empty ? 0.55 : 0.15);
    // release + magazine sliding out
    this.click(.06, pistol ? 2400 : 1700, .05);
    this.noise(.12, .05, 1500, 500, .1);
    // new magazine seated: a firm clack
    const seat = end * 0.72;
    this.noise(.05, .09, 2600, 700, seat - .05);
    this.click(.11, pistol ? 1900 : 1300, seat);
    this.tone('triangle', pistol ? 300 : 220, 140, .05, .06, seat);
    if (empty) {
      // slide / bolt back … and forward
      const back = total - 0.45;
      this.noise(.09, .07, 3500, 1400, back, 'bandpass', 2);
      this.click(.08, pistol ? 2800 : 2000, back + .09);
      this.noise(.06, .08, 3000, 900, total - 0.18, 'bandpass', 2);
      this.click(.12, pistol ? 2200 : 1500, total - 0.12);
    }
  }
  punch(hit: boolean) { if (hit) { this.noise(.07,.16,700,120);this.tone('sine',90,45,.08,.12); } else this.noise(.1,.05,1800,600); }
  pickup() { this.tone('triangle',660,880,.05,.04);this.tone('triangle',880,990,.05,.03,.05); }
  eat() { this.noise(.06,.08,2600,900);this.noise(.06,.07,2200,800); }
  coins() { this.tone('square',1250,1250,.05,.02);this.tone('square',1660,1660,.09,.02,.06); }
  splash() { this.noise(.35,.12,1600,200); }
  cast() { this.noise(.18,.05,4200,1200);this.tone('sine',900,300,.18,.02); }
  bite() { this.tone('sine',520,420,.08,.06);this.tone('sine',520,420,.08,.06,.12); }
  reel() { for (let i=0;i<6;i++) this.tone('square',2400,2200,.015,.015,i*.04); }
  explosion() { this.noise(.55,.23,1600,100);this.tone('sine',100,34,.4,.20); }
}
