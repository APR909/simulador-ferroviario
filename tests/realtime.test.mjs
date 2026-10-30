import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLiveFeed, summarizeLive } from '../src/realtime.js';

// Synthetic test data only: never shown as real vehicle positions in the app.
const now = 1793316000;
const v = (id, observed_at = now, time_basis = 'vehicle') => ({id, latitude:37.39, longitude:-5.98, observed_at, time_basis});
const fresh = vehicles => ({ status:'fresh', header_timestamp:now, vehicles, excluded_stale:0 });
const payload = (cercanias, larga_distancia) => ({ generated_at:now, fresh_seconds:90, feeds:{cercanias, larga_distancia} });

test('un feed vacío y reciente es cero; un fallo no es cero', () => {
  const s = summarizeLive(payload(fresh([]), {status:'error'}));
  assert.equal(s.total, 0);
  assert.equal(s.cercanias.count, 0);
  assert.equal(s.larga.count, null);
  assert.equal(s.usable, 1);
});

test('si ninguna fuente es usable no inventa un total ni marcadores', () => {
  const s = summarizeLive(payload({status:'error'}, {status:'stale', header_timestamp:now-3600}));
  assert.equal(s.total, null); assert.equal(s.usable, 0); assert.equal(s.vehicles.length, 0);
});

test('la suma es de posiciones observadas Renfe y mantiene categorías', () => {
  const s = summarizeLive(payload(fresh([v('A'),v('B')]), fresh([v('C')])));
  assert.equal(s.total,3); assert.equal(s.usable,2);
  assert.deepEqual(s.vehicles.map(x => x.source), ['cercanias','cercanias','larga_distancia']);
});

test('envejece automáticamente y elimina posiciones cuando supera el umbral', () => {
  const p = payload(fresh([v('A')]), fresh([]));
  assert.equal(summarizeLive(p, now+90).total,1);
  const s = summarizeLive(p, now+91);
  assert.equal(s.total,null); assert.equal(s.vehicles.length,0);
  assert.equal(s.cercanias.status,'stale');
});

test('excluye una posición antigua aunque el feed sea reciente', () => {
  const s = summarizeLive(payload(fresh([v('old', now-91), v('fresh')]), {status:'error'}));
  assert.equal(s.total,1); assert.equal(s.cercanias.status,'partial');
  assert.equal(s.cercanias.excluded_stale,1);
  assert.deepEqual(s.vehicles.map(x => x.id),['fresh']);
});

test('conserva la advertencia de hora del feed si falta la individual', () => {
  const x = evaluateLiveFeed(fresh([v('A', now, 'feed')]),now);
  assert.equal(x.feed_time_fallback,1); assert.equal(x.count,1);
});

test('rechaza un feed aparentemente reciente sin lista de vehículos ni cabecera', () => {
  assert.equal(evaluateLiveFeed({status:'fresh',header_timestamp:now},now).status,'error');
  assert.equal(evaluateLiveFeed({status:'fresh',vehicles:[]},now).status,'stale');
});
