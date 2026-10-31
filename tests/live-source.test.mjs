import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRadarBrowserTime,parseRadarBrowserFleet,radarBrowserSnapshot,createLiveSource,RADAR_BROWSER_URL} from '../src/live-source.js';
const NOW=1793401712,iso=n=>new Date(n*1000).toISOString();
const train=(id,overrides={})=>({id,trainCode:id,type:'long_distance',latitude:37.39,longitude:-5.98,timestamp:iso(NOW),
  productName:'Alta Velocidad',productCategory:'AV',...overrides});
const fleet=(trains,when=NOW)=>({trains,count:trains.length,updatedAt:iso(when)});
const response=(payload)=>({ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify(payload),json:async()=>payload});

test('la fecha de Radar requiere zona explícita, calendario válido y límites sensatos',()=>{
  assert.equal(parseRadarBrowserTime('2026-10-30T23:08:32.037910284Z'),NOW+.037);
  assert.equal(parseRadarBrowserTime('2026-10-31T00:08:32+01:00'),NOW);
  for(const bad of [null,'2026-10-30T23:08:32','2026-02-30T23:08:32Z','2026-13-01T00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:00+25:00','bad'])assert.equal(parseRadarBrowserTime(bad),null);
});

test('clasifica por ámbito, no duplica y excluye datos antiguos, dudosos o incompletos',()=>{
  const rows=[train('sev-av'),train('sev-c',{type:'commuter',productName:'Cercanías'}),
    train('madrid',{latitude:40.4,longitude:-3.7}),train('old',{timestamp:iso(NOW-91)}),
    train('ghost',{stale:true}),train('dup',{timestamp:iso(NOW-20)}),train('dup',{latitude:37.4,timestamp:iso(NOW)}),
    train('bad',{longitude:'-5.9'}),train('ambig'),train('ambig',{latitude:37.45}),
    train('other',{type:'unknown'}),train('naive',{timestamp:'2026-10-30T23:08:32'})];
  const parsed=parseRadarBrowserFleet(fleet(rows));
  const local=radarBrowserSnapshot(parsed,'sevilla',NOW);
  assert.equal(local.feeds.larga_distancia.status,'partial');
  assert.deepEqual(local.feeds.larga_distancia.vehicles.map(v=>v.label).sort(),['dup','sev-av']);
  assert.equal(local.feeds.larga_distancia.excluded_stale,1);
  assert.equal(local.feeds.larga_distancia.excluded_reported_stale,1);
  assert.equal(local.feeds.larga_distancia.excluded_ambiguous,1);
  assert.ok(local.feeds.larga_distancia.excluded_invalid>=2);
  assert.equal(local.feeds.cercanias.count,1);
  assert.equal(local.feeds.cercanias.vehicles[0].time_basis,'feed','hora individual de Cercanías no verificada');
  assert.equal(local.feeds.larga_distancia.vehicles[0].source_provider,'radar');
  assert.equal(local.feeds.larga_distancia.access_mode,'browser');
  assert.equal(radarBrowserSnapshot(parsed,'espana',NOW).feeds.larga_distancia.count,3);
});

test('la instantánea caducada o futura no se presenta como cero ni como posiciones actuales',()=>{
  for(const when of [NOW-91,NOW+31]) {
    const result=radarBrowserSnapshot(parseRadarBrowserFleet(fleet([train('av')],when)),'espana',NOW);
    for(const value of Object.values(result.feeds)){assert.equal(value.status,'stale');assert.equal(value.count,null);assert.deepEqual(value.vehicles,[]);}
  }
  assert.throws(()=>parseRadarBrowserFleet({trains:[],count:4,updatedAt:iso(NOW)}));
  assert.throws(()=>parseRadarBrowserFleet({trains:[],count:0,updatedAt:'no timezone'}));
});

test('los duplicados de igual hora y tipo contradictorio no inventan una clasificación AV',()=>{
  const parsed=parseRadarBrowserFleet(fleet([train('x'),train('x',{productName:'Media Distancia',productCategory:'MD'})]));
  assert.equal(parsed.valid.length,1);assert.equal(parsed.valid[0].service_name,null);
});

test('prioriza el servidor y no consulta Radar si la API propia es válida',async()=>{
  const calls=[],valid={scope:'espana',generated_at:NOW,feeds:{cercanias:{status:'error'},larga_distancia:{status:'error'}}};
  const source=createLiveSource({clock:()=>NOW,monotonic:()=>0,protocol:()=> 'https:',fetchImpl:async url=>{
    calls.push(url);return response(valid);
  }});
  assert.deepEqual(await source.get('espana'),valid);assert.deepEqual(calls,['./api/trenes?ambito=espana']);
});

test('sin API local usa CORS directo, comparte una consulta y respeta los 30 segundos',async()=>{
  let ms=0,radarCalls=0,localCalls=0;
  const source=createLiveSource({clock:()=>NOW+ms/1000,monotonic:()=>ms,protocol:()=> 'https:',fetchImpl:async url=>{
    if(url===RADAR_BROWSER_URL){radarCalls++;return response(fleet([train('av'),train('cc',{type:'commuter'})]));}
    localCalls++;return {ok:false,status:404};
  }});
  const [national,local]=await Promise.all([source.get('espana'),source.get('sevilla')]);
  assert.equal(radarCalls,1);assert.equal(localCalls,2);
  assert.equal(national.feeds.larga_distancia.count,1);assert.equal(local.feeds.cercanias.count,1);
  ms=29999;await source.get('espana');assert.equal(radarCalls,1);
  ms=30000;await source.get('sevilla');assert.equal(radarCalls,2);
});

test('con file:// consulta directamente Radar y conserva errores sin inventar cero',async()=>{
  let ms=0,calls=0;
  const source=createLiveSource({clock:()=>NOW+ms/1000,monotonic:()=>ms,protocol:()=> 'file:',fetchImpl:async url=>{
    assert.equal(url,RADAR_BROWSER_URL);calls++;if(calls===1)throw new Error('offline');return response(fleet([train('av')]));
  }});
  await assert.rejects(source.get('sevilla'),/offline/);await assert.rejects(source.get('espana'),/offline/);assert.equal(calls,1);
  ms=30000;assert.equal((await source.get('espana')).feeds.larga_distancia.count,1);assert.equal(calls,2);
});

test('Itinerarios puede usar Radar directamente y compartir la misma caché',async()=>{
  let calls=0;
  const source=createLiveSource({clock:()=>NOW,monotonic:()=>0,protocol:()=> 'https:',fetchImpl:async url=>{
    calls++;assert.equal(url,RADAR_BROWSER_URL);
    return response(fleet([train('01307',{trainCode:'01307',originCode:'51003',destinationCode:'51405',line:'C1',nextStationName:'Cádiz',delayMinutes:7})]));
  }});
  const [a,b]=await Promise.all([source.get('espana',{forceRadar:true}),source.get('sevilla',{forceRadar:true})]);
  assert.equal(calls,1);const v=a.feeds.larga_distancia.vehicles[0];
  assert.equal(v.origin_code,'51003');assert.equal(v.destination_code,'51405');assert.equal(v.next_station,'Cádiz');assert.equal(v.delay_minutes,7);
  assert.equal(b.feeds.larga_distancia.count,1);
});
test('una ruta contradictoria en duplicados no se usa para emparejar itinerarios',()=>{
  const parsed=parseRadarBrowserFleet(fleet([train('x',{originCode:'1',destinationCode:'2'}),train('x',{originCode:'1',destinationCode:'3'})]));
  assert.equal(parsed.valid[0].route_ambiguous,true);assert.equal(parsed.valid[0].destination_code,'');
});

test('un mismo identificador de Radar en tipos distintos no mezcla los trenes',()=>{
  const parsed=parseRadarBrowserFleet(fleet([
    train('mismo-id',{trainCode:'01307',originCode:'51003',destinationCode:'51405'}),
    train('mismo-id',{trainCode:'23502',type:'commuter',originCode:'51003',destinationCode:'51405'}),
  ]));
  const snapshot=radarBrowserSnapshot(parsed,'espana',NOW);
  const ld=snapshot.feeds.larga_distancia.vehicles[0],cc=snapshot.feeds.cercanias.vehicles[0];
  assert.notEqual(ld.id,cc.id,'la identidad debe incluir el tipo de servicio');
});

test('la flota respeta Retry-After ante HTTP 429 incluso en consultas compartidas',async()=>{
  let ms=0,calls=0;
  const source=createLiveSource({clock:()=>NOW+ms/1000,monotonic:()=>ms,protocol:()=> 'file:',fetchImpl:async()=>{
    calls++;
    if(calls===1)return {ok:false,status:429,headers:{get:name=>name.toLowerCase()==='retry-after'?'120':null}};
    return response(fleet([train('av',{timestamp:iso(NOW+ms/1000)})],NOW+ms/1000));
  }});
  await assert.rejects(source.get('espana'),/429/);
  ms=30000;await assert.rejects(source.get('sevilla'),/429/);assert.equal(calls,1);
  ms=119999;await assert.rejects(source.get('espana'),/429/);assert.equal(calls,1);
  ms=120000;assert.equal((await source.get('espana')).feeds.larga_distancia.count,1);assert.equal(calls,2);
});

test('Retry-After en fecha HTTP y sin cabecera se aplica desde la respuesta',async()=>{
  for(const [header,delay] of [[new Date((NOW+95)*1000).toUTCString(),90000],[null,120000]]) {
    let ms=0,calls=0;
    const source=createLiveSource({clock:()=>NOW+ms/1000,monotonic:()=>ms,protocol:()=> 'file:',fetchImpl:async()=>{
      calls++;
      if(calls===1){ms=5000;return {ok:false,status:429,headers:{get:()=>header}};}
      return response(fleet([train('av',{timestamp:iso(NOW+ms/1000)})],NOW+ms/1000));
    }});
    await assert.rejects(source.get('espana'),/429/);
    ms=5000+delay-1;await assert.rejects(source.get('sevilla'),/429/);assert.equal(calls,1);
    ms=5000+delay;assert.equal((await source.get('espana')).feeds.larga_distancia.count,1);assert.equal(calls,2);
  }
});
