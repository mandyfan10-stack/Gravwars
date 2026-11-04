import type { BuildKind, BuildMaterial } from '../shared/building';
const KINDS: BuildKind[] = ['floor','wall','ramp'];
const MATERIALS: BuildMaterial[] = ['wood','stone','metal'];
const names = {floor:'Пол',wall:'Стена',ramp:'Пандус',wood:'Дерево',stone:'Камень',metal:'Металл'};
const icons = {floor:'▱',wall:'▦',ramp:'◩',wood:'▤',stone:'▧',metal:'▥'};
export class BuildWheel {
  private held: 'KeyQ'|'KeyZ'|null = null;
  private age = 0;
  private opened = false;
  private x=0; private y=0; private selected=-1;
  private el = document.getElementById('build-wheel')!;
  constructor(private selectSound: () => void) {}
  get active() { return this.opened; }
  move(dx:number,dy:number) {
    if(!this.opened) return false;
    this.x=Math.max(-120,Math.min(120,this.x+dx));this.y=Math.max(-120,Math.min(120,this.y+dy));
    const dist=Math.hypot(this.x,this.y);
    const angle=(Math.atan2(this.y,this.x)+Math.PI/2+Math.PI*2)%(Math.PI*2);
    this.selected=dist>20?Math.round(angle/(Math.PI*2/3))%3:-1;
    return true;
  }
  update(dt:number, enabled:boolean, down:(key:string)=>boolean, kind:BuildKind, mat:BuildMaterial): {kind:BuildKind; material:BuildMaterial} {
    if(!enabled) {this.held=null;this.opened=false;this.el.classList.remove('on');return {kind,material:mat};}
    if(!this.held) { if(down('KeyQ')) this.held='KeyQ'; else if(down('KeyZ')) this.held='KeyZ'; if(this.held){this.age=0;this.x=this.y=0;this.selected=-1;} }
    if(this.held){
      if(down(this.held)) { this.age+=dt; if(this.age>=.25) this.opened=true; }
      else {
        const list=this.held==='KeyQ'?KINDS:MATERIALS; const current=this.held==='KeyQ'?kind:mat;
        const n=this.opened ? this.selected : (list.indexOf(current as never)+1)%list.length;
        if(n>=0){if(this.held==='KeyQ')kind=KINDS[n];else mat=MATERIALS[n];this.selectSound();}
        this.held=null;this.opened=false;
      }
    }
    if(this.opened && this.held){
      const list=this.held==='KeyQ'?KINDS:MATERIALS, current=this.held==='KeyQ'?kind:mat;
      this.el.classList.add('on'); this.el.innerHTML='<div class="wheel-ring"></div>'+list.map((v,i)=>{const a=-Math.PI/2+i*Math.PI*2/3;return `<div class="wheel-item ${i===this.selected?'selected':''} ${v===current?'current':''}" style="left:${50+38*Math.cos(a)}%;top:${50+38*Math.sin(a)}%"><span>${icons[v]}</span>${names[v]}</div>`}).join('')+`<div class="wheel-center">${this.held==='KeyQ'?'ДЕТАЛЬ':'МАТЕРИАЛ'}<small>Отпусти ${this.held==='KeyQ'?'Q':'Z'}</small></div><div class="wheel-cursor" style="transform:translate(${this.x}px,${this.y}px)"></div>`;
    } else this.el.classList.remove('on');
    return {kind,material:mat};
  }
}
