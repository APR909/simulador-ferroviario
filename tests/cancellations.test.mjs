import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validCancellationPayload,cancellationFreshness,cancellationRecordRecent,cancellationPopup} from '../src/cancellations.js';
const now=1793394000;
const record={id:'x:2026-10-31',trip_id:'x',service_name:'AVE',origin:'Madrid',destination:'Sevilla',
  location:{latitude:40.4,longitude:-3.7},planned_departure:now+3600,individual_timestamp:null};
const payload={kind:'renfe-av-cancellations',status:'partial',generated_at:now,header_timestamp:now,
  records:[record],count:1,ambiguous_trips:2,unmatched_trips:0};

test('valida viaje, ubicación opcional, conteo y errores; no confunde error con cero',()=>{
  assert.ok(validCancellationPayload(payload));
  assert.ok(validCancellationPayload({...payload,records:[{...record,location:null}],count:1}));
  assert.ok(validCancellationPayload({...payload,status:'error',records:[],count:null}));
  assert.equal(validCancellationPayload({...payload,status:'error',records:[],count:0}),false);
  assert.equal(validCancellationPayload({...payload,records:[record,record],count:2}),false);
  assert.equal(validCancellationPayload({...payload,records:[{...record,location:{latitude:100,longitude:0}}]}),false);
  assert.equal(validCancellationPayload({...payload,records:[{...record,service_name:'MD'}]}),false);
  assert.equal(validCancellationPayload({...payload,count:0}),false);
});

test('envejece la cabecera, aunque la fecha de consulta sea reciente',()=>{
  assert.equal(cancellationFreshness(payload,now+90),'partial');
  assert.equal(cancellationFreshness(payload,now+91),'stale');
  assert.equal(cancellationFreshness(payload,now-30),'partial');
  assert.equal(cancellationFreshness(payload,now-31),'stale');
  assert.equal(cancellationFreshness({...payload,status:'error'},now),'error');
  assert.equal(cancellationFreshness({...payload,status:'stale'},now),'stale');
  assert.equal(cancellationRecordRecent({...record,individual_timestamp:now},now+90),true);
  assert.equal(cancellationRecordRecent({...record,individual_timestamp:now},now+91),false);
  assert.equal(cancellationRecordRecent({...record,individual_timestamp:now+31},now),false);
  assert.equal(cancellationRecordRecent(record,now),true); // null is displayed as unknown, never as current
});

test('el popup no interpreta el texto del operador y no ubica la avería',()=>{
  const saved=globalThis.document,all=[];
  const make=tag=>{const el={tag,textContent:'',className:'',children:[],append(...args){this.children.push(...args);}};all.push(el);return el;};
  globalThis.document={createElement:make,createTextNode:value=>({textContent:value})};
  try {
    const pop=cancellationPopup({...record,origin:'<script>alert(1)</script>'},payload);
    const flat=JSON.stringify(pop);
    assert.match(flat,/<script>alert\(1\)<\/script>/);
    assert.match(flat,/estación de salida/);assert.match(flat,/no al punto de una avería/i);
    assert.match(flat,/Fecha individual del aviso/);assert.match(flat,/fecha no indicada/i);
    assert.ok(all.every(el=>!('innerHTML' in el)));
  } finally {saved===undefined?delete globalThis.document:globalThis.document=saved;}
});

test('el HTML autónomo avisa que las cancelaciones necesitan servidor y no incluye un feed simulado',async()=>{
  const html=await readFile(new URL('../simulador.html',import.meta.url),'utf8');
  assert.match(html,/id="cancelToggle"/);assert.match(html,/id="cancelCount"/);
  assert.match(html,/estación de salida prevista/);assert.match(html,/Las cancelaciones requieren servidor.py; GitHub Pages no ejecuta ese servidor/);
  assert.doesNotMatch(html,/RAIL_CANCELLATION_SAMPLE/);
});
