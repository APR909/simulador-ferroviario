import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ltvFreshness,ltvDisplayTime,validLtvSnapshot,ltvPopup} from '../src/limitations.js';
const root=new URL('../',import.meta.url);
const bundled=JSON.parse(await readFile(new URL('data/limitaciones-adif.json',root),'utf8'));

test('la instantánea incluida identifica a Adif, conserva fechas y separa ubicación de ausencia',()=>{
  assert.equal(bundled.kind,'adif-ltv');
  assert.equal(bundled.attribution,'© Administrador de infraestructuras ferroviarias');
  assert.match(bundled.source_url,/arcgis\.com/);
  assert.ok(validLtvSnapshot(bundled));
  assert.ok(bundled.records.length>50);
  assert.ok(bundled.records.some(x=>x.line_code==='010' && x.pk_start===54));
  assert.ok(bundled.source_edited_at < bundled.fetched_at-86400);
  assert.equal(ltvFreshness(bundled,bundled.generated_at),'stale');
  assert.ok(bundled.records.every(x=>Number.isFinite(x.location.latitude)&&Number.isFinite(x.location.longitude)));
  assert.ok(bundled.unlocated.every(x=>x.location===null));
});

test('la consulta reciente no rejuvenece la fuente, y falta o futuro implica desconocido',()=>{
  const now=1793394000;
  const data={source_edited_at:now-30,file_effective_at:now-21601,stale_seconds:21600};
  assert.equal(ltvFreshness(data,now),'stale');
  data.file_effective_at=now-5;
  assert.equal(ltvFreshness(data,now),'recent');
  assert.equal(ltvFreshness(data,now+21601),'stale');
  data.source_edited_at=null;
  assert.equal(ltvFreshness(data,now),'unknown');
  data.source_edited_at=now+61;
  assert.equal(ltvFreshness(data,now),'unknown');
  assert.equal(ltvDisplayTime(null),'fecha desconocida');
});

test('error, datos truncados, coordenadas inválidas e IDs duplicados no son un cero fiable',()=>{
  assert.equal(validLtvSnapshot({kind:'adif-ltv',status:'error',records:[],unlocated:[],count:null}),false);
  assert.equal(validLtvSnapshot({...bundled,count:0}),false);
  const record=bundled.records[0];
  assert.equal(validLtvSnapshot({...bundled,records:[{...record,location:{latitude:999,longitude:0}}],count:1}),false);
  assert.equal(validLtvSnapshot({...bundled,records:[record,record],count:2}),false);
  assert.equal(validLtvSnapshot({...bundled,records:[],unlocated:[{...record}],count:0}),false);
  // A genuinely empty, structurally valid result is still not a claim of no incidents.
  assert.equal(validLtvSnapshot({...bundled,records:[],unlocated:[],count:0}),true);
});

test('el popup usa texto seguro y explica que no es avería ni señal física',()=>{
  const saved=globalThis.document;
  const all=[];
  function make(tag){const el={tag,textContent:'',className:'',children:[],append(...args){this.children.push(...args);}};all.push(el);return el;}
  globalThis.document={createElement:make,createTextNode:value=>({textContent:value})};
  try {
    const record={...bundled.records[0],line_name:'<img src=x onerror=alert(1)>'};
    const pop=ltvPopup(record,bundled,'bundled','stale');
    const flattened=JSON.stringify(pop);
    assert.match(flattened,/<img src=x onerror=alert\(1\)>/); // textContent, never parsed HTML
    assert.match(flattened,/no una señal física/i);
    assert.match(flattened,/no es por sí sola una avería o un corte/i);
    assert.match(flattened,/No confirma el estado actual/i);
    assert.ok(all.every(element=>!('innerHTML' in element)));
  } finally {saved===undefined?delete globalThis.document:globalThis.document=saved;}
});

test('el HTML autónomo contiene la instantánea y distingue el estado de la fuente',async()=>{
  const html=await readFile(new URL('simulador.html',root),'utf8');
  assert.match(html,/window\.RAIL_LTV_SAMPLE/);
  assert.match(html,/id="ltvToggle"/);
  assert.match(html,/id="ltvMapStatus"/);
  assert.match(html,/La vigencia no está confirmada/);
  assert.match(html,/Consultar cortes y avisos actuales en Adif/);
  assert.match(html,/Administrador de infraestructuras ferroviarias/);
});
