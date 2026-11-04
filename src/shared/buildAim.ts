import { Vector3 } from 'three';
import { BUILD_SIZE, BuildKind, Building } from './building';

/** Target a floor at the feet/ceiling plane, extend a floor or stack a wall when looking at it. */
export function buildAim(kind: BuildKind, eye: Vector3, player: Vector3, up: Vector3, view: Vector3,
  facing: Vector3, hit: { pos: Vector3; piece?: Building } | null): Vector3 {
  const flat = facing.clone().addScaledVector(up, -facing.dot(up)).normalize();
  if (flat.lengthSq() < 0.01) flat.set(1,0,0).addScaledVector(up, -up.x).normalize();
  const p = hit?.piece;
  if (p && kind === 'floor' && p.plan.kind === 'floor' && Math.abs(new Vector3(0,1,0).applyQuaternion(p.plan.rotation).dot(up)) > .99) {
    const dirs = [new Vector3(1,0,0),new Vector3(-1,0,0),new Vector3(0,1,0),new Vector3(0,-1,0),new Vector3(0,0,1),new Vector3(0,0,-1)].filter(a => Math.abs(a.dot(up)) < .1);
    dirs.sort((a,b) => b.dot(flat)-a.dot(flat));
    return p.plan.cell.clone().addScaledVector(dirs[0],BUILD_SIZE);
  }
  if (p && kind === 'wall' && p.plan.kind === 'wall' && Math.abs(new Vector3(0,0,1).applyQuaternion(p.plan.rotation).dot(up)) < .01 && hit!.pos.clone().sub(p.plan.cell).dot(up) > 0.15)
    return p.plan.cell.clone().addScaledVector(up,BUILD_SIZE);
  const feet = player.clone().addScaledVector(up,-0.915);
  if (kind === 'floor' || kind === 'ramp') {
    // A downward ray aims at the foot plane; forward aim targets a cell a few metres ahead.
    const vertical = view.dot(up);
    const t = Math.abs(vertical) > 0.04 ? feet.clone().sub(eye).dot(up) / vertical : -1;
    let point = t > 0.2 && t < 7 ? eye.clone().addScaledVector(view,t) : feet.clone().addScaledVector(flat,4.5);
    if (hit && !p && t > 0.2 && eye.distanceTo(hit.pos) < t) point = hit.pos.clone();
    // planBuild puts the top of a floor 1.32 m below the cell centre.
    point.addScaledVector(up, feet.dot(up) + 1.32 - point.dot(up));
    return point;
  }
  const point = hit ? hit.pos.clone() : feet.clone().addScaledVector(flat,4.2);
  // Walls stand at the player's floor level rather than floating at eye height.
  point.addScaledVector(up, feet.dot(up) + 1.5 - point.dot(up));
  return point;
}
