/**
 * The map: data types (mapgen/core.ts) and the generator of the cube world (mapgen/cube.ts: faces, lanes, plates,
 * navigation; mapgen/tiles.ts: city sections; mapgen/buildings.ts: enterable buildings; mapgen/props.ts: street props).
 */
export * from './mapgen/core';
export { FACE_IDS, FACE_UP, faceByUp, faceFrame, faceOfTeam, generateMap, LANE, navPath, nearestNode } from './mapgen/cube';
export { HALL_H, HALL_HALF } from './mapgen/tiles';
export { BLOCK, SW, TILE } from './mapgen/props';
