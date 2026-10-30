import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildGraph, shortestPath } from '../src/graph.js';
import { makeRoute } from '../src/geo.js';

const data = JSON.parse(await readFile(new URL('../data/sevilla-osm.json', import.meta.url), 'utf8'));

test('el extracto de Sevilla incluye ferrocarril, metro y tranvía con nodos completos', () => {
  const graph = buildGraph(data);
  assert.equal(graph.missingReferences,0);
  assert.ok(graph.wayCount > 600);
  assert.ok(graph.nodes.size > 5000);
  assert.ok(graph.edges.size > 5000);
  const types = new Set(graph.lineRecords.map(line => line.tags.railway));
  for (const type of ['rail','subway','tram']) assert.ok(types.has(type),`falta ${type}`);
  assert.deepEqual(data.bbox,{west:-6.28,south:37.14,east:-5.68,north:37.60});
  const names = data.stations.map(s=>s.tags.name);
  for (const name of ['Sevilla - Santa Justa','Benacazón','Utrera','Ciudad Expo','Olivar de Quintos','Plaza Nueva']) assert.ok(names.includes(name), `falta ${name}`);
});

test('la ruta ficticia de Santa Justa está contenida en la red incluida', () => {
  const graph = buildGraph(data);
  const path = shortestPath(graph,'243997059','6334298788');
  assert.ok(path?.length > 2);
  const route = makeRoute(graph,path);
  assert.ok(route.length > 900 && route.length < 1100, `longitud: ${route.length}`);
});

test('también importa metro y tranvía, sin aceptar vías en construcción', () => {
  const data = {elements:[
    {type:'node',id:1,lat:37,lon:-6},{type:'node',id:2,lat:37.01,lon:-6},
    {type:'node',id:3,lat:37.02,lon:-6},{type:'node',id:4,lat:37.03,lon:-6},
    {type:'way',id:10,nodes:[1,2],tags:{railway:'subway'}},
    {type:'way',id:11,nodes:[2,3],tags:{railway:'tram'}},
    {type:'way',id:12,nodes:[3,4],tags:{railway:'construction'}},
  ]};
  const graph = buildGraph(data);
  assert.equal(graph.wayCount,2);
  assert.equal(graph.edges.size,2);
  assert.equal(shortestPath(graph,'1','4'),null);
});
