import { CanvasTexture, LinearMipmapLinearFilter, NearestFilter } from 'three';

/**
 * Sprite textures for the effects in the pixel look: a few texels across, hard edges and stepped transparency
 * (no smooth gradients), always magnified with nearest filtering (the texture setting does not touch them).
 */
function sprite(n: number, alpha: (x: number, y: number) => number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const img = g.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = (y * n + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = Math.round(Math.max(0, Math.min(1, alpha(x, y))) * 255);
  }
  g.putImageData(img, 0, 0);
  const t = new CanvasTexture(c);
  t.magFilter = NearestFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.userData.keepFilter = true;
  return t;
}

/** Steps of alpha by distance from the centre (0 = centre, 1 = edge): solid core, then fainter rings. */
const rings = (d: number, steps: [number, number][]) => {
  for (const [r, a] of steps) if (d <= r) return a;
  return 0;
};

/** A round pixel dot: solid core, two fainter rings (particles, glows). */
export function pixelDot(n = 8): CanvasTexture {
  const c = (n - 1) / 2;
  return sprite(n, (x, y) => rings(Math.hypot(x - c, y - c) / (n / 2), [[0.45, 1], [0.75, 0.55], [1, 0.2]]));
}

/** A ragged puff of smoke / mist: a few overlapping pixel discs in three alpha steps. */
export function pixelPuff(n = 16): CanvasTexture {
  const blobs = Array.from({ length: 6 }, () => ({
    x: n / 2 + (Math.random() - 0.5) * n * 0.32, y: n / 2 + (Math.random() - 0.5) * n * 0.32, r: n * (0.2 + Math.random() * 0.14),
  }));
  return sprite(n, (x, y) => {
    let a = 0;
    for (const b of blobs) {
      const d = Math.hypot(x + 0.5 - b.x, y + 0.5 - b.y) / b.r;
      a = Math.max(a, rings(d, [[0.55, 0.6], [0.85, 0.38], [1, 0.16]]));
    }
    return a;
  });
}

/** A blood splat from above: a solid blot with a ragged rim and droplets thrown around it. */
export function pixelSplat(n = 32): CanvasTexture {
  const c = n / 2;
  const rim = Array.from({ length: 16 }, () => 0.42 + Math.random() * 0.16);
  const drops = Array.from({ length: 12 }, () => {
    const a = Math.random() * Math.PI * 2, d = n * (0.32 + Math.random() * 0.15);
    return { x: c + Math.cos(a) * d, y: c + Math.sin(a) * d, r: 0.6 + Math.random() * 1.3 };
  });
  return sprite(n, (x, y) => {
    const dx = x + 0.5 - c, dy = y + 0.5 - c;
    const a = ((Math.atan2(dy, dx) / (Math.PI * 2)) + 1) % 1;
    const k = a * rim.length, i = Math.floor(k), f = k - i;
    const r = (rim[i] * (1 - f) + rim[(i + 1) % rim.length] * f) * c;
    if (Math.hypot(dx, dy) < r) return 1;
    return drops.some((d) => Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) < d.r) ? 1 : 0;
  });
}

/** A hard four-pointed glint: a pixel cross with a small bright core. */
export function pixelGlint(n = 15): CanvasTexture {
  const c = (n - 1) / 2;
  return sprite(n, (x, y) => {
    const dx = Math.abs(x - c), dy = Math.abs(y - c);
    if (dx + dy <= 1) return 1;
    if (dx === 0 || dy === 0) return Math.max(dx, dy) < c * 0.5 ? 0.9 : Math.max(dx, dy) <= c ? 0.4 : 0;
    return Math.hypot(dx, dy) < c * 0.35 ? 0.35 : 0;
  });
}
