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
  private noise(duration: number, volume: number, from: number, to: number) {
    const c = this.ctx; if (!c || !this.volume) return;
    const b=c.createBuffer(1,Math.ceil(c.sampleRate*duration),c.sampleRate), a=b.getChannelData(0);
    for(let i=0;i<a.length;i++) a[i]=(Math.random()*2-1);
    const src=c.createBufferSource(), f=c.createBiquadFilter(), g=c.createGain(), t=c.currentTime;
    src.buffer=b; f.type='lowpass';f.frequency.setValueAtTime(from,t);f.frequency.exponentialRampToValueAtTime(to,t+duration);
    g.gain.setValueAtTime(volume*this.volume,t);g.gain.exponentialRampToValueAtTime(.0001,t+duration);
    src.connect(f).connect(g).connect(c.destination);src.start(t);src.stop(t+duration);
  }
  place() { this.noise(.15,.12,900,300);this.tone('triangle',160,100,.14,.09);this.tone('square',420,320,.05,.04,.05); }
  remove() { this.noise(.23,.14,1300,220);this.tone('triangle',220,80,.18,.09); }
  select() { this.tone('triangle',520,640,.06,.045); }
  reject() { this.tone('square',180,120,.1,.035); }
  shot(light = false) { if (light) { this.noise(.07,.09,3200,700);this.tone('triangle',170,70,.08,.07); } else { this.noise(.09,.10,2400,500);this.tone('triangle',115,50,.10,.09); } }
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
