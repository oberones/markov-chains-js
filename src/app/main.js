import { train, createWalker, distribution, validateOverrides } from '../core/model.js';
import { soundName, durationName, soundKey, toBeats } from '../core/music.js';
import { examples } from '../core/examples.js';
import { createTransport } from '../audio/transport.js';
import { renderWav, renderMidi } from '../audio/export.js';
import { inspectFile } from '../import/index.js';
import { encodeToy, decodeToy, saveToy, listToys, loadToy, deleteToy } from '../storage/index.js';
import { createGraph, soundColor } from './graph.js';

const $ = id => document.getElementById(id);
const state = {
  source:null, model:null, selected:null, overrides:{}, seed:'slow-orbit-01',
  controls:{tempo:96,preset:'warm',temperature:1,volume:.65,freezeCount:16},
  walker:null, heard:0, trail:[], importData:null, imported:null, previewing:false, busy:false,resumeAfterUnfreeze:false
};
let importRequest=0,restoreRequest=0;
const graph = createGraph($('graph'), selectState,updateGraphCount);
let previewCursor=0,previewEvents=[];
const preview = createTransport({
  getNextEvent:()=>previewEvents[previewCursor++] || null,
  onMode:mode=>{if(mode==='stopped' && state.previewing){state.previewing=false;$('preview-button').textContent='Hear the training sounds';}},
  onError:error=>status(error.message,true)
});
const transport = createTransport({
  getNextEvent:()=>state.walker.next(),
  onEvent:event=>{
    state.heard++;
    state.trail.push(event); if(state.trail.length>18)state.trail.shift();
    graph.play(event.stateId);
    $('heard-count').textContent=`${state.heard} sounds explored`;
    $('now-playing').textContent=`${soundName(event.sound)} · ${durationName(event.sound)}`;
    $('trail').replaceChildren(...state.trail.map(item=>{const dot=document.createElement('i');dot.style.background=soundColor(item.sound);return dot;}));
    updateTransport();
  },
  onComplete:()=>updateTransport(),
  onMode:()=>updateTransport(),
  onResumeFromState:id=>{if(id)state.walker.setCurrent(id);state.resumeAfterUnfreeze=!transport.getStatus().isRunning;},
  onError:error=>status(error.message,true)
});

function status(message,error=false) { $('status').textContent=message;$('status').classList.toggle('error',error); }
function report(error) { status(error?.message || 'Something went wrong. Please try again.',true); }
function listen(id,event,fn) { $(id).addEventListener(event,async e=>{try{await fn(e);}catch(error){report(error);}}); }
function freshSeed() { const a=new Uint32Array(2);crypto.getRandomValues(a);return [...a].map(n=>n.toString(36)).join('-'); }
function resetWalker() {state.walker=createWalker(state.model,{seed:state.seed,temperature:state.controls.temperature,overrides:state.overrides});}
function stopPreview() {preview.stop();state.previewing=false;$('preview-button').textContent='Hear the training sounds';}
function clearJourney() {state.heard=0;state.trail=[];$('trail').replaceChildren();$('heard-count').textContent='0 sounds explored';$('now-playing').textContent='Your journey starts with a click.';graph.clear();}

function useSource(source,{seed=freshSeed(),controls=state.controls,overrides={},clip=null,world=null}={}) {
  const model=train(source.events);validateOverrides(model,overrides);
  importRequest++;restoreRequest++;
  transport.stop();stopPreview();
  state.source=structuredClone(source);state.model=model;state.selected=model.sequence[0];state.overrides=structuredClone(overrides);state.seed=seed;state.controls={...controls};
  state.resumeAfterUnfreeze=false;resetWalker();transport.update(state.controls);transport.setClip(clip);
  $('source-name').textContent=source.name;$('toy-name').value=`My ${source.name.toLowerCase()}`.slice(0,100);
  $('state-search').value='';$('connection-search').value='';
  document.querySelectorAll('.world').forEach(b=>{b.classList.toggle('active',b.dataset.world===world);b.setAttribute('aria-pressed',String(b.dataset.world===world));});
  clearJourney();updateControls();renderStateSelect();renderConnections();renderGraph();updateTransport();
}

function updateControls() {
  $('tempo').value=state.controls.tempo;$('sound-select').value=state.controls.preset;$('temperature').value=state.controls.temperature;$('volume').value=state.controls.volume;$('freeze-count').value=state.controls.freezeCount;$('seed').value=state.seed;
  $('tempo-value').textContent=`${Math.round(state.controls.tempo)} BPM`;
  $('temperature-value').textContent=state.controls.temperature===1?'As learned':state.controls.temperature<1?'More familiar':'More unexpected';
  $('volume-value').textContent=`${Math.round(state.controls.volume*100)}%`;
}
function updateTransport() {
  const s=transport.getStatus();const clip=transport.getClip();
  $('play-button').textContent=s.isRunning?'■ Stop':'▶ Play';
  $('play-button').setAttribute('aria-label',s.isRunning?'Stop playback':'Play music');
  $('freeze-button').textContent=clip?'❄ Unfreeze':'❄ Freeze';
  $('freeze-button').classList.toggle('frozen',Boolean(clip));
  $('freeze-button').disabled=!clip && s.completedCount===0;
  $('freeze-button').setAttribute('aria-pressed',String(Boolean(clip)));
  const modes={stopped:clip?'MOMENT BOTTLED':'READY TO WANDER',live:'FOLLOWING CHANCE',freezing:'BOTTLING A MOMENT',frozen:'MOMENT ON REPEAT',unfreezing:'BACK TO THE UNKNOWN'};
  $('mode-badge').replaceChildren();const dot=document.createElement('span');dot.className='tiny-dot';$('mode-badge').append(dot,document.createTextNode(modes[s.mode]||modes.stopped));
  $('wav-button').disabled=!clip||state.busy;$('midi-button').disabled=!clip||state.busy;
  if(clip){const seconds=clip.events.reduce((sum,e)=>sum+toBeats(e.sound.duration),0)*60/state.controls.tempo;$('clip-info').textContent=`${clip.events.length} sounds bottled · ${seconds.toFixed(1)} seconds + fade`;}else $('clip-info').textContent='No moment bottled yet.';
}
function renderGraph() {
  if(!state.model)return;
  graph.render({model:state.model,selected:state.selected,temperature:state.controls.temperature,overrides:state.overrides});
}
function updateGraphCount(shown) {
  const paths=[...state.model.transitions.values()].reduce((n,row)=>n+row.size,0);
  $('graph-count').textContent=`${shown<state.model.states.size?`${shown} of `:''}${state.model.states.size} sounds · ${paths} paths`;
}
function renderStateSelect() {
  const query=$('state-search').value.trim().toLowerCase();
  const options=[];
  for(const [id,sound] of state.model.states){const label=`${soundName(sound)} · ${durationName(sound)}`;if(query&&!label.toLowerCase().includes(query)&&id!==state.selected)continue;const option=document.createElement('option');option.value=id;option.textContent=label;options.push(option);}
  $('state-select').replaceChildren(...options);$('state-select').value=state.selected;
}
function selectState(id) {state.selected=id;$('connection-search').value='';renderStateSelect();renderConnections();renderGraph();}
function explainRow(entry) {
  const observed=state.model.observed.get(state.selected);
  const count=observed?.get(entry.id)||0,total=observed?[...observed.values()].reduce((a,b)=>a+b,0):0;
  const boundary=state.model.boundary.get(state.selected)?.get(entry.id)||0;
  return `${count?`Followed this sound ${count} out of ${total} times`:'No observed transition'}${boundary?`${count?' · ':'. '}Added closing path ×${boundary}`:''}`;
}
function updateChanceOutputs() {
  const rows=distribution(state.model,state.selected,state.controls.temperature,state.overrides);
  for(const output of $('connections-list').querySelectorAll('output')){const row=rows.find(r=>r.id===output.dataset.target);output.textContent=`${(row.probability*100).toFixed(1)}%`;}
  const edited=Object.keys(state.overrides).length>0;
  $('model-note').textContent=`${edited?'Chances edited':'As learned'}${state.controls.temperature!==1?' · Surprise reshapes these chances':''} · ${transport.getClip()?'Edits apply when you unfreeze.':'Each choice depends only on the current sound.'}`;
}
function renderConnections() {
  const sound=state.model.states.get(state.selected);const n=state.model.counts.get(state.selected)||0;
  $('selected-summary').textContent=`${soundName(sound)} · ${durationName(sound)} · ${n} appearances in the source${n?` · ${(n/state.model.total*100).toFixed(1)}% starting chance`:' · added closing rest'}`;
  const rows=distribution(state.model,state.selected,state.controls.temperature,state.overrides);
  const query=$('connection-search').value.trim().toLowerCase();
  const matching=rows.filter(entry=>{const target=state.model.states.get(entry.id);return `${soundName(target)} ${durationName(target)}`.toLowerCase().includes(query);});
  $('connection-count').textContent=`${matching.length} of ${rows.length} paths`;
  $('connections-list').replaceChildren(...matching.map((entry,index)=>{
    const target=state.model.states.get(entry.id);const row=document.createElement('div');row.className='connection-row';
    const label=document.createElement('label');label.className='connection-name';label.htmlFor=`weight-${index}`;label.append(document.createTextNode(soundName(target)));
    const detail=document.createElement('span');detail.className='connection-detail';detail.textContent=`${durationName(target)} · ${explainRow(entry)}`;label.append(detail);
    const input=document.createElement('input');input.type='range';input.id=`weight-${index}`;input.min='0';input.max=String(Math.max(10,...rows.map(e=>e.weight))*2);input.step='1';input.value=entry.weight;input.setAttribute('aria-label',`Weight to ${soundName(target)}, ${durationName(target)}`);
    input.addEventListener('input',()=>{
      const prior=distribution(state.model,state.selected,1,state.overrides).find(e=>e.id===entry.id).weight;
      const candidate=structuredClone(state.overrides);candidate[state.selected]={...candidate[state.selected],[entry.id]:Number(input.value)};
      try{distribution(state.model,state.selected,1,candidate);state.overrides=candidate;state.walker.update({overrides:candidate});updateChanceOutputs();renderGraph();}
      catch(error){input.value=prior;report(error);}
    });
    const output=document.createElement('output');output.htmlFor=input.id;output.dataset.target=entry.id;row.append(label,input,output);return row;
  }));updateChanceOutputs();
}

async function startJourney({newSeed=false}={}) {
  const running=transport.getStatus().isRunning;transport.stop();stopPreview();transport.setClip(null);
  if(newSeed)state.seed=freshSeed();state.resumeAfterUnfreeze=false;resetWalker();clearJourney();updateControls();updateTransport();
  if(running)await transport.start();
  status(newSeed?'A new seed, a new path through the same universe.':'Seed set. This journey is yours to revisit.');
}

function currentToy() {
  return {version:1,name:$('toy-name').value.trim()||state.source.name,savedAt:new Date().toISOString(),source:structuredClone(state.source),seed:state.seed,overrides:state.overrides,controls:state.controls,clip:transport.getClip()};
}
function restoreToy(toy) {
  useSource(toy.source,{seed:toy.seed,controls:toy.controls,overrides:toy.overrides,clip:toy.clip});$('toy-name').value=toy.name;
  status(`“${toy.name}” is ready. Press Play when you want to listen.`);
}
function download(data,type,name) {
  const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),5000);
}
function filename(extension) {return ($('toy-name').value.trim()||'markov-playground').replace(/[^a-z0-9_-]+/gi,'-').slice(0,80)+extension;}
async function refreshLibrary() {
  try{
    const toys=await listToys();
    if(!toys.length){$('library-list').replaceChildren();const p=document.createElement('p');p.className='small muted';p.textContent='Nothing on the shelf yet. Save a universe you like.';$('library-list').append(p);return;}
    $('library-list').replaceChildren(...toys.map(toy=>{
      const row=document.createElement('div');row.className='library-item';
      const open=document.createElement('button');open.className='text-button';open.textContent=`✧ ${toy.name}`;open.setAttribute('aria-label',`Open ${toy.name}`);open.addEventListener('click',async()=>{const token=++restoreRequest;try{const saved=await loadToy(toy.id);if(token===restoreRequest)restoreToy(saved);}catch(error){if(token===restoreRequest)report(error);}});
      const remove=document.createElement('button');remove.className='text-button delete-save';remove.textContent='Delete';remove.setAttribute('aria-label',`Delete ${toy.name}`);remove.addEventListener('click',async()=>{try{await deleteToy(toy.id);await refreshLibrary();status(`Removed “${toy.name}” from this browser.`);}catch(error){report(error);}});
      row.append(open,remove);return row;
    }));
  }catch(error){$('library-list').textContent='Browser storage is unavailable. Download a toy file to keep your work.';}
}
function selectImportPart() {
  stopPreview();state.imported=null;$('preview-button').disabled=true;$('use-import-button').disabled=true;
  try{const selected=state.importData.readPart($('part-select').value);train(selected.events);state.imported=selected;
    const name=state.importData.parts.find(p=>p.id===$('part-select').value)?.name||'Selected part';
    $('import-summary').textContent=`${selected.events.length} training sounds · ${selected.tempo} BPM. ${selected.warnings.join(' ')}`;
    $('preview-button').disabled=false;$('use-import-button').disabled=false;status(`${name} is ready to preview. Your current universe is kept until you choose Explore.`);
  }catch(error){$('import-summary').textContent=error.message;report(error);}
}

examples.forEach((example,index)=>{
  const button=document.createElement('button');button.className='world';button.dataset.world=example.id;button.style.setProperty('--world-color',example.color);button.setAttribute('aria-label',`${example.name}: ${example.description}`);
  const symbol=document.createElement('span');symbol.className='world-symbol';symbol.setAttribute('aria-hidden','true');symbol.textContent=['◎','✧','⌁','◒'][index];
  const text=document.createElement('span');const name=document.createElement('span');name.className='world-name';name.textContent=example.name;const tag=document.createElement('span');tag.className='world-tag';tag.textContent=example.tag;text.append(name,tag);button.append(symbol,text);
  button.addEventListener('click',async()=>{try{const running=transport.getStatus().isRunning;useSource({name:example.name,events:example.events,warnings:[]},{seed:`${example.id}-01`,controls:{...state.controls,tempo:example.tempo,preset:example.preset,temperature:1},world:example.id});status(example.description);if(running)await transport.start();}catch(error){report(error);}});$('worlds').append(button);
});

listen('play-button','click',async()=>{
  stopPreview();if(transport.getStatus().isRunning){transport.stop();graph.clear();status('Stopped. Your sounds and chances are still yours.');return;}
  if(!transport.getClip()){transport.setClip(null);if(!state.resumeAfterUnfreeze)resetWalker();clearJourney();}state.resumeAfterUnfreeze=false;transport.update(state.controls);const started=await transport.start();if(started)status(transport.getClip()?'Your bottled moment is on repeat. Unfreeze to keep exploring.':'Follow the lights. Change a chance and listen for a new possibility.');
});
listen('journey-button','click',()=>startJourney({newSeed:true}));
listen('seed-button','click',()=>{const seed=$('seed').value.trim();if(!seed)throw new Error('Give your journey a seed first.');state.seed=seed;return startJourney();});
listen('freeze-button','click',()=>{
  if(transport.getClip()){transport.unfreeze();status('Back to the unknown. Your edited chances guide the next sounds.');}
  else{const clip=transport.freeze(state.controls.freezeCount);if(!clip){status('Let one whole sound finish before freezing.');return;}status(`${clip.events.length} completed sounds bottled. Hear them again or take them with you.`);}
  updateTransport();updateChanceOutputs();
});
for(const [id,key] of [['tempo','tempo'],['temperature','temperature'],['volume','volume'],['freeze-count','freezeCount']])listen(id,'input',()=>{
  state.controls[key]=Number($(id).value);transport.update(state.controls);if(key==='volume'||key==='tempo')preview.update({[key]:state.controls[key]});state.walker.update({temperature:state.controls.temperature});updateControls();updateTransport();if(key==='temperature'){updateChanceOutputs();renderGraph();}
});
listen('sound-select','change',()=>{state.controls.preset=$('sound-select').value;transport.update(state.controls);preview.update({preset:state.controls.preset});});
listen('state-search','input',renderStateSelect);
listen('connection-search','input',renderConnections);
listen('state-select','change',()=>selectState($('state-select').value));
listen('reset-button','click',()=>{state.overrides={};state.controls.temperature=1;state.walker.update({temperature:1,overrides:{}});updateControls();renderConnections();renderGraph();status('The learned chances are restored.');});
listen('audition-button','click',async()=>{transport.stop();graph.clear();stopPreview();previewEvents=[{stateId:state.selected,sound:state.model.states.get(state.selected)}];previewCursor=0;preview.update(state.controls);if(await preview.start())status('A little listen to this sound. Press Play to return to your journey.');});
listen('music-file','change',async event=>{
  const file=event.target.files[0];if(!file)return;const token=++importRequest;restoreRequest++;event.target.value='';stopPreview();state.imported=null;$('import-options').hidden=true;status('Listening to the structure of your file…');
  try{const imported=await inspectFile(file);if(token!==importRequest)return;state.importData=imported;$('part-select').replaceChildren(...state.importData.parts.map(part=>{const o=document.createElement('option');o.value=part.id;o.textContent=part.name;return o;}));$('import-options').hidden=false;selectImportPart();}catch(error){if(token===importRequest)report(error);}
});
listen('part-select','change',selectImportPart);
listen('preview-button','click',async()=>{
  if(state.previewing){stopPreview();return;}if(!state.imported)return;transport.stop();preview.stop();previewEvents=state.imported.events.map(sound=>({stateId:soundKey(sound),sound}));previewCursor=0;preview.update({...state.controls,tempo:state.imported.tempo});state.previewing=true;$('preview-button').textContent='Stop preview';if(await preview.start())status('Previewing the normalized training sounds, including chord snapshots and rests.');else{state.previewing=false;$('preview-button').textContent='Hear the training sounds';}
});
listen('use-import-button','click',()=>{
  if(!state.imported)return;const part=state.importData.parts.find(p=>p.id===$('part-select').value);const data=state.imported;
  useSource({name:`${state.importData.name} · ${part.name}`.slice(0,200),events:data.events,warnings:data.warnings},{controls:{...state.controls,tempo:data.tempo,temperature:1}});status('Your part is now a universe of possibilities. Press Play to explore.');
});
listen('wav-button','click',async()=>{const clip=transport.getClip();if(!clip)return;const outputName=filename('.wav');const settings={...state.controls};state.busy=true;updateTransport();status('Rendering your bottled moment…');try{download(await renderWav(clip,settings),'audio/wav',outputName);status('WAV ready: your frozen phrase, with its fading tail.');}finally{state.busy=false;updateTransport();}});
listen('midi-button','click',()=>{const clip=transport.getClip();if(!clip)return;download(renderMidi(clip,state.controls),'audio/midi',filename('.mid'));status('MIDI ready. Choose an instrument in your music app to give it a voice.');});
listen('save-button','click',async()=>{const toy=currentToy();await saveToy(toy);await refreshLibrary();status(`“${toy.name}” saved in this browser.`);});
listen('download-toy-button','click',()=>{download(encodeToy(currentToy()),'application/json',filename('.markov.json'));status('Portable toy downloaded. Open it here to revisit the same universe.');});
listen('toy-file','change',async event=>{const file=event.target.files[0];if(!file)return;const token=++restoreRequest;event.target.value='';try{if(file.size>5*1024*1024)throw new Error('Toy files must be 5 MiB or smaller.');const text=await file.text();if(token===restoreRequest)restoreToy(decodeToy(text));}catch(error){if(token===restoreRequest)report(error);}});
listen('toy-file-label','keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$('toy-file').click();}});
listen('music-file-label','keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();$('music-file').click();}});
document.addEventListener('keydown',event=>{if(event.code==='Space'&&!event.repeat&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!['INPUT','TEXTAREA','SELECT','BUTTON','SUMMARY','A','LABEL'].includes(event.target.tagName)&&!event.target.closest('[role="button"]')){event.preventDefault();$('play-button').click();}});
window.addEventListener('pagehide',()=>{transport.stop();preview.stop();});
let resizeFrame=0;
window.addEventListener('resize',()=>{cancelAnimationFrame(resizeFrame);resizeFrame=requestAnimationFrame(renderGraph);});

useSource({name:examples[0].name,events:examples[0].events,warnings:[]},{seed:state.seed,controls:state.controls,world:'drift'});
refreshLibrary();
