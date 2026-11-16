import { BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial, Object3D, TorusGeometry, Vector3 } from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

/**
 * Real-life-looking firearms built from simple solids (no brand, generic designs), in metres, barrel along -Z,
 * origin at the top of the pistol grip (where the hand holds it):
 * - a 9 mm self-loading pistol: polymer frame, steel slide;
 * - a 5.45 mm assault rifle: steel receiver, wooden handguard and stock, curved magazine;
 * - a 12-gauge pump shotgun: tube magazine under the barrel, wooden pump and stock;
 * - a single-shot rocket launcher: an olive tube with a grip, a sight and the warhead sticking out in front;
 * - a grappling-hook launcher: a stubby tube with a folded three-prong claw and a rope drum.
 * Moving parts are separate nodes for the reload animation: `mag` (drops out / goes in; the launcher's rocket, the
 * hook's claw), `slide` (pistol slide, rifle bolt handle, shotgun pump: pulled back along +Z).
 */
export interface GunModel {
  root: Group;
  mag: Object3D;
  slide: Object3D;
  /** Muzzle point in `root` space. */
  muzzle: Vector3;
}

const steel = () => new MeshStandardMaterial({ color: 0x2e3134, roughness: 0.42, metalness: 0.75 });
const blued = () => new MeshStandardMaterial({ color: 0x1f2226, roughness: 0.5, metalness: 0.6 });
const polymer = () => new MeshStandardMaterial({ color: 0x1b1c1e, roughness: 0.85, metalness: 0 });
const wood = () => new MeshStandardMaterial({ color: 0x7b4526, roughness: 0.62, metalness: 0 });
const bakelite = () => new MeshStandardMaterial({ color: 0x5b2c1d, roughness: 0.55, metalness: 0 });

function part(geo: BufferGeometry, mat: MeshStandardMaterial, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  const m = new Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = m.receiveShadow = true;
  return m;
}
const box = (w: number, h: number, d: number, r = 0.003) => (r > 0 ? new RoundedBoxGeometry(w, h, d, 2, r) : new BoxGeometry(w, h, d));
/** Cylinder along Z. */
const tube = (r: number, len: number, seg = 10) => new CylinderGeometry(r, r, len, seg).rotateX(Math.PI / 2);

export function pistolModel(): GunModel {
  const root = new Group();
  const st = steel(), pl = polymer(), bl = blued();
  // frame: dust cover, grip with a rake, trigger guard
  root.add(part(box(0.027, 0.02, 0.15), pl, 0, 0.012, -0.045));
  root.add(part(box(0.029, 0.105, 0.048, 0.006), pl, 0, -0.045, 0.012, -0.28));
  root.add(part(box(0.031, 0.012, 0.03), pl, 0, 0.004, 0.03)); // beaver tail
  root.add(part(box(0.006, 0.006, 0.05, 0), pl, 0, -0.024, -0.04)); // guard bottom
  root.add(part(box(0.006, 0.026, 0.006, 0), pl, 0, -0.011, -0.064)); // guard front
  root.add(part(box(0.005, 0.018, 0.005, 0), st, 0, -0.008, -0.025, 0.25)); // trigger
  // slide: serrations at the back, sights, ejection port
  const slide = new Group();
  slide.add(part(box(0.026, 0.03, 0.19, 0.004), st, 0, 0.037, -0.05));
  for (let i = 0; i < 6; i++) slide.add(part(box(0.0275, 0.022, 0.0025, 0), bl, 0, 0.037, 0.025 + i * 0.0055));
  slide.add(part(box(0.006, 0.006, 0.006, 0), bl, 0, 0.055, -0.138)); // front sight
  slide.add(part(box(0.02, 0.007, 0.007, 0), bl, 0, 0.055, 0.034)); // rear sight
  slide.add(part(box(0.0265, 0.012, 0.035, 0), bl, 0.0012, 0.043, -0.03)); // port
  root.add(slide);
  root.add(part(tube(0.0065, 0.012), bl, 0, 0.037, -0.149)); // muzzle crown
  // magazine: only the base plate shows under the grip
  const mag = new Group();
  mag.add(part(box(0.022, 0.1, 0.034, 0), bl, 0, -0.05, 0.0, -0.28));
  mag.add(part(box(0.03, 0.012, 0.046, 0.003), pl, 0, -0.103, 0.026, -0.28));
  mag.position.set(0, 0, 0);
  root.add(mag);
  return { root, mag, slide, muzzle: new Vector3(0, 0.037, -0.16) };
}

export function rifleModel(): GunModel {
  const root = new Group();
  const st = steel(), bl = blued(), wd = wood(), bk = bakelite(), pl = polymer();
  // receiver with the dust cover, trigger group
  root.add(part(box(0.046, 0.06, 0.3, 0.004), st, 0, 0.026, -0.03));
  root.add(part(box(0.042, 0.022, 0.27, 0.008), st, 0, 0.064, -0.02)); // dust cover
  root.add(part(box(0.006, 0.006, 0.07, 0), bl, 0, -0.012, 0.005)); // guard
  root.add(part(box(0.005, 0.02, 0.005, 0), bl, 0, -0.001, -0.002, 0.3)); // trigger
  root.add(part(box(0.034, 0.1, 0.042, 0.006), pl, 0, -0.045, 0.06, -0.35)); // pistol grip
  // barrel, gas tube, handguards, sights, muzzle brake
  root.add(part(tube(0.0095, 0.42), bl, 0, 0.03, -0.39));
  root.add(part(tube(0.013, 0.22), st, 0, 0.068, -0.27));
  root.add(part(box(0.054, 0.05, 0.19, 0.012), wd, 0, 0.028, -0.27)); // lower handguard
  root.add(part(box(0.036, 0.028, 0.19, 0.01), wd, 0, 0.07, -0.27)); // upper handguard
  root.add(part(box(0.02, 0.04, 0.02, 0), bl, 0, 0.06, -0.525)); // front sight block
  root.add(part(box(0.006, 0.03, 0.006, 0), bl, 0, 0.09, -0.525)); // front post
  root.add(part(box(0.03, 0.016, 0.06, 0), st, 0, 0.083, -0.17)); // rear sight base
  root.add(part(tube(0.0145, 0.07, 8), st, 0, 0.03, -0.62)); // brake
  // stock: wood, dropping a little toward the butt plate
  root.add(part(box(0.04, 0.07, 0.24, 0.012), wd, 0, 0.0, 0.24, 0.12));
  root.add(part(box(0.042, 0.11, 0.02, 0.006), pl, 0, -0.024, 0.36, 0.12)); // butt plate
  // bolt handle on the right side
  const slide = new Group();
  slide.add(part(box(0.02, 0.008, 0.012, 0), st, 0.03, 0.044, -0.06));
  slide.add(part(box(0.012, 0.014, 0.014, 0.003), st, 0.043, 0.044, -0.06));
  root.add(slide);
  // curved magazine: segments bending forward
  const mag = new Group();
  const segs = 5;
  for (let i = 0; i < segs; i++) {
    const a = 0.08 + i * 0.1;
    const y = -0.005 - i * 0.034;
    const z = -0.085 - i * i * 0.006 - i * 0.006;
    mag.add(part(box(0.03, 0.038, 0.07, 0.003), bk, 0, y, z, a));
  }
  mag.add(part(box(0.032, 0.008, 0.074, 0.002), bk, 0, -0.17, -0.14, 0.5)); // floor plate
  root.add(mag);
  return { root, mag, slide, muzzle: new Vector3(0, 0.03, -0.66) };
}

const olive = () => new MeshStandardMaterial({ color: 0x4a5236, roughness: 0.7, metalness: 0.15 });
const paint = (color: number) => new MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1 });

export function shotgunModel(): GunModel {
  const root = new Group();
  const st = steel(), bl = blued(), wd = wood();
  // receiver, trigger group, pistol-grip stock in one wooden piece
  root.add(part(box(0.044, 0.062, 0.2, 0.006), st, 0, 0.03, -0.02));
  root.add(part(box(0.006, 0.006, 0.06, 0), bl, 0, -0.012, 0.01)); // guard
  root.add(part(box(0.005, 0.02, 0.005, 0), bl, 0, 0.0, 0.0, 0.3)); // trigger
  root.add(part(box(0.036, 0.1, 0.044, 0.008), wd, 0, -0.04, 0.09, -0.4)); // grip
  root.add(part(box(0.042, 0.075, 0.26, 0.014), wd, 0, 0.0, 0.27, 0.1)); // stock
  root.add(part(box(0.044, 0.12, 0.022, 0.008), polymer(), 0, -0.018, 0.4, 0.1)); // recoil pad
  // barrel and the magazine tube under it, a bead sight
  root.add(part(tube(0.012, 0.52), bl, 0, 0.045, -0.37));
  root.add(part(tube(0.0115, 0.4), st, 0, 0.012, -0.31));
  root.add(part(tube(0.013, 0.02), st, 0, 0.012, -0.515)); // tube cap
  root.add(part(box(0.006, 0.008, 0.006, 0), st, 0, 0.061, -0.62)); // bead
  // pump: grooved wooden forend around the tube
  const slide = new Group();
  slide.add(part(box(0.05, 0.048, 0.17, 0.014), wd, 0, 0.014, -0.25));
  for (let i = 0; i < 5; i++) slide.add(part(box(0.052, 0.05, 0.006, 0), bl, 0, 0.014, -0.3 + i * 0.025));
  root.add(slide);
  // "magazine": a shell pushed into the loading port (shows during the reload)
  const mag = new Group();
  mag.add(part(tube(0.0105, 0.07, 8), paint(0xb3261e), 0, -0.012, 0.0));
  mag.add(part(tube(0.0108, 0.016, 8), new MeshStandardMaterial({ color: 0xc9a54a, roughness: 0.3, metalness: 0.8 }), 0, -0.012, 0.04));
  mag.position.set(0, -0.06, 0.05);
  root.add(mag);
  return { root, mag, slide, muzzle: new Vector3(0, 0.045, -0.64) };
}

export function launcherModel(): GunModel {
  const root = new Group();
  const ol = olive(), bl = blued(), pl = polymer();
  // the tube rides over the shoulder: the grip is near its middle
  root.add(part(tube(0.052, 1.0, 14), ol, 0, 0.09, -0.12));
  root.add(part(tube(0.058, 0.08, 14), bl, 0, 0.09, -0.6)); // front ring
  root.add(part(tube(0.06, 0.1, 14), bl, 0, 0.09, 0.36)); // venturi
  root.add(part(box(0.03, 0.1, 0.045, 0.008), pl, 0, -0.02, 0.0, -0.25)); // grip
  root.add(part(box(0.03, 0.09, 0.04, 0.008), pl, 0, -0.01, -0.3, -0.1)); // front grip
  root.add(part(box(0.006, 0.006, 0.05, 0), bl, 0, 0.03, 0.025)); // guard
  // folding sight on the left
  root.add(part(box(0.012, 0.07, 0.05, 0.003), bl, -0.06, 0.13, -0.15));
  root.add(part(box(0.018, 0.018, 0.04, 0.003), paint(0x1a1a1a), -0.06, 0.17, -0.15));
  // the rocket: warhead cone out of the front (gone once fired, back with the reload)
  const mag = new Group();
  const cone = new Mesh(new CylinderGeometry(0.005, 0.045, 0.16, 12).rotateX(-Math.PI / 2), paint(0x6b6f45));
  cone.position.set(0, 0.09, -0.74);
  const band = new Mesh(new CylinderGeometry(0.046, 0.046, 0.03, 12).rotateX(Math.PI / 2), paint(0xc8a530));
  band.position.set(0, 0.09, -0.65);
  mag.add(cone, band);
  root.add(mag);
  return { root, mag, slide: new Group(), muzzle: new Vector3(0, 0.09, -0.66) };
}

export function hookGunModel(teamColor: number): GunModel {
  const root = new Group();
  const st = new MeshStandardMaterial({ color: 0x727a84, roughness: 0.3, metalness: 0.85 });
  const bl = blued();
  const pl = polymer();
  const team = paint(teamColor);
  const gold = paint(0xd8a832);
  const glow = new MeshStandardMaterial({ color: 0x5df2ff, emissive: 0x35d6ff, emissiveIntensity: 1.5, roughness: 0.25 });
  const ropeCol = paint(0xcfc19a);

  // Sculpted chassis receiver & heavy vented barrel shroud
  root.add(part(box(0.044, 0.058, 0.22, 0.008), team, 0, 0.032, -0.065));
  root.add(part(box(0.048, 0.014, 0.21, 0.004), bl, 0, 0.064, -0.065)); // upper Picatinny rail spine
  for (let z = -0.15; z <= 0.01; z += 0.025) {
    root.add(part(box(0.034, 0.006, 0.01, 0.001), st, 0, 0.072, z)); // rail teeth
  }
  // Glow ready-charge bar + rear iron notch sight
  root.add(part(box(0.024, 0.008, 0.055, 0.002), glow, 0, 0.066, -0.02));
  root.add(part(box(0.022, 0.014, 0.012, 0.002), bl, 0, 0.074, 0.035));

  // Heavy rifled barrel + vented heat-sink collar + flanged funnel muzzle cup
  root.add(part(tube(0.022, 0.22, 12), bl, 0, 0.044, -0.23));
  for (const s of [-1, 1]) {
    root.add(part(box(0.008, 0.026, 0.14, 0.002), st, s * 0.024, 0.044, -0.21));
  }
  root.add(part(new CylinderGeometry(0.034, 0.025, 0.042, 12).rotateX(Math.PI / 2), st, 0, 0.044, -0.34));
  root.add(part(new TorusGeometry(0.031, 0.0055, 6, 14), team, 0, 0.044, -0.358));

  // Ergonomic angled grip + butt-plate + trigger guard & gold trigger
  root.add(part(box(0.034, 0.11, 0.046, 0.008), pl, 0, -0.046, 0.02, -0.3));
  root.add(part(box(0.038, 0.014, 0.052, 0.004), st, 0, -0.098, 0.036, -0.3));
  root.add(part(box(0.007, 0.007, 0.054, 0), bl, 0, -0.01, -0.032));
  root.add(part(box(0.007, 0.026, 0.007, 0), bl, 0, 0.002, -0.056));
  root.add(part(box(0.006, 0.018, 0.006, 0), gold, 0, -0.001, -0.02, 0.25));

  // Under-barrel motorized winch spool + wound braided cable + front line fairlead guide
  root.add(part(new CylinderGeometry(0.038, 0.038, 0.048, 16).rotateZ(Math.PI / 2), st, 0, -0.014, -0.145));
  for (const sx of [-0.026, 0.026]) {
    root.add(part(new CylinderGeometry(0.043, 0.043, 0.006, 16).rotateZ(Math.PI / 2), bl, sx, -0.014, -0.145));
    // Ratchet gear hub on side of winch drum
    root.add(part(new CylinderGeometry(0.022, 0.022, 0.01, 10).rotateZ(Math.PI / 2), gold, sx * 1.15, -0.014, -0.145));
  }
  root.add(part(new CylinderGeometry(0.033, 0.033, 0.042, 14).rotateZ(Math.PI / 2), ropeCol, 0, -0.014, -0.145));
  // Taut cable feeding from drum forward under barrel towards muzzle claw
  root.add(part(tube(0.0045, 0.16, 6), ropeCol, 0, 0.012, -0.24));
  root.add(part(new TorusGeometry(0.012, 0.004, 6, 10), st, 0, 0.012, -0.32));

  // Four-pronged folding titanium grappling claw seated in muzzle (`mag` hides while in flight)
  const mag = new Group();
  // Central harpoon spearhead tip + hub collar + glowing ring
  mag.add(part(tube(0.011, 0.12, 8), st, 0, 0, 0.035));
  mag.add(part(new ConeGeometry(0.016, 0.068, 8).rotateX(-Math.PI / 2), st, 0, 0, -0.055));
  mag.add(part(new TorusGeometry(0.018, 0.0045, 6, 12), glow, 0, 0, 0.01));
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const arm = new Group();
    arm.rotation.z = a;
    // Outward hinged grapple arm + sharp inward recurve hook fang + team highlight stripe
    arm.add(part(box(0.009, 0.012, 0.082, 0.002), st, 0.024, 0, -0.02, 0, -0.26, 0));
    arm.add(part(box(0.007, 0.008, 0.045, 0.001), team, 0.028, 0, -0.015, 0, -0.26, 0));
    arm.add(part(new ConeGeometry(0.009, 0.044, 6).rotateX(-Math.PI * 0.8), st, 0.038, 0, -0.056, 0, -0.45, 0));
    mag.add(arm);
  }
  mag.position.set(0, 0.044, -0.37);
  root.add(mag);
  return { root, mag, slide: new Group(), muzzle: new Vector3(0, 0.044, -0.37) };
}

export function crossbowModel(teamColor = 0x38d8ff): GunModel {
  const root = new Group();
  const st = steel(), bl = blued(), wd = wood(), pl = polymer();
  const teamGlow = new MeshStandardMaterial({ color: teamColor, emissive: teamColor, emissiveIntensity: 1.85, roughness: 0.22 });
  // Stock, flight track, pistol grip, and scope rail
  root.add(part(box(0.042, 0.048, 0.48, 0.006), wd, 0, 0.02, -0.14));
  root.add(part(box(0.028, 0.016, 0.46, 0.002), st, 0, 0.048, -0.15)); // flight rail
  root.add(part(box(0.038, 0.068, 0.22, 0.01), wd, 0, -0.005, 0.18, 0.1)); // buttstock
  root.add(part(box(0.034, 0.095, 0.042, 0.006), pl, 0, -0.045, 0.04, -0.32)); // pistol grip
  root.add(part(box(0.006, 0.006, 0.06, 0), bl, 0, -0.012, 0.0)); // guard
  // Optical scope on top of the receiver
  root.add(part(tube(0.014, 0.15, 10), bl, 0, 0.082, -0.04));
  root.add(part(box(0.012, 0.022, 0.02, 0), st, 0, 0.064, -0.08));
  root.add(part(box(0.012, 0.022, 0.02, 0), st, 0, 0.064, 0.0));
  // Front bow prod & limbs (left and right)
  root.add(part(box(0.11, 0.028, 0.045, 0.006), bl, 0, 0.038, -0.38));
  for (const s of [-1, 1]) {
    root.add(part(box(0.22, 0.018, 0.028, 0.004), st, s * 0.14, 0.04, -0.35, 0, s * 0.28, 0));
    root.add(part(new CylinderGeometry(0.024, 0.024, 0.016, 10), bl, s * 0.24, 0.04, -0.32)); // cam wheel
  }
  // Bowstring + nock carrier (`slide` moves back along +Z as charge increases)
  const slide = new Group();
  for (const s of [-1, 1]) {
    slide.add(part(box(0.24, 0.004, 0.004, 0), st, s * 0.12, 0.056, -0.26, 0, -s * 0.24, 0));
  }
  slide.add(part(box(0.024, 0.016, 0.024, 0.003), bl, 0, 0.056, -0.22));
  root.add(slide);
  // Loaded bolt (`mag` glows and widens with charge level in shooter's team color)
  const mag = new Group();
  mag.add(part(tube(0.006, 0.34, 8), teamGlow, 0, 0.058, -0.25));
  mag.add(part(new CylinderGeometry(0.002, 0.014, 0.055, 6).rotateX(-Math.PI / 2), teamGlow, 0, 0.058, -0.44));
  root.add(mag);
  return { root, mag, slide, muzzle: new Vector3(0, 0.058, -0.46) };
}

export function revolverModel(): GunModel {
  const root = new Group();
  const chrome = new MeshStandardMaterial({ color: 0xc2c8ce, roughness: 0.28, metalness: 0.88 });
  const bl = blued(), wd = wood();
  // Frame & heavy top strap
  root.add(part(box(0.024, 0.048, 0.11, 0.004), chrome, 0, 0.024, -0.02));
  root.add(part(box(0.02, 0.014, 0.11, 0.002), chrome, 0, 0.056, -0.02));
  // Curved wooden grip & trigger guard
  root.add(part(box(0.026, 0.098, 0.044, 0.008), wd, 0, -0.044, 0.022, -0.34));
  root.add(part(box(0.006, 0.006, 0.044, 0), chrome, 0, -0.022, -0.028));
  root.add(part(box(0.006, 0.024, 0.006, 0), chrome, 0, -0.01, -0.05));
  root.add(part(box(0.005, 0.016, 0.005, 0), bl, 0, -0.006, -0.022, 0.25));
  // Long octagonal/ribbed barrel + ejector shroud under barrel + brass bead front sight
  root.add(part(tube(0.01, 0.175, 8), chrome, 0, 0.048, -0.16));
  root.add(part(box(0.014, 0.014, 0.165, 0.002), chrome, 0, 0.032, -0.155));
  root.add(part(box(0.007, 0.012, 0.165, 0.002), bl, 0, 0.058, -0.155)); // ventilated rib
  root.add(part(box(0.005, 0.01, 0.009, 0), paint(0xd4af37), 0, 0.068, -0.238)); // front sight
  // Fluted cylinder (`slide` rotates on cocking & swings out on reload)
  const slide = new Group();
  slide.position.set(0, 0.033, -0.03);
  slide.add(part(tube(0.022, 0.058, 12), chrome, 0, 0, 0));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    slide.add(part(tube(0.0052, 0.06, 6), bl, Math.cos(a) * 0.013, Math.sin(a) * 0.013, 0));
  }
  root.add(slide);
  // Hammer (`mag` pivots back while LMB holds)
  const mag = new Group();
  mag.position.set(0, 0.05, 0.036);
  mag.add(part(box(0.006, 0.022, 0.016, 0.002), bl, 0, 0.008, 0.004, -0.35));
  root.add(mag);
  return { root, mag, slide, muzzle: new Vector3(0, 0.048, -0.255) };
}
