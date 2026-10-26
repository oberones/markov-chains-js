import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { parseMidi, writeMidi } from 'midi-file';
import { decodeToy } from '../../src/storage/index.js';
import { makeSound, fraction, soundKey } from '../../src/core/music.js';

async function range(page, id, value) {
  await page.locator(`#${id}`).evaluate((el, value) => {el.value=String(value);el.dispatchEvent(new Event('input',{bubbles:true}));},value);
}
async function download(page, button) {
  const pending=page.waitForEvent('download');await page.locator(button).click();const item=await pending;return {bytes:await readFile(await item.path()),name:item.suggestedFilename()};
}
test('play, freeze, export both formats, save and restore a toy through the UI', async ({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await expect(page.locator('.world')).toHaveCount(4);
  await expect(page.locator('#freeze-button')).toBeDisabled();
  await range(page,'tempo',240);await page.locator('#play-button').click();
  await expect(page.locator('#mode-badge')).toContainText('FOLLOWING CHANCE');
  await expect(page.locator('#freeze-button')).toBeEnabled({timeout:5000});
  await page.locator('#freeze-button').click();
  await expect(page.locator('#mode-badge')).toContainText('MOMENT ON REPEAT');
  await expect(page.locator('#clip-info')).toContainText('sounds bottled');
  const wav=await download(page,'#wav-button');expect(wav.bytes.toString('ascii',0,4)).toBe('RIFF');expect(wav.bytes.length).toBeGreaterThan(1000);
  const midi=await download(page,'#midi-button');const parsed=parseMidi(midi.bytes);expect(parsed.tracks.flat().some(e=>e.type==='endOfTrack')).toBeTruthy();
  await page.locator('#toy-name').fill('Saved orbit');
  const portable=await download(page,'#download-toy-button');const toy=decodeToy(portable.bytes.toString());expect(toy.clip.events.length).toBeGreaterThan(0);expect(toy.controls.tempo).toBe(240);
  await page.locator('#save-button').click();await expect(page.getByRole('button',{name:'Open Saved orbit',exact:true})).toBeVisible();
  await page.locator('#play-button').click();await page.reload();
  await page.getByRole('button',{name:'Open Saved orbit',exact:true}).click();
  await expect(page.locator('#mode-badge')).toContainText('MOMENT BOTTLED');await expect(page.locator('#play-button')).toHaveAccessibleName('Play music');
  await expect(page.locator('#tempo')).toHaveValue('240');
  await page.locator('#play-button').click();await expect(page.locator('#mode-badge')).toContainText('MOMENT ON REPEAT');
  await page.locator('#freeze-button').click();await expect(page.locator('#mode-badge')).toContainText('FOLLOWING CHANCE');
  await expect(page.locator('#wav-button')).toBeDisabled();await page.locator('#play-button').click();
  await page.locator('#toy-file').setInputFiles({name:'round-trip.json',mimeType:'application/json',buffer:portable.bytes});
  await expect(page.locator('#status')).toContainText('Saved orbit');
  await page.getByRole('button',{name:'Delete Saved orbit',exact:true}).click();
  await expect(page.locator('#library-list')).toContainText('Nothing on the shelf');
  expect(errors).toEqual([]);
});

test('every example plays, edits affect displayed chances, and reset restores the model', async ({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
  for(const name of ['Slow orbit','Lanterns','Cosmic hop','Night drive']){
    await page.getByRole('button',{name:new RegExp(`^${name}:`)}).click();await expect(page.locator('#source-name')).toHaveText(name);
    await range(page,'tempo',240);await page.locator('#play-button').click();await expect(page.locator('#heard-count')).not.toHaveText('0 sounds explored');await page.locator('#play-button').click();
  }
  const before=await page.locator('#connections-list output').allTextContents();
  await range(page,'weight-0',0);await expect(page.locator('#connections-list output').first()).toHaveText('0.0%');await expect(page.locator('#model-note')).toContainText('Chances edited');
  await range(page,'temperature',2);await expect(page.locator('#model-note')).toContainText('Surprise reshapes');
  await page.locator('#reset-button').click();expect(await page.locator('#connections-list output').allTextContents()).toEqual(before);
  await expect(page.locator('#temperature')).toHaveValue('1');
  await page.locator('#connection-search').fill('Silence');expect(await page.locator('#connections-list .connection-row').count()).toBeGreaterThan(0);expect((await page.locator('#connections-list label').allTextContents()).every(t=>t.includes('Silence'))).toBe(true);await page.locator('#connection-search').fill('');
  await page.locator('#state-search').fill('Silence');await expect(page.locator('#state-select option')).toHaveCount(3);
  await page.locator('#state-select').selectOption({label:'Silence · 1/2 beats'});await expect(page.locator('#selected-summary')).toContainText('Silence');
  await page.locator('#audition-button').click();await page.locator('#journey-button').click();
  expect(errors).toEqual([]);
});

const score=`<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Flute</part-name></score-part><score-part id="P2"><part-name>Keys</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>4</divisions></attributes><direction><sound tempo="180"/></direction><note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration></note><note><rest/><duration>2</duration></note></measure></part><part id="P2"><measure number="1"><attributes><divisions>4</divisions></attributes><note><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration></note><note><chord/><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration></note></measure></part></score-partwise>`;
test('import, choose a part, preview, explore, and recover from invalid files', async ({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
  await page.locator('#music-file').setInputFiles({name:'tiny.musicxml',mimeType:'application/xml',buffer:Buffer.from(score)});
  await expect(page.locator('#part-select option')).toHaveCount(2);
  await page.locator('#part-select').selectOption({label:'Keys'});await page.locator('#preview-button').click();await expect(page.locator('#status')).toContainText('Previewing');
  await page.locator('#use-import-button').click();await expect(page.locator('#source-name')).toContainText('Keys');await expect(page.locator('#selected-summary')).toContainText('E4');
  await page.locator('#play-button').click();await expect(page.locator('#heard-count')).not.toHaveText('0 sounds explored');await page.locator('#play-button').click();
  await page.locator('#music-file').setInputFiles({name:'bad.xml',mimeType:'application/xml',buffer:Buffer.from('<broken>')});await expect(page.locator('#status')).toHaveClass(/error/);await expect(page.locator('#source-name')).toContainText('Keys');
  const midi=writeMidi({header:{format:0,numTracks:1,ticksPerBeat:480},tracks:[[{deltaTime:0,type:'noteOn',channel:0,noteNumber:60,velocity:90},{deltaTime:480,type:'noteOff',channel:0,noteNumber:60,velocity:0},{deltaTime:0,type:'endOfTrack'}]]});
  await page.locator('#music-file').setInputFiles({name:'little.mid',mimeType:'audio/midi',buffer:Buffer.from(midi)});await expect(page.locator('#use-import-button')).toBeEnabled();await page.locator('#use-import-button').click();await expect(page.locator('#source-name')).toContainText('little.mid');
  expect(errors).toEqual([]);
});

test('desktop and narrow layouts, keyboard graph selection, local resources, and reduced motion', async ({page})=>{
  const remote=[];page.on('request',request=>{if(!request.url().startsWith('http://127.0.0.1:5173/')&&!request.url().startsWith('data:'))remote.push(request.url());});
  await page.setViewportSize({width:1440,height:1000});await page.goto('/');await page.emulateMedia({reducedMotion:'reduce'});
  await expect(page.locator('#graph .graph-node')).toHaveCount(6);
  await page.locator('#graph .graph-node').nth(1).focus();await page.keyboard.press('Enter');await expect(page.locator('#graph .graph-node').nth(1)).toHaveAttribute('aria-pressed','true');await expect(page.locator('#graph .graph-node').nth(1)).toBeFocused();
  const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  expect(await overflow()).toBe(false);
  await mkdir('artifacts/validation',{recursive:true});await page.screenshot({path:'artifacts/validation/desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.goto('/');expect(await overflow()).toBe(false);
  await expect(page.locator('#play-button')).toBeInViewport();
  await page.screenshot({path:'artifacts/validation/mobile.png',fullPage:true});
  const animation=await page.locator('#graph .halo').first().evaluate(el=>getComputedStyle(el).animationName);expect(animation).toBe('none');
  await page.getByRole('link',{name:'How it works'}).click();await page.locator('#learn summary').click();await expect(page.locator('.learn-content')).toBeVisible();
  expect(remote).toEqual([]);
});

test('stopped unfreeze resumes from its captured state and ordinary restart clears heard history', async ({page})=>{
  const events=[60,64,67].map(p=>makeSound([p],fraction(1)));
  const toy={version:1,name:'Continuation check',savedAt:new Date().toISOString(),source:{name:'Three steps',events,warnings:[]},seed:'resume',overrides:{},controls:{tempo:240,preset:'warm',temperature:1,volume:.2,freezeCount:8},clip:{events:[{stateId:soundKey(events[1]),sound:events[1]}]}};
  await page.goto('/');await page.locator('#toy-file').setInputFiles({name:'continuation.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(toy))});
  await page.locator('#freeze-button').click();await page.locator('#play-button').click();
  await expect(page.locator('#now-playing')).toHaveText('G4 · 1 beat');
  await expect(page.locator('#freeze-button')).toBeEnabled();
  await page.locator('#play-button').click();await page.locator('#play-button').click();
  await expect(page.locator('#freeze-button')).toBeDisabled();await page.locator('#play-button').click();
});

test('failed audio preview remains stopped and keeps its useful error',async({page})=>{
  await page.addInitScript(()=>{window.AudioContext=class{constructor(){throw new Error('Audio unavailable for this test.');}};});
  await page.goto('/');await page.locator('#music-file').setInputFiles({name:'preview.musicxml',mimeType:'application/xml',buffer:Buffer.from(score)});
  await page.locator('#preview-button').click();await expect(page.locator('#status')).toContainText('Audio unavailable');
  await expect(page.locator('#preview-button')).toHaveText('Hear the training sounds');
});

test('slow earlier uploads cannot replace a more recent chosen file',async({page})=>{
  await page.addInitScript(()=>{const original=File.prototype.arrayBuffer;File.prototype.arrayBuffer=async function(){if(this.name==='slow.musicxml')await new Promise(resolve=>{window.releaseSlow=resolve;});return original.call(this);};});
  await page.goto('/');await page.locator('#music-file').setInputFiles({name:'slow.musicxml',mimeType:'application/xml',buffer:Buffer.from(score)});
  await page.locator('#music-file').setInputFiles({name:'recent.musicxml',mimeType:'application/xml',buffer:Buffer.from(score)});
  await expect(page.locator('#use-import-button')).toBeEnabled();await page.evaluate(()=>window.releaseSlow());
  await page.locator('#use-import-button').click();await expect(page.locator('#source-name')).toContainText('recent.musicxml');
});
