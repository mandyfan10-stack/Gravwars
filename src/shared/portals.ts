import { Matrix4, Quaternion, Vector3 } from 'three';
import type { PortalDef } from './map';

export interface PortalRuntime {
  def: PortalDef;
  matrix: Matrix4;
  inverse: Matrix4;
  quat: Quaternion;
  pos: Vector3;
  /** Front normal (local +Z). */
  normal: Vector3;
  partner: PortalRuntime;
  /** Transform: this portal's space → partner's space (pos & orientation). */
  toPartner: Matrix4;
  qToPartner: Quaternion;
}

const RY_PI = new Matrix4().makeRotationY(Math.PI);
const QY_PI = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);

export function buildPortals(defs: PortalDef[]): PortalRuntime[] {
  const list: PortalRuntime[] = defs.map((def) => {
    const pos = new Vector3(...def.pos);
    const quat = new Quaternion(...def.quat);
    const matrix = new Matrix4().compose(pos, quat, new Vector3(1, 1, 1));
    return {
      def, matrix, inverse: matrix.clone().invert(), quat, pos,
      normal: new Vector3(0, 0, 1).applyQuaternion(quat),
      partner: null as unknown as PortalRuntime,
      toPartner: new Matrix4(), qToPartner: new Quaternion(),
    };
  });
  for (const p of list) {
    p.partner = list[p.def.partner];
    p.toPartner.copy(p.partner.matrix).multiply(RY_PI).multiply(p.inverse);
    p.qToPartner.copy(p.partner.quat).multiply(QY_PI).multiply(p.quat.clone().invert());
  }
  return list;
}

const _a = new Vector3();
const _b = new Vector3();

/** Did the segment a→b pass through the portal opening (from either side)? */
export function crossesPortal(p: PortalRuntime, a: Vector3, b: Vector3): boolean {
  _a.copy(a).applyMatrix4(p.inverse);
  _b.copy(b).applyMatrix4(p.inverse);
  if (_a.z * _b.z >= 0) return false;
  const t = _a.z / (_a.z - _b.z);
  const x = _a.x + (_b.x - _a.x) * t;
  const y = _a.y + (_b.y - _a.y) * t;
  return Math.abs(x) <= p.def.width / 2 && Math.abs(y) <= p.def.height / 2;
}