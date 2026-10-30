import { buildGraph, shortestPath } from './graph.js';
import { makeRoute } from './geo.js';

/** Fictional services over OSM geometry; names/times are not real timetables. */
export const DEMO_LINE_SPECS = [
  { id:'L1', name:'Norte · Virgen del Rocío', shortName:'Norte', mode:'rail', color:'#287c68', dash:'',
    anchors:['2665795523','6334298080','2523748255'], stopName:'Santa Justa', dwell:28,
    trains:[{id:'101', speedKmh:74, depart:0}, {id:'102', speedKmh:60, depart:90}] },
  { id:'L2', name:'Santa Justa · Bellavista', shortName:'Sur', mode:'rail', color:'#276caf', dash:'',
    anchors:['6334298080','243997039','2407988003'], stopName:'San Bernardo', dwell:24,
    trains:[{id:'201', speedKmh:82, depart:0}, {id:'202', speedKmh:64, depart:100}] },
  { id:'L3', name:'Santa Justa · Palmete', shortName:'Este', mode:'rail', color:'#cf7a27', dash:'10 7',
    anchors:['6334298080','243997039','500895832'], stopName:'San Bernardo', dwell:32,
    trains:[{id:'301', speedKmh:67, depart:25}, {id:'302', speedKmh:76, depart:125}] },
  { id:'M1', name:'Ciudad Expo · Olivar', shortName:'Metro', mode:'subway', color:'#9256b6', dash:'',
    anchors:['2667442596','4866735390','2667422418'], stopName:'San Bernardo', dwell:20,
    trains:[{id:'401', speedKmh:52, depart:0}, {id:'402', speedKmh:40, depart:70}] },
  { id:'T1', name:'Plaza Nueva · Eduardo Dato', shortName:'Tranvía', mode:'tram', color:'#cf5360', dash:'',
    anchors:['244054578','1254108418','12086889982'], stopName:'San Bernardo', dwell:18,
    trains:[{id:'501', speedKmh:25, depart:0}, {id:'502', speedKmh:19, depart:50}] },
];

function scenarioPathForAnchors(graph, anchors) {
  const all = [];
  for (let i = 1; i < anchors.length; i++) {
    const path = shortestPath(graph, anchors[i - 1], anchors[i]);
    if (!path) throw new Error(`No se encontró conexión OSM entre ${anchors[i - 1]} y ${anchors[i]}.`);
    all.push(...(i === 1 ? path : path.slice(1)));
  }
  if (new Set(all).size !== all.length) throw new Error('El recorrido vuelve a pasar por el mismo nodo OSM.');
  return all;
}

/** Build several same-direction sample routes on the included OSM graph. */
export function buildDemoScenario(data, graph) {
  const modeGraphs = {};
  for (const mode of ['rail', 'subway', 'tram']) {
    modeGraphs[mode] = buildGraph({ nodes:data.nodes, ways:data.ways.filter(way => way.tags?.railway === mode) });
  }
  const lines = DEMO_LINE_SPECS.map(spec => {
    const path = scenarioPathForAnchors(modeGraphs[spec.mode], spec.anchors);
    const route = makeRoute(graph, path);
    const stopPoint = route.points.find(point => point.id === spec.anchors[1]);
    if (!stopPoint) throw new Error(`No se encontró la parada intermedia de ${spec.id}.`);
    return {
      id: spec.id, name: spec.name, shortName: spec.shortName, mode: spec.mode,
      color: spec.color, dash: spec.dash, route,
      stops:[{ name:spec.stopName, distance:stopPoint.distance, dwellSeconds:spec.dwell }],
    };
  });
  const trains = DEMO_LINE_SPECS.flatMap(spec => spec.trains.map(train => ({
    id: train.id, lineId: spec.id, speedKmh: train.speedKmh, departureSeconds: train.depart,
    length: 65, acceleration: spec.mode === 'tram' ? .55 : .65, braking: .85,
    turnaroundSeconds: 60,
  })));
  return { lines, trains };
}

const CUSTOM_COLORS = ['#127f83','#c45c8a','#7567bc','#7c8a2c','#c76838'];
/** A custom line may be appended; dispatch restarts so shared locks are rebuilt. */
export function makeCustomScenarioLine(graph, nodeIds, number, trainIds) {
  const route = makeRoute(graph, nodeIds);
  if (route.length < 600 || route.length > 100000) throw new Error('La ruta debe medir entre 600 m y 100 km.');
  if (new Set(route.nodeIds).size !== route.nodeIds.length) throw new Error('La ruta no puede repetir nodos.');
  const color = CUSTOM_COLORS[(number - 1) % CUSTOM_COLORS.length];
  const id = `U${number}`;
  return {
    line: { id, name:`Ruta personalizada ${number}`, shortName:`Personalizada ${number}`, mode:'custom', color, dash:'8 6', route, stops:[] },
    trains: trainIds.map((trainId, index) => ({ id:String(trainId), lineId:id, speedKmh:index ? 55 : 70,
      departureSeconds:index * 75, length:65, acceleration:.65, braking:.85, turnaroundSeconds:60 })),
  };
}
