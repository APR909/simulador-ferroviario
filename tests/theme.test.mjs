import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeTheme} from '../src/theme.js';

function withThemeEnvironment(initial, failStorage, run) {
  const saved={document:globalThis.document,window:globalThis.window,localStorage:globalThis.localStorage,CustomEvent:globalThis.CustomEvent};
  const attributes={},callbacks={},label={textContent:''},meta={},events=[],storage={};
  const button={title:'',setAttribute:(key,value)=>{attributes[key]=value;},addEventListener:(name,handler)=>{callbacks[name]=handler;}};
  globalThis.document={documentElement:{dataset:{theme:initial}},getElementById:id=>id==='themeToggle'?button:id==='themeLabel'?label:null,querySelector:()=>({setAttribute:(key,value)=>{meta[key]=value;}})};
  globalThis.window={dispatchEvent:event=>events.push(event)};
  globalThis.localStorage={setItem:(key,value)=>{if(failStorage)throw Error('blocked');storage[key]=value;}};
  globalThis.CustomEvent=class {constructor(type,options){this.type=type;this.detail=options.detail;}};
  try { initializeTheme(); run({attributes,callbacks,label,meta,events,storage,button}); }
  finally { for(const [key,value] of Object.entries(saved)) value===undefined?delete globalThis[key]:globalThis[key]=value; }
}

test('el selector alterna, anuncia y guarda el tema',()=>withThemeEnvironment('dark',false,e=>{
  assert.equal(e.label.textContent,'Oscuro');assert.equal(e.attributes['aria-pressed'],'true');
  e.callbacks.click();assert.equal(document.documentElement.dataset.theme,'light');assert.equal(e.label.textContent,'Claro');
  assert.equal(e.attributes['aria-pressed'],'false');assert.equal(e.storage['vialab-theme'],'light');
  assert.equal(e.meta.content,'#f5f6f1');assert.equal(e.events[0].type,'vialab:themechange');assert.equal(e.events[0].detail.theme,'light');
  e.callbacks.click();assert.equal(document.documentElement.dataset.theme,'dark');assert.equal(e.storage['vialab-theme'],'dark');
}));

test('el selector sigue funcionando si el navegador bloquea localStorage',()=>withThemeEnvironment('light',true,e=>{
  e.callbacks.click();assert.equal(document.documentElement.dataset.theme,'dark');assert.equal(e.label.textContent,'Oscuro');assert.equal(e.events.length,1);
}));
