import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildGraph, shortestPath } from '../src/graph.js';
import { makeRoute, pointAt } from '../src/geo.js';

const sample = JSON.parse(await readFile(new URL('../data/granada-osm.json', import.meta.url)));

test('el extracto real conserva sus nodos y permite calcular la ruta de ejemplo', () => {
  const graph = buildGraph(sample);
  assert.equal(graph.missingReferences, 0);
  assert.ok(graph.edges.size > 100);
  const nodes = shortestPath(graph, '288614015', '1350499080');
  assert.ok(nodes?.length > 2);
  const route = makeRoute(graph, nodes);
  assert.ok(route.length > 1100 && route.length < 1300, `longitud ${route.length}`);
  assert.deepEqual(pointAt(route, 0), [graph.nodes.get(nodes[0]).lat, graph.nodes.get(nodes[0]).lon]);
});

test('líneas que se cruzan sin nodo OSM común permanecen desconectadas', () => {
  const input = { elements: [
    ...[[1,0,0],[2,1,1],[3,0,1],[4,1,0]].map(([id,lat,lon]) => ({ type:'node', id, lat, lon })),
    { type:'way', id:11, nodes:[1,2], tags:{ railway:'rail' } },
    { type:'way', id:12, nodes:[3,4], tags:{ railway:'rail' } }
  ]};
  const graph = buildGraph(input);
  assert.equal(shortestPath(graph, '1', '4'), null);
});

test('rechaza datos sin geometría ferroviaria utilizable', () => {
  assert.throws(() => buildGraph({elements: []}), /railway=rail/);
  assert.throws(() => buildGraph({}), /Formato/);
});

test('Dijkstra elige el camino de menor distancia entre alternativas', () => {
  const input = { elements: [
    ...[[1,0,0],[2,0,0.005],[3,0,0.01],[4,0.02,0.005]].map(([id,lat,lon]) => ({type:'node',id,lat,lon})),
    {type:'way',id:10,nodes:[1,2,3],tags:{railway:'rail'}},
    {type:'way',id:11,nodes:[1,4,3],tags:{railway:'rail'}}
  ]};
  assert.deepEqual(shortestPath(buildGraph(input),'1','3'),['1','2','3']);
});

test('nodos ausentes cortan una vía, nunca crean una conexión artificial', () => {
  const input = { elements: [
    ...[[1,0,0],[3,0,0.01],[4,0,0.02]].map(([id,lat,lon]) => ({type:'node',id,lat,lon})),
    {type:'way',id:10,nodes:[1,2,3,4],tags:{railway:'rail'}}
  ]};
  const graph = buildGraph(input);
  assert.equal(graph.missingReferences,1);
  assert.equal(shortestPath(graph,'1','4'),null);
  assert.deepEqual(shortestPath(graph,'3','4'),['3','4']);
});
