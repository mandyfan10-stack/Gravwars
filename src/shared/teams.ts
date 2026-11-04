import { Vector3 } from 'three';

export type TeamId = 'red' | 'blue' | 'green' | 'yellow' | 'aqua' | 'pink';

export interface TeamDef {
  id: TeamId;
  name: string;
  color: number;
  /** Gravity direction of the team (world space, axis aligned). The island lies in this direction. */
  down: [number, number, number];
}

/**
 * All gravities are axis aligned, so there are at most 6 teams:
 * opposite team = on the ceiling, the other four = on the walls.
 */
export const TEAMS: TeamDef[] = [
  { id: 'red', name: 'Красные', color: 0xff3b3b, down: [0, -1, 0] },
  { id: 'blue', name: 'Синие', color: 0x3b6bff, down: [0, 1, 0] },
  { id: 'green', name: 'Зелёные', color: 0x3bff6b, down: [1, 0, 0] },
  { id: 'yellow', name: 'Жёлтые', color: 0xffd23b, down: [-1, 0, 0] },
  { id: 'aqua', name: 'Бирюзовые', color: 0x2ff3e0, down: [0, 0, 1] },
  { id: 'pink', name: 'Розовые', color: 0xff4fd8, down: [0, 0, -1] },
];

export function getTeam(id: TeamId): TeamDef {
  return TEAMS.find((t) => t.id === id)!;
}

/** Team whose gravity is closest to the given down vector. */
export function teamByDown(down: Vector3): TeamDef {
  let best = TEAMS[0];
  let bestDot = -Infinity;
  for (const t of TEAMS) {
    const d = down.x * t.down[0] + down.y * t.down[1] + down.z * t.down[2];
    if (d > bestDot) {
      bestDot = d;
      best = t;
    }
  }
  return best;
}