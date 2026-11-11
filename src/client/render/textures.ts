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

/** Texels per metre of the world's pixel textures (the retro look: crisp texels, a few shades each). */
export const TEXELS_PER_M = 16;

/** A grey level snapped to steps of `step` (pixel-art shading uses a few distinct shades, no smooth ramps). */
const snap = (v: number, step = 8) => Math.max(0, Math.min(255, Math.round(v / step) * step));

/** One pixel (or a block of them) of a grey. */
function px(g: Ctx, x: number, y: number, v: number, w = 1, h = 1) {
  g.fillStyle = grey(snap(v));
  g.fillRect(x, y, w, h);
}

/** Tileable value noise in [0, 1] on an S×S grid (`cells` random knots per side, bilinear between them). */
function tileNoise(S: number, cells: number, rng: Rng): (x: number, y: number) => number {
  const knots = Array.from({ length: cells * cells }, () => rng.range(0, 1));
  const at = (i: number, j: number) => knots[((j % cells) + cells) % cells * cells + (((i % cells) + cells) % cells)];
  const sm = (t: number) => t * t * (3 - 2 * t);
  return (x, y) => {
    const fx = (x / S) * cells, fy = (y / S) * cells;
    const i = Math.floor(fx), j = Math.floor(fy);
    const tx = sm(fx - i), ty = sm(fy - j);
    const a = at(i, j) + (at(i + 1, j) - at(i, j)) * tx;
    const b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * tx;
    return a + (b - a) * ty;
  };
}

/** Fill every pixel from a shade function. */
function shade(g: Ctx, S: number, f: (x: number, y: number) => number) {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) px(g, x, y, f(x, y));
}

/**
 * Near-white detail textures that get multiplied by the instance color (world-space triplanar), drawn pixel by
 * pixel at TEXELS_PER_M: tiles and blocks with a light top edge and dark joints, clumpy noise in a few shades.
 */
export function groundTextures() {
  const T = TEXELS_PER_M;
  const rng = new Rng(11);

  // paving (2 m): 0.5 × 0.25 m stone tiles in running bond
  const SP = 2 * T;
  const [cp, p] = canvas(SP);
  {
    const tw = T / 2, th = T / 4;
    for (let r = 0; r < SP / th; r++) for (let k = -1; k <= SP / tw; k++) {
      const x0 = k * tw + (r % 2) * (tw / 2), y0 = r * th;
      const v = rng.range(222, 246);
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
        const X = x0 + x;
        if (X < 0 || X >= SP) continue;
        const joint = x === tw - 1 || y === th - 1;
        px(p, X, y0 + y, joint ? 196 : y === 0 ? v + 8 : v + (rng.chance(0.08) ? rng.pick([-12, 10]) : 0));
      }
    }
  }

  // asphalt (3 m): fine grit in three shades over soft blotches, a few cracks
  const SA = 3 * T;
  const [ca, a] = canvas(SA);
  {
    const n = tileNoise(SA, 6, rng);
    shade(a, SA, (x, y) => 200 + (n(x, y) - 0.5) * 26 + rng.pick([-10, 0, 0, 0, 8]));
    for (let i = 0; i < 3; i++) {
      let x = rng.int(0, SA - 1), y = rng.int(0, SA - 1);
      for (let k = 0; k < rng.int(8, 16); k++) {
        px(a, ((x % SA) + SA) % SA, ((y % SA) + SA) % SA, 150);
        if (rng.chance(0.5)) x += rng.pick([-1, 1]); else y += rng.pick([-1, 1]);
      }
    }
  }

  // grass (3 m): clumps of light and dark, short blades
  const SG = 3 * T;
  const [cg, gr] = canvas(SG);
  {
    const n = tileNoise(SG, 4, rng);
    shade(gr, SG, (x, y) => 212 + (n(x, y) - 0.5) * 44);
    for (let i = 0; i < SG * SG * 0.18; i++) {
      const x = rng.int(0, SG - 1), y = rng.int(0, SG - 2);
      px(gr, x, y, rng.chance(0.55) ? 170 : 245, 1, 2);
    }
  }

  // concrete (4 m): blotches, specks, a panel joint along two edges, formwork tie holes
  const SC = 4 * T;
  const [cc, c] = canvas(SC);
  {
    const n = tileNoise(SC, 5, rng);
    shade(c, SC, (x, y) => 226 + (n(x, y) - 0.5) * 22 + (rng.chance(0.07) ? rng.pick([-18, 14]) : 0));
    px(c, 0, 0, 182, SC, 1);
    px(c, 0, 0, 182, 1, SC);
    for (const tx of [SC / 4, (SC * 3) / 4]) for (const ty of [SC / 4, (SC * 3) / 4]) {
      px(c, tx, ty, 168);
      px(c, tx + 1, ty + 1, 244);
    }
  }

  // stone / sandstone blocks (2 m): 1 × 0.5 m blocks, mortar joints, bevelled edges
  const SS = 2 * T;
  const [cs, st] = canvas(SS);
  {
    const bw = T, bh = T / 2;
    for (let r = 0; r < SS / bh; r++) for (let k = -1; k <= SS / bw; k++) {
      const x0 = k * bw + (r % 2) * (bw / 2), y0 = r * bh;
      const v = rng.range(212, 246);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const X = x0 + x;
        if (X < 0 || X >= SS) continue;
        const mortar = x === bw - 1 || y === bh - 1;
        const edge = y === 0 || x === 0 ? 10 : y === bh - 2 || x === bw - 2 ? -12 : 0;
        px(st, X, y0 + y, mortar ? 178 : v + edge + (rng.chance(0.1) ? rng.pick([-10, 8]) : 0));
      }
    }
  }

  // plaster (3 m): faint blotches and specks
  const SL = 3 * T;
  const [cpl, pl] = canvas(SL);
  {
    const n = tileNoise(SL, 5, rng);
    shade(pl, SL, (x, y) => 238 + (n(x, y) - 0.5) * 18 + (rng.chance(0.05) ? -14 : 0));
  }

  // water ripples (3 m)
  const SW_ = 3 * T;
  const [cw, w] = canvas(SW_);
  {
    shade(w, SW_, () => 205);
    for (let i = 0; i < 26; i++) {
      const x = rng.int(0, SW_ - 1), y = rng.int(0, SW_ - 1), len = rng.int(3, 7);
      px(w, x, y, 245, len, 1);
    }
  }

  return {
    paving: tex(cp), asphalt: tex(ca), grass: tex(cg), concrete: tex(cc), stone: tex(cs), plaster: tex(cpl), water: tex(cw),
  };
}

/**
 * A detailed canvas brought down to the pixel look: `size` texels per side (box-filtered), every channel snapped
 * to `step`. Masks (`mask`) end up pure black / white.
 */
function pixelate(c: HTMLCanvasElement, size: number, step = 12, mask = false): HTMLCanvasElement {
  let src = c;
  // halve while far above the target: a plain one-step shrink would skip most of the source pixels
  while (src.width / 2 >= size * 1.5) {
    const [h, hg] = canvas(src.width / 2, src.height / 2);
    hg.imageSmoothingQuality = 'high';
    hg.drawImage(src, 0, 0, h.width, h.height);
    src = h;
  }
  const [o, og] = canvas(size, Math.round((size * c.height) / c.width));
  og.imageSmoothingQuality = 'high';
  og.drawImage(src, 0, 0, o.width, o.height);
  const img = og.getImageData(0, 0, o.width, o.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let k = 0; k < 3; k++) d[i + k] = mask ? (d[i + k] > 127 ? 255 : 0) : snap(d[i + k], step);
    if (d[i + 3] < 255) d[i + 3] = mask ? (d[i + 3] > 127 ? 255 : 0) : snap(d[i + 3], 16);
  }
  og.putImageData(img, 0, 0);
  return o;
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
  const n = 12 * TEXELS_PER_M;
  return [tex(pixelate(ca, n)), tex(pixelate(cm, n, 12, true), false), tex(pixelate(cw, n, 12, true), false)];
}

/** Clay roof tiles (texture = 2×2 m), white-ish: tinted by the roof color. Rounded tiles: lit left, shaded right. */
export function roofTexture(): Texture {
  const T = TEXELS_PER_M, S = 2 * T;
  const [c, g] = canvas(S);
  const rng = new Rng(5);
  px(g, 0, 0, 120, S, S);
  const tw = T / 4, th = T / 4;
  const across = [0.78, 1, 0.9, 0.64];
  for (let r = 0; r < S / th; r++) for (let k = -1; k <= S / tw; k++) {
    const x0 = k * tw + (r % 2) * (tw / 2), y0 = r * th;
    const v = rng.range(205, 252);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const X = x0 + x;
      if (X < 0 || X >= S) continue;
      // the lowest row is the shadow under the next tile
      px(g, X, y0 + y, y === th - 1 ? v * 0.55 : v * across[x % across.length]);
    }
  }
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
  const n = 12 * TEXELS_PER_M;
  return [tex(pixelate(c, n)), tex(pixelate(cw, n, 12, true), false)];
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
  const n = 12 * TEXELS_PER_M;
  return [tex(pixelate(c, n)), tex(pixelate(cw, n, 12, true), false)];
}

/** Planks (texture = 2 × 2 m): crates, jetties, floors; near-white, tinted by the instance colour. */
export function woodTexture(): Texture {
  const T = TEXELS_PER_M, S = 2 * T;
  const [c, g] = canvas(S);
  const rng = new Rng(21);
  const bh = T / 4; // 25 cm boards
  for (let r = 0; r < S / bh; r++) {
    const y0 = r * bh;
    const v = rng.range(198, 244);
    for (let y = 0; y < bh; y++) px(g, 0, y0 + y, y === bh - 1 ? 150 : y === 0 ? v + 8 : v, S, 1);
    // grain streaks and a knot now and then
    for (let k = 0; k < 2; k++) {
      const y = y0 + rng.int(1, bh - 2), x = rng.int(0, S - 1), len = rng.int(5, 14);
      for (let i = 0; i < len; i++) px(g, (x + i) % S, y, v - 20);
    }
    if (rng.chance(0.3)) px(g, rng.int(0, S - 2), y0 + rng.int(1, bh - 3), v - 40, 2, 2);
    // butt joint
    px(g, rng.int(0, S - 1), y0, 130, 1, bh - 1);
  }
  return tex(c);
}

/**
 * Detailed wooden supply crate texture (64×64): recessed wood slats with grain, thick outer frame,
 * diagonal cross-brace, and dark iron corner brackets with rivets. Tinted by instance color.
 */
export function crateTexture(): Texture {
  const S = 64;
  const [c, g] = canvas(S);
  const rng = new Rng(53);
  const F = 8; // outer frame width

  // Recessed inner horizontal planks
  const plankH = 8;
  for (let y = 0; y < S; y++) {
    const py = y % plankH;
    const base = 186 + ((Math.floor(y / plankH) * 13) % 18);
    for (let x = 0; x < S; x++) {
      const grain = Math.sin(x * 0.35 + y * 0.7) * 8 + (rng.chance(0.12) ? rng.pick([-10, 8]) : 0);
      const seam = py === 0 ? -38 : py === 1 ? 10 : 0;
      px(g, x, y, base + grain + seam);
    }
  }

  // Diagonal cross-brace across the inner panel
  for (let y = F; y < S - F; y++) {
    for (let x = F; x < S - F; x++) {
      const d1 = Math.abs(x - y);
      const d2 = Math.abs(x - (S - 1 - y));
      const d = Math.min(d1, d2);
      if (d <= 4) {
        const edge = d === 4 ? -32 : d === 0 ? 14 : 6;
        px(g, x, y, 212 + edge);
      }
    }
  }

  // Inner shadow under the outer frame
  px(g, F, F, 120, S - F * 2, 2);
  px(g, F, F, 128, 2, S - F * 2);
  px(g, F, S - F - 1, 232, S - F * 2, 1);
  px(g, S - F - 1, F, 228, 1, S - F * 2);

  // Outer perimeter wooden frame
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (x >= F && x < S - F && y >= F && y < S - F) continue;
      const border = x === 0 || y === 0 ? 245 : x === S - 1 || y === S - 1 ? 128 : 218;
      const grain = (rng.chance(0.15) ? rng.pick([-10, 8]) : 0);
      px(g, x, y, border + grain);
    }
  }

  // Iron corner brackets + bright rivets
  const B = 11;
  for (const [cx, cy] of [[0, 0], [S - B, 0], [0, S - B], [S - B, S - B]]) {
    px(g, cx, cy, 92, B, B);
    px(g, cx + 1, cy + 1, 112, B - 2, B - 2);
    px(g, cx + 3, cy + 3, 235, 2, 2);
    px(g, cx + B - 5, cy + B - 5, 235, 2, 2);
  }
  return tex(c);
}

/**
 * Curtain-wall glazing (texture = 3 × 3 m): see-through panes (alpha), opaque mullions every 1.5 m both ways.
 * Multiplied into a transparent material, so the colour is the instance tint and the panes keep ~30 % opacity.
 * A pale diagonal streak across each pane reads as glass in the pixel look.
 */
export function windowTexture(): Texture {
  const T = TEXELS_PER_M, S = 3 * T, half = S / 2;
  const [c, g] = canvas(S);
  g.clearRect(0, 0, S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const d = ((x % half) + (y % half)) % half;
    const streak = d >= half * 0.35 && d < half * 0.35 + 3;
    g.fillStyle = streak ? 'rgba(255,255,255,0.5)' : 'rgba(232,242,252,0.3)';
    g.fillRect(x, y, 1, 1);
  }
  g.fillStyle = 'rgba(70,76,84,1)';
  for (const p of [0, half]) {
    g.fillRect(p, 0, 1, S);
    g.fillRect(0, p, S, 1);
  }
  return tex(c);
}
