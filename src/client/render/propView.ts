import {
  CanvasTexture, Color, DoubleSide, Group, Mesh, MeshStandardMaterial, Object3D, PlaneGeometry, SRGBColorSpace,
} from 'three';
import type { DecalDef, MapData } from '../../shared/map';
import type { GameAssets } from './assets';
import { teamMaterial } from './playerModel';

/** Map props (Kenney Mini Arena models) and painted decals: spawn circles, team names, shop signs. */
export function buildPropView(map: MapData, assets: GameAssets): Group {
  const group = new Group();
  // one recoloured material set per (source material, team)
  const teamMats = new Map<string, MeshStandardMaterial>();
  const recolour = (o: Object3D, team: number) => o.traverse((c) => {
    const mesh = c as Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.material as MeshStandardMaterial;
    const key = `${src.uuid}:${team}`;
    if (!teamMats.has(key)) teamMats.set(key, teamMaterial(src, team));
    mesh.material = teamMats.get(key)!;
  });
  for (const p of map.props) {
    const o = assets.props[p.model].clone();
    o.position.set(...p.pos);
    o.quaternion.set(...p.quat);
    o.scale.setScalar(p.scale);
    if (p.team !== undefined) recolour(o, p.team);
    group.add(o);
  }
  for (const d of map.decals) {
    const m = new Mesh(new PlaneGeometry(d.size[0], d.size[1]), decalMaterial(d));
    m.position.set(...d.pos);
    m.quaternion.set(...d.quat);
    m.receiveShadow = true;
    m.renderOrder = 2;
    group.add(m);
  }
  return group;
}

const css = (c: number) => `#${c.toString(16).padStart(6, '0')}`;

function decalMaterial(d: DecalDef) {
  const px = 128; // per metre
  const c = document.createElement('canvas');
  c.width = Math.round(d.size[0] * px);
  c.height = Math.round(d.size[1] * px);
  const g = c.getContext('2d')!;
  const w = c.width, h = c.height;
  const team = css(d.color);
  if (d.kind === 'spawn') {
    // painted ring with four ticks and an arrow pointing where the spawn faces
    const r = Math.min(w, h) / 2;
    g.translate(w / 2, h / 2);
    g.strokeStyle = team;
    g.lineWidth = r * 0.09;
    g.beginPath(); g.arc(0, 0, r * 0.86, 0, Math.PI * 2); g.stroke();
    g.lineWidth = r * 0.03;
    g.globalAlpha = 0.7;
    g.beginPath(); g.arc(0, 0, r * 0.66, 0, Math.PI * 2); g.stroke();
    g.globalAlpha = 1;
    g.fillStyle = team;
    for (let i = 1; i < 4; i++) {
      g.save(); g.rotate((i * Math.PI) / 2);
      g.fillRect(-r * 0.03, -r * 0.98, r * 0.06, r * 0.18);
      g.restore();
    }
    g.beginPath(); // arrow at the top (= forward)
    g.moveTo(0, -r * 1.0); g.lineTo(r * 0.16, -r * 0.74); g.lineTo(-r * 0.16, -r * 0.74); g.closePath(); g.fill();
    g.fillStyle = `${team}40`;
    g.beginPath(); g.arc(0, 0, r * 0.62, 0, Math.PI * 2); g.fill();
  } else {
    // stencilled text: team colour on the floor, or a dark plank with team-coloured text for signs
    const sign = d.text === 'МАГАЗИН';
    if (sign) {
      g.fillStyle = '#3a2a1f';
      g.fillRect(0, 0, w, h);
      g.strokeStyle = team;
      g.lineWidth = h * 0.08;
      g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth);
    }
    g.fillStyle = sign ? '#f4efe4' : team;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    let size = h * (sign ? 0.62 : 0.8);
    g.font = `800 ${size}px Inter, system-ui, sans-serif`;
    const text = (d.text ?? '').toUpperCase();
    const max = w * 0.92;
    const tw = g.measureText(text).width;
    if (tw > max) { size *= max / tw; g.font = `800 ${size}px Inter, system-ui, sans-serif`; }
    if (!sign) g.globalAlpha = 0.85;
    g.fillText(text, w / 2, h / 2 + size * 0.04);
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 8;
  const opaque = d.kind === 'text' && d.text === 'МАГАЗИН';
  return new MeshStandardMaterial({
    map: tex, transparent: !opaque, roughness: 0.85, side: opaque ? DoubleSide : undefined,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, depthWrite: opaque,
    emissive: new Color(0x000000),
  });
}
