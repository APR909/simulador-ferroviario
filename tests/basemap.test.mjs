import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

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

test('el HTML autónomo incluye el motor vectorial y el worker para file://', async () => {
  const html = await read('../simulador.html');
  assert.match(html, /window\.RAIL_BASEMAP_URLS/);
  assert.match(html, /#worker\.cjs/);
  assert.match(html, /https:\/\/tiles\.openfreemap\.org\/styles\/positron/);
  assert.doesNotMatch(html, /https:\/\/tile\.openstreetmap\.org\/\{z\}/);
  assert.doesNotMatch(html, /src="src\/app\.js/);
});
