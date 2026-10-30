import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildGraph } from '../src/graph.js';
import { makeRoute } from '../src/geo.js';
import { buildDemoScenario } from '../src/scenario.js';
import { MultiSimulation } from '../src/multiline.js';

const sample = JSON.parse(await readFile(new URL('../data/sevilla-osm.json',import.meta.url),'utf8'));
const graph = buildGraph(sample);
const demo = () => buildDemoScenario(sample,graph);
const config = (id,lineId,departureSeconds=0,speedKmh=55) => ({ id,lineId,departureSeconds,speedKmh });

function verify(sim) {
  for (const resource of sim.resources.values()) {
    if (resource.occupiedBy) assert.equal(resource.owner,resource.occupiedBy,`sin reserva ${resource.key}`);
  }
  for (const train of sim.trains) {
    assert.ok(train.speed >= 0);
    if (train.phase === 'active') assert.ok(train.head <= train.stopLimit + .0001,`${train.id} rebasa autorización`);
  }
}

test('escenario Sevilla: cinco líneas, diez trenes y recursos OSM compartidos', () => {
  const {lines,trains}=demo(), sim=new MultiSimulation(graph,lines,trains);
  assert.equal(lines.length,5); assert.equal(trains.length,10);
  assert.deepEqual(new Set(lines.map(line=>line.mode)),new Set(['rail','subway','tram']));
  assert.ok(sim.sharedResources.length > 10);
  assert.ok(sim.sharedResources.some(resource=>resource.lineIds.has('L2') && resource.lineIds.has('L3')));
  assert.ok(new Set(trains.map(train=>train.speedKmh)).size > 5);
  assert.ok(new Set(trains.map(train=>train.departureSeconds)).size > 3);
  assert.equal(sim.trains.filter(train=>train.phase==='active').length,4);
  verify(sim);
});

test('dos horas simuladas: diez servicios progresan, hacen paradas y regresan sin colisiones', () => {
  const {lines,trains}=demo(), sim=new MultiSimulation(graph,lines,trains);
  let maxActive=0, observedSharedConflict=false, observedStation=false;
  for (let i=0; i<72000; i++) {
    sim.step(.1);
    if (i%10===0) {
      verify(sim);
      maxActive=Math.max(maxActive,sim.trains.filter(train=>train.phase==='active').length);
      observedSharedConflict ||= sim.trains.some(train=>train.blockedBy && sim.trainById.get(train.blockedBy)?.lineId!==train.lineId);
      observedStation ||= sim.trains.some(train=>train.dwellUntil!==null);
    }
  }
  assert.ok(maxActive>=8,'varios trenes simultáneos');
  assert.ok(observedSharedConflict,'las líneas distintas compiten por recursos comunes');
  assert.ok(observedStation,'hay tiempos de parada');
  assert.ok(sim.trains.every(train=>train.completedTrips>=3),'todos los trenes completan varias pasadas');
  assert.equal(sim.interventions,0);
});

test('planes variados y pasos discretos mantienen exclusión y progreso', () => {
  let seed=74;
  const random=()=>((seed=(seed*1664525+1013904223)>>>0)/4294967296);
  for (const dt of [.1,.5]) {
    const {lines,trains}=demo();
    const plan=trains.map(train=>({...train,speedKmh:Math.round(30+130*random()),departureSeconds:Math.floor(300*random())}));
    const sim=new MultiSimulation(graph,lines,plan);
    for (let i=0; i<Math.floor(3600/dt); i++) {
      if (i===Math.floor(180/dt)) sim.setIncident(plan[1].id,true);
      if (i===Math.floor(310/dt)) sim.setIncident(plan[1].id,false);
      if (i===Math.floor(450/dt)) sim.delayTrain(plan[5].id,90);
      sim.step(dt);
      if (i%100===0) verify(sim);
    }
    assert.equal(sim.interventions,0,`intervenciones con paso ${dt}`);
    assert.ok(sim.trains.every(train=>train.completedTrips>=1),`todos progresan con paso ${dt}`);
  }
});

test('una incidencia retiene los tramos ocupados y los demás progresan al resolverla', () => {
  const {lines,trains}=demo(), sim=new MultiSimulation(graph,lines,trains);
  sim.setIncident('201',true);
  for (let i=0; i<2400; i++) sim.step(.1);
  const blocked=sim.trainById.get('201');
  assert.equal(blocked.speed,0);
  assert.ok([...sim.resources.values()].some(resource=>resource.occupiedBy==='201' && resource.owner==='201'));
  assert.ok(sim.trains.some(train=>train.lineId==='L3' && train.phase!=='active' && train.blockedBy==='201'));
  const before=blocked.head;
  sim.setIncident('201',false);
  for (let i=0; i<2500; i++) sim.step(.1);
  assert.ok(blocked.head>before+100);
  assert.ok(sim.trainById.get('301').phase==='active' || sim.trainById.get('301').completedTrips>0);
  verify(sim); assert.equal(sim.interventions,0);
});

test('retardar salida y tren en marcha son controles temporales', () => {
  const {lines,trains}=demo(), sim=new MultiSimulation(graph,lines,trains);
  sim.delayTrain('102',60);
  assert.equal(sim.trainById.get('102').readyAt,150);
  for (let i=0; i<300; i++) sim.step(.1);
  sim.delayTrain('401',60);
  for (let i=0; i<1500; i++) sim.step(.1);
  const train=sim.trainById.get('401');
  assert.equal(train.holdRequested,0); assert.equal(train.holdUntil,null);
  assert.ok(train.head>150); assert.ok(train.speed>0);
  assert.equal(sim.interventions,0); verify(sim);
});

function crossingGraph() {
  const nodes={n:{lat:0,lon:-.015},j:{lat:0,lon:0},s:{lat:0,lon:.015},w:{lat:-.015,lon:0},e:{lat:.015,lon:0}};
  return buildGraph({nodes,ways:[{id:'h',nodes:['n','j','s'],tags:{railway:'rail'}}, {id:'v',nodes:['w','j','e'],tags:{railway:'rail'}}]});
}
function line(g,id,ids) { return {id,route:makeRoute(g,ids),stops:[]}; }

test('cruce de líneas sin vía común: el nodo OSM compartido es un recurso exclusivo', () => {
  const g=crossingGraph(), lines=[line(g,'H',['n','j','s']),line(g,'V',['w','j','e'])];
  const sim=new MultiSimulation(g,lines,[config('A','H'),config('B','V')]);
  assert.ok(sim.sharedResources.some(resource=>resource.key==='J:j'));
  let blocked=false;
  for (let i=0; i<10000; i++) {
    sim.step(.1); if (i%10===0) { verify(sim); blocked ||= sim.trains.some(train=>train.blockedBy); }
  }
  assert.ok(blocked); assert.ok(sim.trains.every(train=>train.completedTrips>=1));
  assert.equal(sim.interventions,0);
});

test('un nodo común de grado dos protege el final de una línea y el comienzo de otra', () => {
  const nodes={n:{lat:0,lon:-.015},j:{lat:0,lon:0},s:{lat:0,lon:.015}};
  const g=buildGraph({nodes,ways:[{id:'1',nodes:['n','j','s'],tags:{railway:'rail'}}]});
  assert.equal(g.adj.get('j').length,2);
  const sim=new MultiSimulation(g,[line(g,'A',['n','j']),line(g,'B',['j','s'])],[config('1','A'),config('2','B')]);
  assert.ok(sim.sharedResources.some(resource=>resource.key==='J:j'));
  sim.setIncident('2',true);
  for (let i=0; i<3000; i++) sim.step(.1);
  assert.equal(sim.resources.get('J:j').occupiedBy,'2');
  assert.equal(sim.trainById.get('1').blockedBy,'2');
  sim.setIncident('2',false);
  for (let i=0; i<5000; i++) sim.step(.1);
  assert.ok(sim.trains.every(train=>train.completedTrips>=1));
  assert.equal(sim.interventions,0); verify(sim);
});

test('rechaza vías compartidas en sentido opuesto', () => {
  const g=crossingGraph(), lines=[line(g,'H',['n','j','s']),line(g,'R',['s','j','n'])];
  assert.throws(()=>new MultiSimulation(g,lines,[config('A','H'),config('B','R')]),/sentidos opuestos/);
});

test('rechaza combinaciones con orden cíclico de cruces para prevenir espera circular', () => {
  const nodes={a:{lat:0,lon:0},b:{lat:0,lon:.03},x:{lat:.01,lon:.015},y:{lat:-.01,lon:.015},p:{lat:.01,lon:0},q:{lat:.01,lon:.03}};
  const g=buildGraph({nodes,ways:[{id:'1',nodes:['a','x','b'],tags:{railway:'rail'}},{id:'2',nodes:['b','y','a'],tags:{railway:'rail'}},
    {id:'3',nodes:['a','p'],tags:{railway:'rail'}},{id:'4',nodes:['b','q'],tags:{railway:'rail'}}]});
  const lines=[line(g,'X',['a','x','b']),line(g,'Y',['b','y','a'])];
  assert.throws(()=>new MultiSimulation(g,lines,[config('A','X'),config('B','Y')]),/orden incompatible/);
});

test('valida configuración y detecta la pérdida indebida de una reserva ocupada', () => {
  const {lines,trains}=demo();
  assert.throws(()=>new MultiSimulation(graph,lines,[{...trains[0],speedKmh:0}]),/Configuración/);
  const sim=new MultiSimulation(graph,lines,trains);
  const occupied=[...sim.resources.values()].find(resource=>resource.occupiedBy);
  occupied.owner=null;
  assert.throws(()=>sim.step(.1),/sin reserva/);
});
