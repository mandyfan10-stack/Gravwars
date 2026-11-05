import { CanvasTexture, RepeatWrapping, SRGBColorSpace, Texture } from 'three';
import { Rng } from '../../shared/math';

type Ctx = CanvasRenderingContext2D;

function canvas(w: number, h = w): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function tex(c: HTMLCanvasElement, srgb = true): Texture {
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = SRGBColorSpace;
  return t;
}

const grey = (v: number, a = 1) => `rgba(${v | 0},${v | 0},${v | 0},${a})`;

/** Random speckles / blotches: gives large flat surfaces some life. */
function speckle(g: Ctx, S: number, rng: Rng, n: number, min: number, max: number, size: number, alpha: number) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = grey(rng.range(min, max), alpha);
    const s = rng.range(size * 0.3, size);
    g.fillRect(rng.range(0, S), rng.range(0, S), s, s);
  }
}

/** Near-white detail textures that get multiplied by the instance color (world-space triplanar). */
export function groundTextures() {
  const S = 256;
  const rng = new Rng(11);

  // paving: 0.5 m stone tiles in running bond (texture = 2 m)
  const [cp, p] = canvas(S);
  p.fillStyle = grey(232);
  p.fillRect(0, 0, S, S);
  const tile = S / 4;
  for (let y = 0; y < 8; y++) for (let x = -1; x < 5; x++) {
    const off = (y % 2) * tile * 0.5;
    p.fillStyle = grey(rng.range(224, 248));
    p.fillRect(x * tile + off + 1.5, y * tile / 2 + 1.5, tile - 3, tile / 2 - 3);
  }
  speckle(p, S, rng, 900, 180, 255, 3, 0.25);

  // asphalt: fine noise
  const [ca, a] = canvas(S);
  a.fillStyle = grey(200);
  a.fillRect(0, 0, S, S);
  speckle(a, S, rng, 5000, 140, 255, 2.5, 0.35);
  for (let i = 0; i < 6; i++) {
    a.strokeStyle = grey(120, 0.25);
    a.lineWidth = rng.range(1, 2.5);
    a.beginPath();
    let x = rng.range(0, S);
    let y = rng.range(0, S);
    a.moveTo(x, y);
    for (let k = 0; k < 6; k++) a.lineTo((x += rng.range(-30, 30)), (y += rng.range(-30, 30)));
    a.stroke();
  }

  // grass: blades / clumps
  const [cg, gr] = canvas(S);
  gr.fillStyle = grey(215);
  gr.fillRect(0, 0, S, S);
  for (let i = 0; i < 260; i++) {
    gr.fillStyle = grey(rng.range(150, 255), 0.35);
    gr.beginPath();
    gr.arc(rng.range(0, S), rng.range(0, S), rng.range(4, 18), 0, Math.PI * 2);
    gr.fill();
  }
  for (let i = 0; i < 5000; i++) {
    gr.fillStyle = grey(rng.range(120, 255), 0.5);
    gr.fillRect(rng.range(0, S), rng.range(0, S), 1, rng.range(2, 4));
  }

  // concrete: soft blotches + panel seams (texture = 4 m)
  const [cc, c] = canvas(S);
  c.fillStyle = grey(228);
  c.fillRect(0, 0, S, S);
  for (let i = 0; i < 120; i++) {
    c.fillStyle = grey(rng.range(190, 255), 0.18);
    c.beginPath();
    c.arc(rng.range(0, S), rng.range(0, S), rng.range(8, 40), 0, Math.PI * 2);
    c.fill();
  }
  speckle(c, S, rng, 1500, 160, 255, 2, 0.3);
  c.fillStyle = grey(170, 0.6);
  c.fillRect(0, 0, S, 2);
  c.fillRect(0, 0, 2, S);

  // stone / sandstone blocks (texture = 2 m)
  const [cs, s] = canvas(S);
  s.fillStyle = grey(190);
  s.fillRect(0, 0, S, S);
  for (let y = 0; y < 4; y++) for (let x = -1; x < 3; x++) {
    const off = (y % 2) * 64;
    s.fillStyle = grey(rng.range(215, 250));
    s.fillRect(x * 128 + off + 2, y * 64 + 2, 124, 60);
  }
  speckle(s, S, rng, 1500, 170, 255, 2.5, 0.3);

  // plaster
  const [cpl, pl] = canvas(S);
  pl.fillStyle = grey(240);
  pl.fillRect(0, 0, S, S);
  for (let i = 0; i < 160; i++) {
    pl.fillStyle = grey(rng.range(205, 255), 0.15);
    pl.beginPath();
    pl.arc(rng.range(0, S), rng.range(0, S), rng.range(6, 30), 0, Math.PI * 2);
    pl.fill();
  }
  speckle(pl, S, rng, 1200, 190, 255, 2, 0.25);

  // water ripples
  const [cw, w] = canvas(S);
  w.fillStyle = grey(205);
  w.fillRect(0, 0, S, S);
  for (let i = 0; i < 140; i++) {
    w.strokeStyle = grey(rng.range(225, 255), 0.5);
    w.lineWidth = rng.range(1, 3);
    w.beginPath();
    const x = rng.range(0, S);
    const y = rng.range(0, S);
    w.ellipse(x, y, rng.range(8, 30), rng.range(2, 6), 0, 0, Math.PI * 2);
    w.stroke();
  }

  return {
    paving: tex(cp), asphalt: tex(ca), grass: tex(cg), concrete: tex(cc), stone: tex(cs), plaster: tex(cpl), water: tex(cw),
  };
}

/**
 * Old-town facade atlas: 4×4 cells, one cell = one window bay of 3×3 m, texture = 12×12 m.
 * Bottom row = ground floor (doors, shop windows). Returns [albedo, tintMask (white = tinted by wall color),
 * glass mask (white = window glass: the room behind it is drawn by the interior shader)].
 */
export function houseFacadeTextures(): [Texture, Texture, Texture] {
  const S = 512;
  const C = S / 4;
  const [ca, a] = canvas(S);
  const [cm, m] = canvas(S);
  const [cw, w] = canvas(S);
  w.fillStyle = '#000';
  w.fillRect(0, 0, S, S);
  const glass = (x: number, y: number, ww: number, hh: number) => { w.fillStyle = '#fff'; w.fillRect(x, y, ww, hh); };
  const frame = (x: number, y: number, ww: number, hh: number) => { w.fillStyle = '#000'; w.fillRect(x, y, ww, hh); };
  const rng = new Rng(21);
  a.fillStyle = grey(244);
  a.fillRect(0, 0, S, S);
  for (let i = 0; i < 400; i++) {
    a.fillStyle = grey(rng.range(215, 255), 0.18);
    a.beginPath();
    a.arc(rng.range(0, S), rng.range(0, S), rng.range(5, 30), 0, Math.PI * 2);
    a.fill();
  }
  m.fillStyle = '#fff';
  m.fillRect(0, 0, S, S);
  const both = (fn: (g: Ctx, mask: boolean) => void) => {
    fn(a, false);
    fn(m, true);
  };
  const rect = (g: Ctx, mask: boolean, color: string, x: number, y: number, w: number, h: number, maskV = 0) => {
    g.fillStyle = mask ? grey(maskV * 255) : color;
    g.fillRect(x, y, w, h);
  };
  const shutterCols = ['#4f7a4a', '#6b4a33', '#3f6680', '#7a6a4a'];
  for (let row = 0; row < 4; row++) {
    const y0 = row * C;
    const ground = row === 3;
    // cornice between floors (tinted, slightly darker)
    a.fillStyle = grey(205);
    a.fillRect(0, y0 + C - 7, S, 7);
    a.fillStyle = grey(255);
    a.fillRect(0, y0 + C - 9, S, 2);
    for (let col = 0; col < 4; col++) {
      const x0 = col * C;
      if (ground) {
        const shop = rng.chance(0.5);
        const ww = shop ? C * 0.7 : C * 0.36;
        const wx = x0 + (C - ww) / 2;
        const wy = y0 + C * 0.22;
        const wh = C * 0.7;
        both((g, mk) => {
          rect(g, mk, '#efe9dc', wx - 5, wy - 5, ww + 10, wh + 5);
          rect(g, mk, shop ? '#2e3a44' : '#5a3b26', wx, wy, ww, wh);
        });
        if (shop) {
          const grad = a.createLinearGradient(0, wy, 0, wy + wh);
          grad.addColorStop(0, '#5d7388');
          grad.addColorStop(1, '#27313a');
          a.fillStyle = grad;
          a.fillRect(wx, wy, ww, wh);
          a.fillStyle = '#e9e4d8';
          a.fillRect(wx + ww / 2 - 1.5, wy, 3, wh);
          glass(wx, wy, ww, wh);
          frame(wx + ww / 2 - 1.5, wy, 3, wh);
          // awning
          const aw = rng.pick(['#b8322a', '#2f6e4a', '#c9a23a', '#3b5c8c', '#8c3b5c']);
          both((g, mk) => {
            for (let k = 0; k < 8; k++) rect(g, mk, k % 2 ? aw : '#f1ece2', wx - 6 + k * (ww + 12) / 8, wy - 18, (ww + 12) / 8 + 0.5, 14);
          });
        } else {
          a.fillStyle = '#3e2919';
          a.fillRect(wx + ww / 2 - 1, wy, 2, wh);
          a.fillStyle = '#c9a76a';
          a.fillRect(wx + ww * 0.75, wy + wh * 0.5, 3, 3);
        }
        continue;
      }
      const ww = C * 0.36;
      const wh = C * 0.5;
      const wx = x0 + (C - ww) / 2;
      const wy = y0 + C * 0.22;
      both((g, mk) => {
        rect(g, mk, '#f3f0e8', wx - 5, wy - 5, ww + 10, wh + 10);
        rect(g, mk, '#d9d3c4', wx - 8, wy + wh + 4, ww + 16, 5);
      });
      const grad = a.createLinearGradient(0, wy, 0, wy + wh);
      grad.addColorStop(0, '#6f8698');
      grad.addColorStop(0.5, '#3b4955');
      grad.addColorStop(1, '#26303a');
      a.fillStyle = grad;
      a.fillRect(wx, wy, ww, wh);
      a.fillStyle = '#f3f0e8';
      a.fillRect(wx + ww / 2 - 1.5, wy, 3, wh);
      a.fillRect(wx, wy + wh * 0.38, ww, 3);
      glass(wx, wy, ww, wh);
      frame(wx + ww / 2 - 1.5, wy, 3, wh);
      frame(wx, wy + wh * 0.38, ww, 3);
      if (rng.chance(0.45)) {
        const sc = rng.pick(shutterCols);
        both((g, mk) => {
          rect(g, mk, sc, wx - 5 - ww * 0.5, wy - 4, ww * 0.5 - 1, wh + 8);
          rect(g, mk, sc, wx + ww + 6, wy - 4, ww * 0.5 - 1, wh + 8);
        });
        a.fillStyle = 'rgba(0,0,0,0.25)';
        for (let k = 0; k < 6; k++) {
          a.fillRect(wx - 5 - ww * 0.5, wy + k * (wh / 6), ww * 0.5 - 1, 1.5);
          a.fillRect(wx + ww + 6, wy + k * (wh / 6), ww * 0.5 - 1, 1.5);
        }
      } else if (rng.chance(0.3)) {
        // little balcony
        both((g, mk) => rect(g, mk, '#2c2c2e', wx - 10, wy + wh - 14, ww + 20, 3));
        for (let k = 0; k <= 8; k++) both((g, mk) => rect(g, mk, '#2c2c2e', wx - 10 + k * (ww + 20) / 8, wy + wh - 14, 1.5, 22));
        frame(wx - 10, wy + wh - 14, ww + 20, 3);
        for (let k = 0; k <= 8; k++) frame(wx - 10 + k * (ww + 20) / 8, wy + wh - 14, 1.5, 22);
        if (rng.chance(0.6)) {
          a.fillStyle = rng.pick(['#d0453a', '#e07ab0', '#f0d040']);
          for (let k = 0; k < 7; k++) {
            a.beginPath();
            a.arc(wx - 6 + rng.range(0, ww + 12), wy + wh - 14 + rng.range(-4, 2), rng.range(2, 4), 0, Math.PI * 2);
            a.fill();
          }
          m.fillStyle = '#000';
          m.fillRect(wx - 10, wy + wh - 20, ww + 20, 8);
          frame(wx - 10, wy + wh - 20, ww + 20, 8);
        }
      }
    }
  }
  return [tex(ca), tex(cm, false), tex(cw, false)];
}

/** Clay roof tiles (texture = 2×2 m), white-ish: tinted by the roof color. */
export function roofTexture(): Texture {
  const S = 256;
  const [c, g] = canvas(S);
  const rng = new Rng(5);
  g.fillStyle = grey(120);
  g.fillRect(0, 0, S, S);
  const rows = 8;
  const cols = 8;
  const th = S / rows;
  const tw = S / cols;
  for (let r = 0; r < rows; r++) for (let k = -1; k <= cols; k++) {
    const x = k * tw + (r % 2) * tw * 0.5;
    const y = r * th;
    const v = rng.range(200, 255);
    const grad = g.createLinearGradient(x, 0, x + tw, 0);
    grad.addColorStop(0, grey(v * 0.72));
    grad.addColorStop(0.45, grey(v));
    grad.addColorStop(1, grey(v * 0.62));
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(x + 1, y);
    g.lineTo(x + tw - 1, y);
    g.lineTo(x + tw - 1, y + th - 3);
    g.quadraticCurveTo(x + tw / 2, y + th + 2, x + 1, y + th - 3);
    g.closePath();
    g.fill();
  }
  speckle(g, S, rng, 600, 90, 200, 2, 0.25);
  return tex(c);
}

/** Glass curtain wall (texture = 12×12 m: 4 floors × 6 panels). Returns [albedo, glass mask]. */
export function glassFacadeTexture(): [Texture, Texture] {
  const S = 512;
  const [c, g] = canvas(S);
  const [cw, w] = canvas(S);
  const rng = new Rng(31);
  const fh = S / 4;
  const pw = S / 6;
  for (let f = 0; f < 4; f++) for (let k = 0; k < 6; k++) {
    const x = k * pw;
    const y = f * fh;
    const grad = g.createLinearGradient(x, y, x + pw * 0.6, y + fh);
    const t = rng.range(0, 1);
    const top = t < 0.3 ? [150, 175, 190] : t < 0.7 ? [120, 150, 170] : [175, 185, 185];
    grad.addColorStop(0, `rgb(${top[0] + 30},${top[1] + 30},${top[2] + 25})`);
    grad.addColorStop(1, `rgb(${top[0] - 50},${top[1] - 45},${top[2] - 40})`);
    g.fillStyle = grad;
    g.fillRect(x, y, pw, fh);
    if (rng.chance(0.25)) {
      g.fillStyle = 'rgba(240,230,210,0.25)';
      g.fillRect(x + 4, y + fh * 0.2, pw - 8, fh * 0.5);
    }
  }
  g.fillStyle = '#d6d9da';
  for (let k = 0; k <= 6; k++) g.fillRect(k * pw - 2, 0, 4, S);
  for (let f = 0; f <= 4; f++) {
    g.fillStyle = '#c8cccd';
    g.fillRect(0, f * fh - 7, S, 14);
    g.fillStyle = '#8f9496';
    g.fillRect(0, f * fh + 6, S, 2);
  }
  // glass everywhere except mullions and the floor bands
  w.fillStyle = '#fff';
  w.fillRect(0, 0, S, S);
  w.fillStyle = '#000';
  for (let k = 0; k <= 6; k++) w.fillRect(k * pw - 2, 0, 4, S);
  for (let f = 0; f <= 4; f++) w.fillRect(0, f * fh - 7, S, 16);
  return [tex(c), tex(cw, false)];
}

/** Concrete office block with ribbon windows (texture = 12×12 m). Returns [albedo, glass mask]. */
export function officeFacadeTexture(): [Texture, Texture] {
  const S = 512;
  const [c, g] = canvas(S);
  const [cw, w] = canvas(S);
  w.fillStyle = '#000';
  w.fillRect(0, 0, S, S);
  const rng = new Rng(41);
  g.fillStyle = grey(236);
  g.fillRect(0, 0, S, S);
  speckle(g, S, rng, 2500, 190, 255, 2, 0.3);
  const fh = S / 4;
  for (let f = 0; f < 4; f++) {
    const y = f * fh + fh * 0.3;
    const h = fh * 0.48;
    for (let k = 0; k < 8; k++) {
      const x = k * (S / 8) + 3;
      const grad = g.createLinearGradient(0, y, 0, y + h);
      grad.addColorStop(0, '#7d909c');
      grad.addColorStop(1, '#2f3a42');
      g.fillStyle = grad;
      g.fillRect(x, y, S / 8 - 6, h);
      w.fillStyle = '#fff';
      w.fillRect(x, y, S / 8 - 6, h);
      if (rng.chance(0.3)) {
        // blinds pulled down part of the way: opaque, no room behind them
        const bh = h * rng.range(0.2, 0.6);
        g.fillStyle = 'rgba(230,225,210,0.7)';
        g.fillRect(x, y, S / 8 - 6, bh);
        w.fillStyle = '#000';
        w.fillRect(x, y, S / 8 - 6, bh);
      }
    }
    g.fillStyle = grey(200);
    g.fillRect(0, y + h, S, 4);
  }
  return [tex(c), tex(cw, false)];
}

/** Central island: warm sandstone slabs with golden rune grooves (texture = 4 m). Returns [albedo, emissive]. */
export function coreTextures(): [Texture, Texture] {
  const S = 512;
  const [ca, a] = canvas(S);
  const [ce, e] = canvas(S);
  const rng = new Rng(3);
  a.fillStyle = '#9c8a6a';
  a.fillRect(0, 0, S, S);
  e.fillStyle = '#000';
  e.fillRect(0, 0, S, S);
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const v = rng.range(0.9, 1.05);
    a.fillStyle = `rgb(${(222 * v) | 0},${(204 * v) | 0},${(168 * v) | 0})`;
    a.fillRect(x * 128 + 3, y * 128 + 3, 122, 122);
  }
  speckle(a, S, rng, 3000, 150, 255, 2.5, 0.2);
  a.strokeStyle = '#a8916a';
  a.lineWidth = 6;
  e.strokeStyle = '#ffb43c';
  e.lineWidth = 3;
  for (const g of [a, e]) {
    g.beginPath();
    g.arc(256, 256, 150, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    for (let i = 0; i <= 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      const x = 256 + Math.cos(ang) * 150;
      const y = 256 + Math.sin(ang) * 150;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    g.beginPath();
    g.arc(256, 256, 40, 0, Math.PI * 2);
    g.stroke();
  }
  return [tex(ca), tex(ce)];
}
