import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {infrastructureCategory, infrastructureTrackFields, initializeInfrastructure} from '../src/infrastructure.js';
const root=new URL('../',import.meta.url);
const network=JSON.parse(await readFile(new URL('data/espana-osm.json',root),'utf8'));
const infra=JSON.parse(await readFile(new URL('data/infraestructura-osm.json',root),'utf8'));

test('los elementos ferroviarios son nodos OSM con tipos y fecha documentados',()=>{
  assert.equal(infra.source_date,network.source_date);
  assert.match(infra.license,/ODbL/);
  assert.ok(infra.counts.signal>500);
  assert.ok(infra.counts.switch>10000);
  assert.ok(infra.counts.level_crossing>3000);
  assert.equal(infra.features.length,Object.values(infra.counts).reduce((a,b)=>a+b,0));
  assert.ok(infra.features.every(f=>f.length===5&&Number.isFinite(f[1])&&Number.isFinite(f[2])&&f[4].railway===f[3]));
});

test('no se inventan señales en Sevilla cuando no figuran en este extracto',()=>{
  const inSevilla=f=>f[1]>=37.14&&f[1]<=37.60&&f[2]>=-6.28&&f[2]<=-5.68;
  assert.equal(infra.features.filter(f=>inSevilla(f)&&f[3]==='signal').length,0);
  assert.ok(infra.features.filter(f=>inSevilla(f)&&f[3]==='switch').length>200);
  assert.ok(infra.features.filter(f=>inSevilla(f)&&f[3]==='level_crossing').length>50);
});

test('una vía AV concreta contiene atributos originales, no velocidades inferidas',()=>{
  const feature=network.features.find(f=>f[0]===28883560);
  assert.equal(feature[7].gauge,'1435');
  assert.equal(feature[7].voltage,'25000');
  assert.equal(feature[7].electrified,'contact_line');
  assert.equal(feature[7]['railway:etcs'],'2');
  const fields=infrastructureTrackFields({railway:'rail',gauge:'1668',electrified:'no'});
  assert.ok(fields.some(f=>f.label==='Ancho (mm)'&&f.value==='1668'));
  assert.ok(!fields.some(f=>f.key==='voltage'||f.key==='railway:etcs'));
});

test('los aspectos posibles de una señal son etiquetas OSM, no su estado actual',()=>{
  const signal=infra.features.find(f=>f[0]===306174330);
  assert.equal(signal[3],'signal');
  assert.equal(signal[4]['railway:signal:main:states'],'ES-RCF:FF1A;ES-RCF:FF3A;ES-RCF:FF5A;ES-RCF:FF8A');
  assert.ok(!('current_state' in signal[4]));
});

test('cruces, señales y agujas permanecen categorías distintas',()=>{
  assert.equal(infrastructureCategory('signal'),'signal');
  assert.equal(infrastructureCategory('switch'),'switch');
  assert.equal(infrastructureCategory('crossing'),'crossing');
  assert.equal(infrastructureCategory('level_crossing'),'crossing');
  assert.equal(infrastructureCategory('milestone'),'milestone');
  assert.equal(infrastructureCategory('construction'),null);
});

test('el HTML autónomo incorpora infraestructura, tema y advertencia de estado',async()=>{
  const html=await readFile(new URL('simulador.html',root),'utf8');
  assert.match(html,/window\.RAIL_INFRASTRUCTURE/);
  assert.match(html,/id="themeToggle"/);
  assert.match(html,/id="nationalInfra-signal"/);
  assert.match(html,/id="nationalInfraExample"/);
  assert.match(html,/id="localInfra-signal"/);
  assert.match(html,/el estado o aspecto actual de la señal no está disponible/i);
  assert.doesNotMatch(html,/href="styles\.css/);
});

test('el ejemplo abre una señal OSM real y reactiva su filtro',async()=>{
  const signal=infra.features.find(f=>f[0]===306174330);
  const saved={document:globalThis.document,window:globalThis.window,L:globalThis.L};
  const controls={
    nationalInfraStatus:{textContent:''},nationalInfraExample:{disabled:true,addEventListener(type,handler){this[type]=handler;}},
    'nationalInfra-signal':{checked:false,addEventListener(){}},'nationalInfra-switch':{checked:false,addEventListener(){}},
    'nationalInfra-crossing':{checked:false,addEventListener(){}},'nationalInfra-milestone':{checked:false,addEventListener(){}},
  };
  const element=()=>({className:'',textContent:'',append(){},setAttribute(){}});
  globalThis.document={getElementById:id=>controls[id] || null,createElement:element,createTextNode:text=>({textContent:text})};
  globalThis.window={RAIL_INFRASTRUCTURE:{features:[signal],counts:{signal:1}}};
  let popupPoint=null, zoom=6,center=null;
  const pane={style:{}},layer={addTo(){return this},clearLayers(){}};
  const map={createPane(){},getPane(){return pane},getZoom(){return zoom},on(){},
    getBounds(){return {contains(){return true}}},setView(point,z){center=point;zoom=z;}};
  globalThis.L={layerGroup:()=>layer,canvas:()=>({}),circleMarker:()=>({addTo(){}}),
    popup:()=>({setLatLng(point){popupPoint=point;return this},setContent(){return this},openOn(){return this}})};
  try {
    await initializeInfrastructure(map,'national');
    assert.match(controls.nationalInfraStatus.textContent,/zoom 12/);
    assert.equal(controls.nationalInfraExample.disabled,false);
    controls.nationalInfraExample.click();
    assert.equal(controls['nationalInfra-signal'].checked,true);
    assert.equal(zoom,16);assert.deepEqual(center,[signal[1],signal[2]]);assert.deepEqual(popupPoint,center);
    assert.match(controls.nationalInfraStatus.textContent,/1 señales/);
  } finally {for(const [key,value] of Object.entries(saved)) value===undefined?delete globalThis[key]:globalThis[key]=value;}
});
