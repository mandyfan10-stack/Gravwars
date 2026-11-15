/** Small procedural effects, inspired by the supplied prototype; no external audio assets. */
export class GameAudio {
  private ctx: AudioContext | null = null;
  volume = 0.45;
  /** The audio context once unlocked (music plays through it). */
  get context() {
    return this.ctx;
  }
  unlock() {
    this.ctx ??= new AudioContext();
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }
  tone(type: OscillatorType, from: number, to: number, duration: number, volume: number, delay = 0) {
    const c = this.ctx; if (!c || !this.volume) return;
    const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(from,t); o.frequency.exponentialRampToValueAtTime(Math.max(1,to),t+duration);
    g.gain.setValueAtTime(Math.max(0.0001,volume*this.volume),t); g.gain.exponentialRampToValueAtTime(0.0001,t+duration);
    o.connect(g).connect(this.dest ?? c.destination); o.start(t); o.stop(t+duration+.01);
  }
  /** Where tone() / noise() connect to; set only while at() runs. */
  private dest: AudioNode | null = null;
  /**
   * Play whatever `fn` schedules as one sound out in the world: panned (-1 left .. 1 right, optionally sweeping to
   * `panTo` over `sweep` s), quieter and duller with distance (m).
   */
  at(pan: number, dist: number, fn: () => void, panTo?: number, sweep = 1) {
    const c = this.ctx; if (!c || !this.volume || c.state !== 'running') return;
    const p = c.createStereoPanner(), f = c.createBiquadFilter(), g = c.createGain(), t = c.currentTime;
    p.pan.setValueAtTime(pan, t);
    if (panTo !== undefined) p.pan.linearRampToValueAtTime(panTo, t + sweep);
    f.type = 'lowpass'; f.frequency.value = 16000 / (1 + dist / 12); f.Q.value = 0.5;
    g.gain.value = 1 / (1 + dist / 9);
    p.connect(f).connect(g).connect(c.destination);
    this.dest = p;
    try { fn(); } finally { this.dest = null; }
    // the chain is freed by the browser once its sources have stopped
  }
  private noiseBuf: AudioBuffer | null = null;
  /** Shared 2 s white-noise buffer used by bursts and ambient loops. */
  private ensureNoiseBuf(c: AudioContext): AudioBuffer {
    if (!this.noiseBuf) {
      this.noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const a = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < a.length; i++) a[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuf;
  }
  /** Filtered white noise burst; `delay` s from now; `type` of the sweeping filter. */
  noise(duration: number, volume: number, from: number, to: number, delay = 0, type: BiquadFilterType = 'lowpass', q = 0.7) {
    const c = this.ctx; if (!c || !this.volume || volume <= 0.0005) return;
    this.ensureNoiseBuf(c);
    const src=c.createBufferSource(), f=c.createBiquadFilter(), g=c.createGain(), t=c.currentTime+delay;
    src.buffer=this.noiseBuf; f.type=type; f.Q.value=q; f.frequency.setValueAtTime(from,t);f.frequency.exponentialRampToValueAtTime(Math.max(20,to),t+duration);
    g.gain.setValueAtTime(volume*this.volume,t);g.gain.exponentialRampToValueAtTime(.0001,t+duration);
    src.connect(f).connect(g).connect(this.dest ?? c.destination);src.start(t, Math.random()*1.5);src.stop(t+duration+.01);
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
  /** Pump shotgun: a deep boom with a long roll, then (own gun) the pump racked back and forward. */
  shotgun(dist = 0, own = false) {
    const near = 1 / (1 + dist / 18);
    const delay = dist / 343;
    const dull = Math.max(0.15, 1 - dist / 120);
    if (dist < 60) this.noise(.04, .2 * near, 7000 * dull, 2500 * dull, delay, 'highpass');
    this.noise(.2, .32 * near, 2400 * dull, 140, delay);
    this.tone('sine', 85, 30, .28, .3 * near, delay);
    this.noise(.9, .07 * Math.sqrt(near), 1000 * dull, 90, delay + .04);
    if (own) {
      this.noise(.07, .07, 2200, 900, .32, 'bandpass', 2);
      this.click(.1, 1300, .36);
      this.noise(.06, .08, 2600, 1100, .48, 'bandpass', 2);
      this.click(.12, 1700, .52);
    }
  }
  /** Rocket launch: a hard pop, then the motor's hiss going away. */
  rocket(dist = 0) {
    const near = 1 / (1 + dist / 18);
    this.noise(.08, .22 * near, 1800, 300);
    this.tone('sine', 120, 45, .18, .18 * near);
    this.noise(.7, .12 * near, 900, 3800, .03, 'bandpass', 1.4);
    this.noise(.5, .05 * near, 5000, 2000, .1, 'highpass');
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
  reload(pistol: boolean, total: number, empty: boolean, kind: 'mag' | 'shells' | 'rocket' = 'mag') {
    if (kind === 'shells') {
      // shells pushed into the tube one by one, the pump racked at the end
      for (let t = 0.2; t < total - 0.5; t += 0.36) { this.noise(.05, .06, 2400, 900, t, 'bandpass', 2); this.click(.07, 1500, t + .04); }
      this.noise(.07, .07, 2200, 900, total - .32, 'bandpass', 2); this.click(.1, 1300, total - .28);
      this.noise(.06, .08, 2600, 1100, total - .16, 'bandpass', 2); this.click(.12, 1700, total - .12);
      return;
    }
    if (kind === 'rocket') {
      // a rocket slid into the tube, the latch clicks
      this.noise(.4, .05, 900, 1600, .25, 'bandpass', 1.2);
      this.click(.12, 1100, total * 0.75); this.tone('triangle', 260, 160, .08, .05, total * 0.75);
      return;
    }
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
  /** A punch: the swing's whoosh; on a body a heavy thump, a slap of the glove and a short crunch. */
  punch(hit: boolean) {
    this.noise(.11, .05, 500, 1900, 0, 'bandpass', 1.6);
    if (!hit) return;
    this.tone('sine', 130, 48, .12, .22, .03);
    this.noise(.06, .2, 2200, 500, .03, 'bandpass', 1.2);
    this.noise(.03, .09, 6000, 3000, .035, 'highpass');
    this.noise(.14, .1, 600, 90, .04);
  }
  /** A kick: a heavier swing; landing on someone / a crate, a deep boot thud. */
  kick(hit: boolean) {
    this.noise(.16, .07, 350, 1500, 0, 'bandpass', 1.4);
    if (!hit) return;
    this.tone('sine', 95, 36, .18, .28, .07);
    this.noise(.09, .2, 1500, 260, .07);
    this.noise(.2, .08, 500, 80, .09);
  }
  /** A body bursting: a wet splat, a crunch, drops pattering down. */
  gore(dist = 0) {
    const near = 1 / (1 + dist / 10);
    if (near < 0.05) return;
    this.noise(.32, .3 * near, 1100, 140);
    this.noise(.12, .18 * near, 520, 260, .01, 'bandpass', 3);
    this.tone('sine', 70, 30, .3, .22 * near);
    this.noise(.05, .1 * near, 4200, 1800, .02, 'bandpass', 2);
    for (let i = 0; i < 6; i++) this.noise(.04, .05 * near, 900 + Math.random() * 900, 300, .18 + i * .07 + Math.random() * .05, 'bandpass', 2.5);
  }
  /** Your own death: the world goes muffled, a dull thud and a ringing in the ears. */
  death() {
    this.tone('sine', 110, 40, .5, .25);
    this.noise(.6, .12, 500, 80);
    this.tone('sine', 3100, 3000, 2.2, .025, .1);
  }
  /** Grappling hook: the launcher's twang and the rope paying out. */
  hookFire() {
    this.tone('triangle', 900, 320, .09, .08);
    this.noise(.08, .1, 2600, 900);
    this.noise(.3, .04, 3800, 2200, .04, 'bandpass', 3);
  }
  /** The claw bites: a metal clank, then the winch ratchets. */
  hookBite(dist = 0) {
    const near = 1 / (1 + dist / 15);
    this.click(.14 * near, 2100);
    this.tone('triangle', 1400, 1150, .16, .05 * near);
    for (let i = 0; i < 7; i++) this.click(.035, 2800 - i * 60, .12 + i * .055);
  }
  /** Let go of the rope / the claw comes back. */
  hookRelease() { this.click(.07, 1600); this.noise(.12, .04, 1800, 3200, 0, 'bandpass', 2); }
  /** A hit on a crystal: a glassy ping (dull and short when shot from too far). */
  crystalHit(far: boolean, dist = 0) {
    const near = 1 / (1 + dist / 12);
    const f = 1900 + Math.random() * 900;
    if (far) { this.tone('triangle', f * 0.5, f * 0.45, .08, .03 * near); return; }
    this.tone('sine', f, f * 0.995, .45, .05 * near);
    this.tone('sine', f * 1.51, f * 1.5, .3, .025 * near);
    this.noise(.05, .06 * near, 7000, 4000, 0, 'highpass');
  }
  /** Your crystal is under attack: two short low alert tones. */
  alarm() { this.tone('square', 440, 440, .12, .03); this.tone('square', 330, 330, .16, .03, .16); }
  pickup() { this.tone('triangle',660,880,.05,.04);this.tone('triangle',880,990,.05,.03,.05); }
  eat() { this.noise(.06,.08,2600,900);this.noise(.06,.07,2200,800); }
  coins() { this.tone('square',1250,1250,.05,.02);this.tone('square',1660,1660,.09,.02,.06); }
  /** A bandit raises the pistol: the slide is racked — a metallic clack-clack (the burst is coming). */
  cock(dist = 0) {
    const near = 1 / (1 + dist / 10);
    if (near < 0.08) return;
    this.click(.11 * near, 2100);
    this.click(.13 * near, 1500, .09);
  }
  /** A grenade pin pulled and the spoon flying off. */
  pin(dist = 0) {
    const near = 1 / (1 + dist / 10);
    if (near < 0.08) return;
    this.click(.08 * near, 3400);
    this.tone('triangle', 2600, 1900, .12, .03 * near, .18);
  }
  /** Underarm throw: a short swish. */
  toss() { this.noise(.14,.06,900,2600,0,'bandpass',1.2); }
  /** A bottle breaking: a bright crash and a few glass tinkles after it. */
  shatter(dist = 0) {
    const near = 1 / (1 + dist / 8);
    this.noise(.16, .2 * near, 7000, 2500, 0, 'highpass');
    this.noise(.05, .12 * near, 2600, 900);
    for (let i = 0; i < 4; i++) { const f = 3200 + Math.random() * 2600; this.tone('sine', f, f * .97, .07, .025 * near, .04 + i * .035 + Math.random() * .02); }
  }
  /** A soft thing landing on the ground. */
  thud(dist = 0) { const near = 1 / (1 + dist / 6); this.noise(.07, .08 * near, 700, 150); }
  /** Medkit: the case snaps open, a bandage tears. */
  patch() { this.click(.07, 1800); this.noise(.22, .06, 2800, 1400, .08, 'bandpass', 1.5); }
  splash() { this.noise(.35,.12,1600,200); }
  cast() { this.noise(.18,.05,4200,1200);this.tone('sine',900,300,.18,.02); }
  bite() { this.tone('sine',520,420,.08,.06);this.tone('sine',520,420,.08,.06,.12); }
  reel() { for (let i=0;i<6;i++) this.tone('square',2400,2200,.015,.015,i*.04); }
  /** Footstep: soft for a quiet walk / crouch. */
  step(soft = false) {
    const v = soft ? .25 : 1;
    this.noise(.06, .07 * v, 900 + Math.random() * 500, 180, 0, 'lowpass');
    this.tone('sine', 85 + Math.random() * 20, 50, .05, .05 * v);
  }
  /** Landing after a fall at `speed` m/s. */
  land(speed: number) {
    const v = Math.min(1, speed / 14);
    this.noise(.12, .14 * v + .03, 700, 120);
    this.tone('sine', 70, 38, .12, .14 * v);
  }

  /** The start flight: air rushing past, rising then falling. */
  whoosh() {
    const c = this.ctx; if (!c || !this.volume) return;
    this.ensureNoiseBuf(c);
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), t = c.currentTime;
    src.buffer = this.noiseBuf; src.loop = true; f.type = 'bandpass'; f.Q.value = 0.9;
    f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(1800, t + 1.6); f.frequency.exponentialRampToValueAtTime(400, t + 2.6);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16 * this.volume, t + 1.4); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.7);
    src.connect(f).connect(g).connect(c.destination); src.start(t); src.stop(t + 2.8);
  }
  /** Sprint kicks in: a short gust and a breath. */
  sprint() { this.noise(.35,.07,500,2200,0,'bandpass',1.1); this.noise(.25,.03,900,500,.05); }
  /** Hard landing that hurt. */
  fallHurt() { this.noise(.18,.22,900,120); this.tone('sine',120,40,.25,.2); this.noise(.06,.1,3200,1500,.02,'bandpass',3); }
  private loops = new Map<string, { g: GainNode; f: BiquadFilterNode }>();
  /**
   * A continuous noise layer at `level` 0..1 (0 = silent): 'wind' while running fast / falling, 'scrape' while
   * sliding down a wall. Created on first use, then only its gain and filter move.
   */
  loop(name: 'wind' | 'scrape', level: number) {
    const c = this.ctx; if (!c || c.state !== 'running') return;
    let l = this.loops.get(name);
    if (!l) {
      if (level <= 0.001) return;
      this.ensureNoiseBuf(c);
      const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
      src.buffer = this.noiseBuf; src.loop = true;
      f.type = name === 'wind' ? 'bandpass' : 'highpass'; f.Q.value = name === 'wind' ? 0.6 : 0.8;
      f.frequency.value = name === 'wind' ? 600 : 1800;
      g.gain.value = 0;
      src.connect(f).connect(g).connect(c.destination); src.start();
      l = { g, f };
      this.loops.set(name, l);
    }
    const t = c.currentTime, v = Math.max(0, Math.min(1, level));
    l.g.gain.setTargetAtTime(v * (name === 'wind' ? 0.09 : 0.015) * this.volume, t, 0.08);
    if (name === 'wind') l.f.frequency.setTargetAtTime(450 + v * 1400, t, 0.1);
  }
  explosion() {
    this.noise(.75, .28, 2200, 80);
    this.tone('sine', 115, 28, .55, .26);
    this.noise(.35, .14, 900, 140, .06);
  }
  /** Car explosion: metallic crunch + deep fuel-tank detonation + shattering glass + debris rattle. */
  carExplode(dist = 0) {
    const near = 1 / (1 + dist / 18);
    if (near < 0.04) return;
    // Initial metal crumple & horn cut-off
    this.tone('sawtooth', 390, 180, .14, .16 * near);
    this.noise(.15, .24 * near, 2800, 450, 0, 'bandpass', 1.5);
    // Fuel tank boom
    this.noise(.95, .36 * near, 2400, 65, .04);
    this.tone('sine', 105, 24, .75, .34 * near, .04);
    this.tone('triangle', 165, 38, .48, .22 * near, .06);
    // Secondary fireball & glass shatter
    this.noise(.45, .18 * near, 6500, 1800, .08, 'highpass');
    for (let i = 0; i < 5; i++) {
      const d = 0.16 + i * 0.08 + Math.random() * 0.05;
      this.click(.11 * near, 1600 + Math.random() * 1800, d);
      this.tone('sine', 2800 + Math.random() * 2200, 1900, .08, .03 * near, d);
    }
  }
  /** Car horn / alarm when a car is shot. */
  carAlarm(dist = 0) {
    const near = 1 / (1 + dist / 15);
    if (near < 0.05) return;
    this.tone('sawtooth', 415, 410, .16, .09 * near);
    this.tone('sawtooth', 520, 515, .16, .09 * near);
  }
  /** Crossbow shot: bowstring snap + energy bolt release scaled by charge level (0..3). */
  crossbowShot(level = 0, dist = 0) {
    const near = 1 / (1 + dist / 18);
    if (near < 0.04) return;
    const p = 1 + level * 0.35;
    this.tone('triangle', 680 / p, 160, .14 + level * .05, .18 * near);
    this.noise(.12 + level * .06, (.16 + level * .05) * near, 3400, 420);
    this.click(.14 * near, 2200 - level * 250);
    if (level >= 1) {
      this.tone('sine', 240 * p, 58, .22 + level * .06, (.14 + level * .04) * near, .02);
    }
  }
  /** Crossbow charge level tick (1..3). */
  crossbowCharge(level: number) {
    const f = 520 + level * 220;
    this.tone('sine', f, f * 1.18, .09, .06);
    this.click(.06, 1500 + level * 350);
  }
  /** Crystal Stage 1 10-second invulnerability blast & mass revival chime. */
  crystalBlast(dist = 0) {
    const near = 1 / (1 + dist / 25);
    this.noise(.85, .32 * near, 2600, 70);
    this.tone('sine', 120, 26, .7, .3 * near);
    for (const [i, n] of [523.25, 659.25, 783.99, 1046.5].entries()) {
      this.tone('triangle', n, n * 1.005, .55, .08 * near, .06 + i * .06);
    }
  }
  /** A wall or crate breaking apart. */
  blockBreak(material: 'wood' | 'stone' | 'metal', dist = 0) {
    const near = 1 / (1 + dist / 12);
    if (near < 0.05) return;
    if (material === 'wood') {
      this.noise(.22, .18 * near, 1800, 260);
      this.tone('triangle', 210, 75, .18, .12 * near);
      this.click(.1 * near, 1100, .04);
    } else if (material === 'metal') {
      this.tone('triangle', 1400, 420, .25, .1 * near);
      this.noise(.25, .16 * near, 3200, 400);
      this.click(.14 * near, 2400);
    } else {
      this.noise(.28, .2 * near, 1200, 160);
      this.tone('sine', 130, 45, .22, .14 * near);
    }
  }
  /** Bandit melee spark telegraph. */
  spark(dist = 0) {
    const near = 1 / (1 + dist / 12);
    if (near < 0.05) return;
    this.tone('sawtooth', 1800, 3200, .14, .06 * near);
    this.noise(.12, .1 * near, 6000, 2200, 0, 'highpass');
    this.click(.12 * near, 2800);
  }
  /** Bandit melee dash strike. */
  meleeDash(dist = 0) {
    const near = 1 / (1 + dist / 12);
    if (near < 0.05) return;
    this.noise(.18, .16 * near, 600, 2200, 0, 'bandpass', 1.4);
    this.tone('sine', 140, 45, .16, .18 * near, .02);
  }
}
