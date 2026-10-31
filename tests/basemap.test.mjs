import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import vm from 'node:vm';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('el fondo utiliza OpenFreeMap, no el servidor de teselas bloqueado', async () => {
  const source = await read('../src/app.js');
  assert.match(source, /https:\/\/tiles\.openfreemap\.org\/styles\/positron/);
  assert.doesNotMatch(source, /https:\/\/tile\.openstreetmap\.org\//);
  assert.match(source, /OpenMapTiles/);
  assert.match(source, /openstreetmap\.org\/copyright/);
});

test('la interfaz conserva un modo sin fondo y permite reintentar', async () => {
  const [source, html] = await Promise.all([read('../src/app.js'), read('../index.html')]);
  assert.match(source, /Fondo no disponible · vías visibles/);
  assert.match(source, /addEventListener\('click', \(\) => initializeBasemap\(\)\)/);
  const national = await read('../src/national.js');
  assert.match(national, /nationalBaseRetry/);
  assert.match(national, /setupBasemap\(map/);
  assert.match(html, /id="baseRetry"/);
  for (const path of ['../vendor/maplibre-gl.mjs', '../vendor/maplibre-gl-worker.mjs', '../vendor/leaflet-maplibre-gl.js']) {
    await access(new URL(path, import.meta.url));
  }
});

test('una transición pendiente no usa un fondo que ya fue retirado o sustituido', async () => {
  const callbacks=[];
  class Layer {}
  Layer.extend=methods=>{
    class Extension extends Layer { constructor(options){super();this.options={...methods.options};methods.initialize.call(this,options);} }
    Object.assign(Extension.prototype,methods);return Extension;
  };
  const L={Layer,setOptions:(target,options)=>Object.assign(target.options,options),
    Util:{throttle:(fn,_ms,ctx)=>fn.bind(ctx),requestAnimFrame:(fn,ctx)=>callbacks.push(fn.bind(ctx)),bind:(fn,ctx)=>fn.bind(ctx)},
    DomUtil:{setTransform:()=>{}}};
  const context={L,maplibregl:{},console};context.globalThis=context;
  vm.runInNewContext(await read('../vendor/leaflet-maplibre-gl.js'),context);
  const layer=new L.MaplibreGL({});
  const map={getZoom:()=>6,getCenter:()=>({lat:40,lng:-4}),getBounds:()=>({getNorthWest:()=>({})}),latLngToContainerPoint:()=>({})};
  let moved=0,onMove;
  const gl={_actualCanvas:{},once:(_name,callback)=>{onMove=callback;},jumpTo:()=>{moved++;}};
  layer._resizeContainer=()=>{};
  // A fallback can remove the layer after the animation frame is queued.
  layer._map=map;layer._glMap=gl;layer._transitionEnd();layer._map=null;layer._glMap=null;
  assert.doesNotThrow(()=>callbacks.shift()());assert.equal(moved,0);
  // A retry can replace the layer before the old frame runs.
  layer._map=map;layer._glMap=gl;layer._transitionEnd();layer._glMap={};
  assert.doesNotThrow(()=>callbacks.shift()());assert.equal(moved,0);
  // Removal can also happen after jumpTo but before the moveend callback.
  layer._map=map;layer._glMap=gl;layer._transitionEnd();callbacks.shift()();assert.equal(moved,1);
  layer._map=null;layer._glMap=null;assert.doesNotThrow(()=>onMove());
});

test('el HTML autónomo incluye el motor vectorial y el worker para file://', async () => {
  const html = await read('../simulador.html');
  assert.match(html, /window\.RAIL_BASEMAP_URLS/);
  assert.match(html, /#worker\.cjs/);
  assert.match(html, /https:\/\/tiles\.openfreemap\.org\/styles\/positron/);
  assert.doesNotMatch(html, /https:\/\/tile\.openstreetmap\.org\/\{z\}/);
  assert.doesNotMatch(html, /src="src\/app\.js/);
});
