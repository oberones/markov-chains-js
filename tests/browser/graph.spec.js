import {test,expect} from '@playwright/test';

test('large graph shows current successors without changing full probabilities',async({page})=>{
  await page.goto('/');
  const result=await page.evaluate(async()=>{
    const {createGraph}=await import('/src/app/graph.js');
    const {train,distribution}=await import('/src/core/model.js');
    const {makeSound,fraction}=await import('/src/core/music.js');
    const events=Array.from({length:50},(_,i)=>makeSound([i+40],fraction(1)));
    const model=train(events),ids=[...model.states.keys()];
    const graph=createGraph(document.querySelector('#graph'),()=>{});
    graph.render({model,selected:ids[0],temperature:1,overrides:{}});graph.play(ids[41]);
    return {nodes:document.querySelectorAll('#graph .graph-node').length,arrows:document.querySelectorAll('#graph .graph-edge.outgoing').length,chance:distribution(model,ids[41])[0].probability,playing:document.querySelector('#graph .current')?.getAttribute('aria-label')};
  });
  expect(result.nodes).toBe(32);expect(result.arrows).toBe(1);expect(result.chance).toBe(1);expect(result.playing).toContain('A5');
});
