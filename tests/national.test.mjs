import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isRecognizedExpress, selectNationalVehicles } from '../src/national.js';
import { summarizeLive } from '../src/realtime.js';

const data = JSON.parse(await readFile(new URL('../data/espana-osm.json',import.meta.url),'utf8'));
const group = name => data.features.filter(feature=>feature[1]===name);
const nearby = (lat,lon,dy,dx,predicate=()=>true) => data.features.some(feature=>predicate(feature) && feature[6].some(point=>Math.abs(point[0]-lat)<dy && Math.abs(point[1]-lon)<dx));

test('extracto nacional OSM incluye vías de todos los grupos y su atribución', () => {
  assert.equal(data.source_date,'2026-10-29');
  assert.match(data.license,/ODbL/);
  assert.match(data.attribution,/OpenStreetMap/);
  assert.equal(data.features.length,Object.values(data.counts).reduce((a,b)=>a+b,0));
  assert.ok(data.features.length>30000);
  assert.ok(group('highspeed').length>2000);
  assert.ok(group('rail').length>10000);
  assert.ok(group('narrow').length>500);
  assert.ok(group('urban').length>1000);
  assert.ok(group('service').length>1000);
  assert.ok(data.features.every(feature=>feature.length===8 && feature[6].length>=2 && typeof feature[7]==='object'));
  assert.equal(data.missing_node_references,0);
  assert.ok(data.stations.length>1000);
  assert.equal(data.source_urls.length,2, 'España y Canarias son extractos distintos');
});

test('hay geometría real cerca de ciudades peninsulares, Baleares y Canarias', () => {
  assert.ok(nearby(40.41,-3.70,.12,.12),'Madrid');
  assert.ok(nearby(41.39,2.17,.12,.12),'Barcelona');
  assert.ok(nearby(37.39,-5.98,.12,.12),'Sevilla');
  assert.ok(nearby(42.88,-8.54,.12,.12),'Santiago');
  assert.ok(nearby(39.57,2.65,.12,.12),'Mallorca');
  assert.ok(nearby(28.47,-16.25,.12,.12,f=>f[1]==='urban'),'tranvía de Tenerife');
  assert.ok(nearby(40.4,-3.7,.25,.25,f=>f[1]==='highspeed'),'alta velocidad Madrid');
  assert.ok(nearby(41.39,2.17,.2,.2,f=>f[1]==='highspeed'),'alta velocidad Barcelona');
});

test('la capa de alta velocidad utiliza vías OSM concretas conocidas, no líneas inventadas', () => {
  const madridBarcelona=data.features.filter(f=>f[0]===28883560);
  assert.ok(madridBarcelona.length>0);
  assert.equal(madridBarcelona[0][1],'highspeed');
  assert.match(madridBarcelona[0][2],/alta velocidad/i);
});

test('el filtro AV incluye etiquetas reconocidas sin deducir la marca o el modelo', () => {
  assert.equal(isRecognizedExpress('AVE'),true);
  assert.equal(isRecognizedExpress('Avlo'),true);
  assert.equal(isRecognizedExpress('AVANT EXP'),true);
  assert.equal(isRecognizedExpress('Alta Velocidad'),true);
  assert.equal(isRecognizedExpress('ALVIA'),false);
  assert.equal(isRecognizedExpress(null),false);
  const summary={vehicles:[
    {id:'a',source:'larga_distancia',service_name:'AVE'},
    {id:'b',source:'larga_distancia',service_name:'MD'},
    {id:'c',source:'larga_distancia',service_name:null},
    {id:'d',source:'cercanias'},
  ]};
  assert.deepEqual(selectNationalVehicles(summary,{longDistance:true,commuter:true,expressOnly:false}).map(v=>v.id),['a','b','c','d']);
  assert.deepEqual(selectNationalVehicles(summary,{longDistance:true,commuter:true,expressOnly:true}).map(v=>v.id),['a']);
  assert.deepEqual(selectNationalVehicles(summary,{longDistance:false,commuter:true,expressOnly:false}).map(v=>v.id),['d']);
});

test('los vehículos AV/LD caducados nunca se ofrecen como observaciones recientes', () => {
  const now=1793316000;
  const payload={generated_at:now,fresh_seconds:90,feeds:{
    cercanias:{status:'fresh',header_timestamp:now,vehicles:[]},
    larga_distancia:{status:'stale',header_timestamp:now-3600,vehicles:[{id:'a',latitude:40.4,longitude:-3.7,observed_at:now-3600,service_name:'AVE'}]},
  }};
  const summary=summarizeLive(payload,now);
  assert.equal(summary.larga.count,null);
  assert.deepEqual(selectNationalVehicles(summary,{longDistance:true,commuter:true,expressOnly:false}),[]);
});

test('el HTML autocontenido incorpora España y conserva la simulación de Sevilla', async () => {
  const html=await readFile(new URL('../simulador.html',import.meta.url),'utf8');
  assert.match(html,/window\.RAIL_SPAIN_SAMPLE/);
  assert.match(html,/window\.RAIL_SAMPLE/);
  assert.match(html,/id="nationalView"/);
  assert.match(html,/id="sevillaView"/);
  const commuterInput = html.match(/<input[^>]+id="nationalCommuter"[^>]*>/)?.[0];
  assert.ok(commuterInput);
  assert.doesNotMatch(commuterInput,/\bchecked\b/, 'Cercanías no debe saturar el mapa por defecto');
  assert.doesNotMatch(html,/src="src\/app\.js/);
  assert.doesNotMatch(html,/href="styles\.css/, 'el CSS debe estar integrado para file://');
});
