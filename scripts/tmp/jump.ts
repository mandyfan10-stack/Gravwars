import { WORLD, TICK_DT } from '../../src/shared/constants';
import { generateMap } from '../../src/shared/map';
import { emptyInput } from '../../src/shared/movement';
import { buildPhysicsWorld, initRapier } from '../../src/shared/physics';
import { PlayerSim } from '../../src/shared/sim';
const R = await initRapier();
const map = generateMap(); const world = buildPhysicsWorld(R, map);
const sim = new PlayerSim(R, world, map, 'red'); const s = sim.state; const G = -WORLD.islandDistance;
const put = (x:number,y:number,z:number)=>{ s.pos.set(x,y,z); s.vel.set(0,0,0); s.frame.identity(); s.onGround=false; s.jumpHold=0; sim.mover.place(s); };
for (const hold of [1, 40]) {
  put(16, G+1.2, 10); for (let i=0;i<30;i++) sim.tick({...emptyInput()}, TICK_DT);
  const y0 = s.pos.y; let top = y0;
  for (let i=0;i<120;i++){ sim.tick({...emptyInput(), jump: i<hold}, TICK_DT); top=Math.max(top,s.pos.y); if (i>hold && s.onGround) break; }
  console.log('hold', hold, 'apex', (top-y0).toFixed(2));
}
// wall: fall against east hall wall pushing in
put(12.43, G+8, 32); const ys=[];
for (let i=0;i<100;i++){ sim.tick({...emptyInput(), yaw:Math.PI/2, forward:1}, TICK_DT); if(i%10===0) ys.push(`${(s.pos.y-G).toFixed(2)}/${s.vel.y.toFixed(1)}${s.wallSlide?'S':''}`); }
console.log('push wall', ys.join(' '));
put(13, G+8, 32); const ys2=[];
for (let i=0;i<60;i++){ sim.tick({...emptyInput(), yaw:Math.PI/2, forward:0}, TICK_DT); if(i%10===0) ys2.push(`${(s.pos.y-G).toFixed(2)}/${s.vel.y.toFixed(1)}`); }
console.log('no push', ys2.join(' '));
put(13, G+8, 32); const ys3=[];
for (let i=0;i<70;i++){ sim.tick({...emptyInput(), yaw:Math.PI/2, forward:1}, TICK_DT); if(i%6===0) ys3.push(`${(s.pos.y-G).toFixed(1)},x${s.pos.x.toFixed(2)},n${s.wallNormal.x.toFixed(1)}`); }
console.log(ys3.join(' '));
for (const bx of map.boxes) { if (Math.abs(bx.pos[0]-12)<1.5 && Math.abs(bx.pos[2]-32)<13 ) console.log('box', bx.pos.map(v=>(v as number).toFixed(2)), bx.half, bx.mat, bx.collide, bx.quat.map(v=>v.toFixed(2))); }
