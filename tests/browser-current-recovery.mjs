// Regression: distinct train identities and truthful recovery after source loss.
// Start servidor.py first, then: node tests/browser-current-recovery.mjs
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const base=process.env.VIALAB_URL||'http://127.0.0.1:8000';
const now=Date.parse('2026-10-31T00:30:00+01:00');
const data={schema:1,timezone:'Europe/Madrid',start_date:'2026-10-30',days:4,generated_at:'2026-10-31T00:00:00Z',
  sources:[{id:'av',label:'AV',included_from:'2026-10-30',included_until:'2026-11-02'},
    {id:'cer',label:'Cercanías',included_from:'2026-10-30',included_until:'2026-11-02'}],
  stops:[['51003','Sevilla Santa Justa',37.3924,-5.9748],['51100','San Bernardo',37.3775,-5.9795],['51405','Cádiz',36.529,-6.288]],
  trips:[[0,'01307','Media Distancia','1',[0,23*3600+50*60,23*3600+50*60,1,24*3600+5*60,24*3600+7*60,2,24*3600+50*60,24*3600+50*60]]]};
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  let mode='normal',calls=0;
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    const original=HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:original.call(this,type,...args);};
    let leaflet;window.__testMaps={};
    Object.defineProperty(window,'L',{configurable:true,get(){return leaflet;},set(value){
      leaflet=value;if(value?.map){const originalMap=value.map;value.map=(id,...args)=>{const map=originalMap(id,...args);window.__testMaps[id]=map;return map;};}
    }});
  });
  await page.clock.install({time:new Date(now)});
  await page.route('**/data/itinerarios-renfe.json',route=>route.fulfill({json:data}));
  await page.route('**/api/trenes**',async route=>{
    const seconds=(await page.evaluate(()=>Date.now()))/1000;
    const scope=new URL(route.request().url()).searchParams.get('ambito')==='espana'?'espana':'sevilla';
    const empty={status:'fresh',header_timestamp:seconds,count:0,vehicles:[]};
    return route.fulfill({json:{scope,generated_at:seconds,fresh_seconds:90,feeds:{cercanias:empty,larga_distancia:empty}}});
  });
  await page.route('https://radardetrenes.com/api/v1/fleet?type=all',async route=>{
    calls++;
    if(mode==='offline')return route.fulfill({status:503,body:'offline'});
    if(mode==='limited')return route.fulfill({status:429,headers:{'Retry-After':'120','Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Retry-After'},body:'limit'});
    const current=await page.evaluate(()=>Date.now()),time=new Date(current).toISOString();
    const trains=[{id:'shared',trainCode:'01307',type:'long_distance',latitude:37.39,longitude:-5.98,timestamp:time,
      originCode:'51003',destinationCode:'51405',originName:'Sevilla',destinationName:'Cádiz',productName:'MD'}];
    if(mode!=='missing')trains.push({id:'shared',trainCode:'23502',type:'commuter',latitude:37.38,longitude:-5.97,timestamp:time,
      originCode:'51003',destinationCode:'51405',originName:'Sevilla',destinationName:'Cádiz',productName:'Cercanías'});
    return route.fulfill({json:{updatedAt:time,count:trains.length,trains}});
  });
  await page.route('https://radardetrenes.com/api/v1/stations/*/board-renfe',async route=>{
    const current=await page.evaluate(()=>Date.now());return route.fulfill({json:{updatedAt:current,arrivals:[],departures:[]}});
  });
  await page.goto(base+'/#itinerarios',{waitUntil:'domcontentloaded',timeout:45000});
  await page.locator('#timetableRange:not([disabled])').waitFor({timeout:45000});
  await page.locator('#timetableCurrentCount').filter({hasText:'2 / 2'}).waitFor({timeout:15000});
  // Freeze after startup so wall/monotonic time cannot race asynchronous route
  // handlers while the test advances the polling and Retry-After clocks.
  await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now())+1000));
  const commuter=page.locator('.timetable-current-result').filter({hasText:'23502'});
  const longDistance=page.locator('.timetable-current-result').filter({hasText:'01307'});
  assert.match(await commuter.innerText(),/Sin itinerario inequívoco asociado/);
  assert.match(await longDistance.innerText(),/Paradas programadas disponibles/);
  await commuter.click();
  assert.match(await page.locator('#timetableJourneyHeading').innerText(),/23502/);
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/sin itinerario GTFS inequívoco/);
  const lineCount=()=>page.evaluate(()=>Object.values(window.__testMaps.timetableMap._layers)
    .filter(layer=>layer instanceof L.Polyline && layer.options?.dashArray==='6 8').length);
  assert.equal(await lineCount(),1,'se dibuja el esquema entre extremos conocidos');

  // A fresh snapshot that omits the selected train says so and clears the old line.
  mode='missing';await page.clock.fastForward(31000);
  try {await page.locator('#timetableCurrentCount').filter({hasText:'1 / 1'}).waitFor({timeout:15000});}
  catch(error) {
    console.error('Diagnóstico de refresco:',JSON.stringify({calls,status:await page.locator('#timetableCurrentStatus').innerText(),count:await page.locator('#timetableCurrentCount').innerText(),time:await page.evaluate(()=>({wall:Date.now(),mono:performance.now()}))}));
    throw error;
  }
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/no aparece en la instantánea/);
  assert.equal(await lineCount(),0);
  // When the same identity reappears, update its detail and redraw its endpoints.
  mode='normal';await page.clock.fastForward(31000);
  try {await page.locator('#timetableCurrentCount').filter({hasText:'2 / 2'}).waitFor({timeout:15000});}
  catch(error) {
    console.error('Diagnóstico de recuperación:',JSON.stringify({calls,status:await page.locator('#timetableCurrentStatus').innerText(),count:await page.locator('#timetableCurrentCount').innerText(),time:await page.evaluate(()=>({wall:Date.now(),mono:performance.now()}))}));
    throw error;
  }
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/sin itinerario GTFS inequívoco/);
  assert.equal(await lineCount(),1);

  // An unavailable source is not proof the train disappeared or finished.
  mode='offline';await page.clock.fastForward(31000);
  await page.locator('#timetableCurrentStatus').filter({hasText:'SIN DATOS RECIENTES'}).waitFor({timeout:15000});
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/sin datos recientes|no se puede confirmar/i);
  assert.doesNotMatch(await page.locator('#timetableJourneyMeta').innerText(),/no aparece en la instantánea/i);
  assert.equal(await lineCount(),0);
  mode='normal';await page.clock.fastForward(31000);
  await page.locator('#timetableCurrentCount').filter({hasText:'2 / 2'}).waitFor({timeout:15000});
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/sin itinerario GTFS inequívoco/);
  assert.equal(await lineCount(),1);

  // The same distinction applies when a scheduled journey is selected.
  await longDistance.click();
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/detectado en la última instantánea/);
  mode='offline';await page.clock.fastForward(31000);
  await page.locator('#timetableCurrentStatus').filter({hasText:'SIN DATOS RECIENTES'}).waitFor({timeout:15000});
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/sin datos recientes|no se puede confirmar/i);
  assert.doesNotMatch(await page.locator('#timetableJourneyMeta').innerText(),/no aparece en la instantánea/i);

  mode='normal';await page.clock.fastForward(31000);
  await page.locator('#timetableCurrentCount').filter({hasText:'2 / 2'}).waitFor({timeout:15000});
  mode='limited';await page.clock.fastForward(31000);
  await page.locator('#timetableCurrentStatus').filter({hasText:'el proveedor limita'}).waitFor({timeout:15000});
  const limitedCalls=calls;mode='normal';
  // Advance in polling-sized steps and let each asynchronous refresh settle.
  // A single big fastForward can skip timers scheduled by a prior promise.
  for(let step=0;step<3;step++) {
    await page.clock.fastForward(31000);await page.waitForTimeout(50);
    assert.equal(calls,limitedCalls,'no debe volver a consultar antes de Retry-After');
  }
  await page.clock.fastForward(31000);
  try {await page.locator('#timetableCurrentCount').filter({hasText:'2 / 2'}).waitFor({timeout:15000});}
  catch(error) {
    console.error('Diagnóstico de Retry-After:',JSON.stringify({calls,limitedCalls,status:await page.locator('#timetableCurrentStatus').innerText(),count:await page.locator('#timetableCurrentCount').innerText(),time:await page.evaluate(()=>({wall:Date.now(),mono:performance.now()}))}));
    throw error;
  }
  assert.equal(calls,limitedCalls+1);
  assert.deepEqual(errors,[]);
  console.log('OK · identidad entre tipos, recuperación y límite HTTP 429');
}finally{await browser.close();}
