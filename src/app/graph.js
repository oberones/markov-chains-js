import { soundName, durationName } from '../core/music.js';
import { distribution } from '../core/model.js';

const NS = 'http://www.w3.org/2000/svg';
function svg(tag, attributes = {}, text) {
  const element = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  if (text !== undefined) element.textContent = text;
  return element;
}
export function soundColor(sound) {
  if (!sound.pitches.length) return '#91a1b7';
  return ['#b9a5f5','#e6b2d8','#9ddbc4','#c3b0f4','#e8c892','#a7c7ee'][sound.pitches[0] % 6];
}

export function createGraph(element, onSelect, onVisibleCount = () => {}) {
  let state;
  let visible = [];
  let nodes = new Map();
  let edges = [];
  let previous = null;
  let current = null;

  function render(next) {
    state = next;
    const {model,selected,temperature,overrides} = next;
    const focusedId=[...nodes].find(([,node])=>node===document.activeElement)?.[0];
    const compact=element.getBoundingClientRect().width<500;
    const width=compact?430:760;
    const center=width/2;
    const limit=compact?12:32;
    const successors=id=>distribution(model,id,temperature,overrides).filter(e=>e.probability>0).sort((a,b)=>b.probability-a.probability).map(e=>e.id);
    const playing=model.states.has(current)?current:null;
    const candidates = [focusedId,selected,playing,...(playing?successors(playing):[]),...successors(selected),...model.states.keys()].filter(Boolean);
    visible = [...new Set(candidates)].slice(0,limit);
    // Use original ordering for stable geometry as a new sound is selected.
    visible.sort((a,b)=>[...model.states.keys()].indexOf(a)-[...model.states.keys()].indexOf(b));
    nodes = new Map(); edges = [];
    element.replaceChildren();element.setAttribute('viewBox',`0 0 ${width} 430`);
    const defs = svg('defs');
    const glow = svg('filter',{id:'node-glow',x:'-100%',y:'-100%',width:'300%',height:'300%'});
    glow.append(svg('feGaussianBlur',{stdDeviation:7})); defs.append(glow);
    const arrow = svg('marker',{id:'path-arrow',markerWidth:5,markerHeight:5,refX:4,refY:2.5,orient:'auto'});
    arrow.append(svg('path',{d:'M0 0 L5 2.5 L0 5',fill:'#b8a4ee',opacity:.6})); defs.append(arrow); element.append(defs);
    for (const radius of [80,150,220,290]) element.append(svg('ellipse',{cx:center,cy:208,rx:radius*(compact?.6:1),ry:radius*.57,class:'graph-orbit'}));
    for (let i=0;i<56;i++) element.append(svg('circle',{cx:20+(i*149.37)%(width-40),cy:12+(i*83.7)%390,r:i%6===0?1.4:.65,class:'graph-star'}));
    const positions = new Map();
    visible.forEach((id,i)=>{
      const count=visible.length;
      const angle=(i/count)*Math.PI*2-Math.PI/2;
      const inner=count>10 && i%3===0;
      const radius=count===1?0:inner?90:compact?155:count>18?230:205;
      positions.set(id,{x:center+Math.cos(angle)*radius*(compact?1:1.25),y:202+Math.sin(angle)*radius*(compact?.92:.71)});
    });
    for (const from of visible) {
      for (const entry of distribution(model,from,temperature,overrides)) {
        if (!positions.has(entry.id)) continue;
        const a=positions.get(from), b=positions.get(entry.id);
        const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1;
        const start={x:a.x+dx/len*17,y:a.y+dy/len*17};
        const end={x:b.x-dx/len*22,y:b.y-dy/len*22};
        const d=from===entry.id?`M${a.x-10},${a.y-14} C${a.x-49},${a.y-65} ${a.x+49},${a.y-65} ${a.x+10},${a.y-14}`:`M${start.x},${start.y} Q${(a.x+b.x)/2-dy*.11},${(a.y+b.y)/2+dx*.11} ${end.x},${end.y}`;
        const path=svg('path',{d,class:'graph-edge','marker-end':'url(#path-arrow)'});
        path.append(svg('title',{},`${soundName(model.states.get(from))} → ${soundName(model.states.get(entry.id))}: ${(entry.probability*100).toFixed(1)}%`));
        element.append(path); edges.push({from,to:entry.id,path});
      }
    }
    visible.forEach(id=>{
      const sound=model.states.get(id), pos=positions.get(id), color=soundColor(sound);
      const group=svg('g',{class:'graph-node',transform:`translate(${pos.x},${pos.y})`,tabindex:0,role:'button','aria-label':`${soundName(sound)}, ${durationName(sound)}. Inspect connections.`});
      group.append(svg('circle',{r:26,fill:color,filter:'url(#node-glow)',class:'halo'}));
      group.append(svg('circle',{r:compact?28:22,fill:'transparent',stroke:'transparent'}));
      group.append(svg('circle',{r:16,fill:'#222438',stroke:color,class:'node-core'}));
      group.append(svg('text',{y:4,'text-anchor':'middle',class:'node-symbol'},sound.pitches.length>1?'✧':sound.pitches.length?'·':'◌'));
      const label=sound.pitches.length>2?`${soundName(sound).split(' · ').slice(0,2).join(' · ')} +${sound.pitches.length-2}`:soundName(sound);
      group.append(svg('text',{y:33,'text-anchor':'middle'},label));
      group.addEventListener('click',()=>onSelect(id));
      group.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();onSelect(id);}});
      nodes.set(id,group); element.append(group);
    });
    highlight();
    if(focusedId&&nodes.has(focusedId))nodes.get(focusedId).focus({preventScroll:true});
    onVisibleCount(visible.length);
    return visible.length;
  }
  function highlight() {
    for (const [id,node] of nodes) {
      node.classList.toggle('current',id===current);
      node.classList.toggle('selected',id===state.selected);
      node.setAttribute('aria-pressed',String(id===state.selected));
    }
    edges.forEach(({from,to,path})=>{
      path.classList.toggle('outgoing',from===(current || state.selected));
      path.classList.toggle('travelled',from===previous&&to===current);
    });
  }
  return {
    render,
    play(id) {previous=current;current=id;if(state.model.states.size>visible.length||!nodes.has(id))render(state);else highlight();},
    clear() {previous=null;current=null;if(state)highlight();}
  };
}
