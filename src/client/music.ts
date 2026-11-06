/**
 * The match intro theme, synthesised (no files): ~21 s in D minor at 84 bpm, built up in layers like a trailer cue —
 * a low string pad, then the drums, a bass ostinato, a horn melody over i–VI–III–VII, a drum roll and one big hit on
 * a D major chord as the camera reaches the player, ringing out in a large hall reverb.
 */
const BEAT = 60 / 84;
const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);
// D minor progression, one chord per bar: Dm, Bb, F, C (MIDI notes, low voicing)
const CHORDS = [[50, 57, 62, 65], [46, 53, 58, 62], [53, 57, 60, 65], [48, 55, 60, 64]];
const ROOTS = [38, 34, 41, 36];
/** Horn melody in bars 4–7: [beat from bar 4, length in beats, midi]. */
const MELODY: [number, number, number][] = [
  [0, 1.5, 62], [1.5, 0.5, 64], [2, 2, 65],
  [4, 1.5, 65], [5.5, 0.5, 67], [6, 2, 69],
  [8, 1, 72], [9, 1, 69], [10, 2, 65],
  [12, 1.5, 67], [13.5, 0.5, 65], [14, 2, 64],
];
/** Length of the whole cue, s (bars 0–7 + the final chord's ring). */
export const INTRO_MUSIC_LENGTH = 8 * 4 * BEAT + 5;

function impulse(c: AudioContext, seconds: number, decay: number) {
  const len = Math.floor(c.sampleRate * seconds);
  const b = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** decay;
  }
  return b;
}

export function playIntroMusic(c: AudioContext, volume: number) {
  const t0 = c.currentTime + 0.1;
  const master = c.createGain();
  master.gain.value = volume * 0.9;
  master.connect(c.destination);
  const verb = c.createConvolver();
  verb.buffer = impulse(c, 3.2, 2.4);
  const wet = c.createGain();
  wet.gain.value = 0.55;
  verb.connect(wet).connect(master);
  const bus = c.createGain();
  bus.connect(master);
  bus.connect(verb);
  const nodes: AudioScheduledSourceNode[] = [];

  /** A voice with an attack / release envelope through a lowpass. */
  const voice = (type: OscillatorType, freq: number, at: number, len: number, vol: number, cutoff: number, attack = 0.05, release = 0.3, detune = 0) => {
    const o = c.createOscillator(), f = c.createBiquadFilter(), g = c.createGain();
    o.type = type; o.frequency.value = freq; o.detune.value = detune;
    f.type = 'lowpass'; f.frequency.value = cutoff; f.Q.value = 0.7;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(vol, at + attack);
    g.gain.setValueAtTime(vol, at + Math.max(attack, len - release));
    g.gain.linearRampToValueAtTime(0, at + len);
    o.connect(f).connect(g).connect(bus);
    o.start(at); o.stop(at + len + 0.05);
    nodes.push(o);
    return f;
  };
  let noiseBuf: AudioBuffer | null = null;
  const drum = (at: number, vol: number, low = true) => {
    // taiko: a pitched thump and a short skin noise
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(low ? 110 : 190, at);
    o.frequency.exponentialRampToValueAtTime(low ? 42 : 80, at + 0.35);
    g.gain.setValueAtTime(vol, at);
    g.gain.exponentialRampToValueAtTime(0.001, at + (low ? 0.9 : 0.4));
    o.connect(g).connect(bus);
    o.start(at); o.stop(at + 1);
    nodes.push(o);
    noiseBuf ??= impulse(c, 0.3, 4);
    const n = c.createBufferSource(), nf = c.createBiquadFilter(), ng = c.createGain();
    n.buffer = noiseBuf; nf.type = 'lowpass'; nf.frequency.value = low ? 900 : 2200; ng.gain.value = vol * 0.5;
    n.connect(nf).connect(ng).connect(bus);
    n.start(at);
    nodes.push(n);
  };

  const bar = 4 * BEAT;
  for (let b = 0; b < 8; b++) {
    const at = t0 + b * bar;
    const ch = CHORDS[b % 4];
    // strings: three detuned saws per note, the filter opening as the cue builds
    const open = 500 + b * 260;
    for (const n of ch) for (const d of [-9, 0, 8]) voice('sawtooth', midi(n + 12), at, bar + 0.25, 0.012 + b * 0.0016, open, 0.6, 0.5, d);
    // low brass ostinato from bar 2: driving eighths on the root
    if (b >= 2) for (let e = 0; e < 8; e++) voice('sawtooth', midi(ROOTS[b % 4]), at + e * BEAT / 2, BEAT / 2 - 0.03, e % 2 ? 0.035 : 0.05, 520, 0.01, 0.08);
    else voice('sawtooth', midi(ROOTS[b % 4]), at, bar, 0.04, 300, 0.8, 0.6);
    // drums from bar 1, busier toward the end
    if (b >= 1) {
      drum(at, 0.5); drum(at + 2 * BEAT, 0.42);
      if (b >= 3) { drum(at + 1.5 * BEAT, 0.25, false); drum(at + 3.5 * BEAT, 0.28, false); }
      if (b >= 5) { drum(at + BEAT, 0.32); drum(at + 3 * BEAT, 0.35); }
    }
  }
  // horn melody (bars 4–7): two square-ish voices an octave apart, soft attack
  for (const [beat, len, n] of MELODY) {
    const at = t0 + 4 * bar + beat * BEAT;
    voice('sawtooth', midi(n), at, len * BEAT, 0.05, 1500, 0.08, 0.12);
    voice('triangle', midi(n - 12), at, len * BEAT, 0.05, 1200, 0.08, 0.12);
  }
  // roll into the hit
  const end = t0 + 8 * bar;
  for (let k = 0; k < 12; k++) drum(end - bar / 2 + k * bar / 24, 0.12 + k * 0.03, k % 2 === 0);
  // the hit: D major, everything at once, then rings out
  drum(end, 0.9); drum(end + 0.02, 0.6, false);
  for (const n of [38, 50, 57, 62, 66, 69, 74]) for (const d of [-7, 7]) voice('sawtooth', midi(n), end, 4.6, n < 45 ? 0.05 : 0.022, 2200, 0.03, 3.8, d);

  return {
    /** Fade out over `seconds` (skipping the intro). */
    stop(seconds = 1.5) {
      const t = c.currentTime;
      master.gain.cancelScheduledValues(t);
      master.gain.setValueAtTime(master.gain.value, t);
      master.gain.linearRampToValueAtTime(0, t + seconds);
      setTimeout(() => { for (const n of nodes) try { n.stop(); } catch { /* already stopped */ } master.disconnect(); }, seconds * 1000 + 100);
    },
  };
}
