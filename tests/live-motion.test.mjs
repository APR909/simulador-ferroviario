import test from 'node:test';
import assert from 'node:assert/strict';
import {liveMotionKey,makeMotionSegment,sampleMotion,motionDistanceMeters,createLiveMotionLayer} from '../src/live-motion.js';
const v=(overrides={})=>({id:'1',source:'larga_distancia',source_provider:'radar',trip_id:'trip',latitude:40,longitude:-4,observed_at:1000,time_basis:'vehicle',...overrides});

test('interpolación acotada entre dos observaciones reales, sin extrapolación',()=>{
  const a=v(),b=v({latitude:40.01,observed_at:1030});
  const segment=makeMotionSegment(a,b,a,5000);assert.ok(segment);assert.equal(segment.duration,30000);
  assert.equal(sampleMotion(segment,0).latitude,a.latitude);
  assert.ok(Math.abs(sampleMotion(segment,20000).latitude-40.005)<1e-9);
  assert.equal(sampleMotion(segment,90000).latitude,b.latitude);assert.equal(sampleMotion(segment,90000).estimated,false);
  assert.ok(motionDistanceMeters(a,b)>1100&&motionDistanceMeters(a,b)<1120);
});

test('no interpola sin hora GPS individual, con saltos, pausas largas o cambio de viaje',()=>{
  const a=v(),b=v({latitude:40.001,observed_at:1030});
  assert.equal(makeMotionSegment({...a,time_basis:'feed'},b,a,0),null);
  assert.equal(makeMotionSegment(a,{...b,time_basis:'feed'},a,0),null);
  assert.equal(makeMotionSegment(a,{...b,latitude:41},a,0),null);
  // Even if the last GPS pair is plausible, an interrupted animation may
  // still be too far behind to safely cover the visible segment in time.
  assert.equal(makeMotionSegment(a,b,{latitude:39,longitude:-4},0),null);
  assert.equal(makeMotionSegment(a,{...b,observed_at:1091},a,0),null);
  assert.equal(makeMotionSegment(a,{...b,observed_at:1000},a,0),null);
  assert.equal(makeMotionSegment(a,{...b,trip_id:'another'},a,0),null);
  assert.equal(makeMotionSegment(a,{...b,latitude:40,longitude:-4},a,0),null);
  assert.notEqual(liveMotionKey(a),liveMotionKey({...a,source_provider:'other'}));
});

test('los marcadores mantienen identidad, no reinician con el mismo dato y retiran conflictos y caducados',()=>{
  const original={performance:globalThis.performance,document:globalThis.document,raf:globalThis.requestAnimationFrame,caf:globalThis.cancelAnimationFrame};
  let time=0,nextId=1;const jobs=new Map();
  Object.defineProperty(globalThis,'performance',{value:{now:()=>time},configurable:true});
  globalThis.document={hidden:false};globalThis.requestAnimationFrame=cb=>{let id=nextId++;jobs.set(id,cb);return id;};globalThis.cancelAnimationFrame=id=>jobs.delete(id);
  const step=t=>{time=t;const run=[...jobs.values()];jobs.clear();for(const f of run)f(t);};
  const layer={items:new Set(),hasLayer(m){return this.items.has(m)},removeLayer(m){this.items.delete(m)},clearLayers(){this.items.clear()}};
  function marker(vehicle){return {lat:vehicle.latitude,lng:vehicle.longitude,element:{dataset:{},classList:{toggle(){}}},
    getElement(){return this.element},getLatLng(){return {lat:this.lat,lng:this.lng}},setLatLng([a,b]){this.lat=a;this.lng=b},addTo(l){l.items.add(this);return this}};}
  let on=true;
  try {
    const animation=createLiveMotionLayer({layer,createMarker:marker,updateMarker(){},isVisible:()=>true,isEnabled:()=>on});
    const a=v(),b=v({latitude:40.01,observed_at:1030});
    animation.update([a]);const m=[...layer.items][0];assert.equal(m.element.dataset.motion,'observada');
    animation.update([b]);assert.equal(m.element.dataset.motion,'interpolada');assert.equal(layer.items.size,1);
    step(15000);assert.ok(Math.abs(m.lat-40.005)<1e-9);
    globalThis.document.hidden=true;step(16000);assert.equal(jobs.size,0);
    globalThis.document.hidden=false;animation.resume();step(20000);
    assert.ok(m.lat>40.005 && m.lat<40.01, 'reanuda tras ocultar la pestaña');
    animation.update([b]);step(30000);assert.equal(m.lat,40.01);assert.equal(m.element.dataset.motion,'observada');
    assert.equal(animation.update([{...b,latitude:40.02}]).suppressed,1);assert.equal(layer.items.size,0);
    assert.equal(animation.update([b]).suppressed,1);assert.equal(layer.items.size,0);
    const c=v({latitude:40.011,observed_at:1040});animation.update([c]);assert.equal(layer.items.size,1);assert.equal(m.lat,c.latitude);
    const d=v({latitude:40.012,observed_at:1050});animation.update([d]);on=false;animation.setEnabled(false);assert.equal(m.lat,d.latitude);assert.equal(m.element.dataset.motion,'observada');
    animation.update([]);assert.equal(layer.items.size,0);
  } finally {
    Object.defineProperty(globalThis,'performance',{value:original.performance,configurable:true});
    for(const [key,value] of [['document',original.document],['requestAnimationFrame',original.raf],['cancelAnimationFrame',original.caf]]) value===undefined?delete globalThis[key]:globalThis[key]=value;
  }
});
