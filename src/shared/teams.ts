export type TeamId = 'red' | 'blue' | 'green' | 'yellow';

export interface TeamDef {
  id: TeamId;
  name: string;
  color: number;
}

/** Four teams; each gets a face of the cube (map.ts: the local player's team always the -Y face, the rest at random). */
export const TEAMS: TeamDef[] = [
  { id: 'red', name: 'Красные', color: 0xff3b3b },
  { id: 'blue', name: 'Синие', color: 0x3b6bff },
  { id: 'green', name: 'Зелёные', color: 0x3bff6b },
  { id: 'yellow', name: 'Жёлтые', color: 0xffd23b },
];

export function getTeam(id: TeamId): TeamDef {
  return TEAMS.find((t) => t.id === id)!;
}
