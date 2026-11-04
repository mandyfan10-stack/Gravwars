import { BoxGeometry, CanvasTexture, Color, EdgesGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, RepeatWrapping, Scene, SRGBColorSpace } from 'three';
import { BUILD_MATERIALS, type BuildMaterial, type BuildPlan, type BuildResult, type BuildSystem } from '../../shared/building';

function texture(kind: BuildMaterial) {
  const c=document.createElement('canvas');c.width=c.height=128; const x=c.getContext('2d')!;
  if (kind==='wood') {
    x.fillStyle='#ba8955';x.fillRect(0,0,128,128);
    for(let i=0;i<4;i++){x.fillStyle=i%2?'#a97747':'#bf925e';x.fillRect(0,i*32,128,30);x.fillStyle='#5c3c27';x.fillRect(0,i*32+30,128,2); for(let j=0;j<5;j++){x.fillStyle='#70492c66';x.fillRect((j*37+i*13)%128,i*32+6+j*4,24,1);}}
  } else if(kind==='stone') {
    x.fillStyle='#707778';x.fillRect(0,0,128,128);
    for(let r=0;r<4;r++) for(let q=-1;q<4;q++){x.fillStyle=(r+q)%2?'#b4b3a9':'#a3a39d';x.fillRect(q*48+(r%2)*24+2,r*32+2,44,28);}
  } else {
    x.fillStyle='#82939b';x.fillRect(0,0,128,128);
    for(let i=0;i<8;i++){x.fillStyle=i%2?'#aab7ba':'#96a7ad';x.fillRect(0,i*16,128,12);x.fillStyle='#64757c';x.fillRect(0,i*16+12,128,4);}
    x.fillStyle='#4e5c62';for(const a of [8,120])for(const b of [8,120]){x.beginPath();x.arc(a,b,2,0,7);x.fill();}
  }
  const t=new CanvasTexture(c);t.colorSpace=SRGBColorSpace;t.wrapS=t.wrapT=RepeatWrapping;t.anisotropy=4;return t;
}
export class BuildView {
  private meshes = new Map<number, Group>();
  private textures = { wood:texture('wood'),stone:texture('stone'),metal:texture('metal') };
  private ghost = new Group();
  private ghostMesh = new Mesh(new BoxGeometry(1,1,1), new MeshBasicMaterial({color:0x55eecb, transparent:true, opacity:0.35, depthWrite:false}));
  private outline = new LineSegments(new EdgesGeometry(new BoxGeometry(1,1,1)), new LineBasicMaterial({color:0xbaffea}));
  constructor(private scene: Scene) { this.ghost.add(this.ghostMesh, this.outline); this.ghost.visible = false; scene.add(this.ghost); }
  update(system: BuildSystem, plan: BuildPlan | null, result: BuildResult | null) {
    for (const [id, obj] of this.meshes) if (!system.pieces.has(id)) { this.scene.remove(obj); obj.traverse(o => { if (o instanceof Mesh || o instanceof LineSegments) { o.geometry.dispose(); (o.material as MeshBasicMaterial).dispose(); } }); this.meshes.delete(id); }
    for (const [id, piece] of system.pieces) {
      let g = this.meshes.get(id);
      if (!g) {
        g = new Group();
        const mesh = new Mesh(new BoxGeometry(1,1,1), new MeshStandardMaterial({ color: 0xffffff, map:this.textures[piece.material], roughness:0.85, metalness:piece.material==='metal'?0.38:0.02 }));
        mesh.castShadow = true; mesh.receiveShadow = true;
        const edges = new LineSegments(new EdgesGeometry(new BoxGeometry(1,1,1)), new LineBasicMaterial({color:0x51443c}));
        g.add(mesh, edges); this.scene.add(g); this.meshes.set(id,g);
      }
      const p = piece.plan; g.position.copy(p.position); g.quaternion.copy(p.rotation); g.scale.copy(p.half).multiplyScalar(2);
      const mesh = g.children[0] as Mesh; (mesh.material as MeshStandardMaterial).color.copy(new Color(0xffffff)).multiplyScalar(0.5 + 0.5 * piece.hp / piece.maxHp);
    }
    this.ghost.visible = !!plan;
    if (!plan) return;
    this.ghost.position.copy(plan.position); this.ghost.quaternion.copy(plan.rotation); this.ghost.scale.copy(plan.half).multiplyScalar(2);
    (this.ghostMesh.material as MeshBasicMaterial).color.set(result === 'ok' ? 0x55eecb : 0xff5360);
    (this.outline.material as LineBasicMaterial).color.set(result === 'ok' ? 0xbaffea : 0xff9b9b);
  }
}
