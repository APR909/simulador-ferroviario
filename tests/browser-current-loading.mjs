// Regression: a slow or unavailable timetable must not block the live fleet.
// Start servidor.py first, then: node tests/browser-current-loading.mjs
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
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{const old=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:old.call(this,type,...args);};});
  await page.clock.setFixedTime(new Date(now));
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{entered=resolve;});
  await page.route('**/data/itinerarios-renfe.json',async route=>{entered();await gate;await route.fulfill({json:data});});
  await page.route('https://radardetrenes.com/api/v1/fleet?type=all',route=>route.fulfill({json:{updatedAt:new Date(now).toISOString(),count:1,trains:[
    {id:'ld-01307',trainCode:'01307',type:'long_distance',latitude:37.39,longitude:-5.98,timestamp:new Date(now).toISOString(),
      originCode:'51003',destinationCode:'51405',originName:'Sevilla',destinationName:'Cádiz',productName:'MD'}]}}));
  await page.route('https://radardetrenes.com/api/v1/stations/*/board-renfe',route=>route.fulfill({json:{updatedAt:now,arrivals:[],departures:[]}}));
  await page.goto(base+'/#itinerarios',{waitUntil:'domcontentloaded',timeout:45000});
  await requested;
  await page.locator('#timetableCurrentCount').filter({hasText:'1 / 1'}).waitFor({timeout:5000});
  assert.equal(await page.locator('#timetableRange').isDisabled(),true,'el calendario aún no ha terminado de cargar');
  assert.match(await page.locator('.timetable-current-result').first().innerText(),/Cargando horarios/);
  await page.locator('.timetable-current-result').first().click();
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/horarios.*cargando/i);
  release();
  await page.locator('#timetableRange:not([disabled])').waitFor({timeout:15000});
  await page.locator('#timetableStops tr').nth(2).waitFor({timeout:15000});
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/detectado en la última instantánea/);
  assert.equal(await page.locator('#timetableStops tr').count(),3);
  assert.deepEqual(errors,[]);
  await page.close();
  console.log('OK · flota independiente y paradas al terminar de cargar el GTFS');

  // The timetable may finish while the user is in another view. Returning
  // must still join the originally selected train to its planned stops.
  const hidden=await browser.newPage({viewport:{width:1280,height:800}});
  await hidden.clock.setFixedTime(new Date(now));
  let releaseHidden;const hiddenGate=new Promise(resolve=>{releaseHidden=resolve;});
  await hidden.route('**/data/itinerarios-renfe.json',async route=>{await hiddenGate;await route.fulfill({json:data});});
  await hidden.route('**/api/trenes**',route=>route.fulfill({status:503,body:'offline'}));
  await hidden.route('https://radardetrenes.com/api/v1/fleet?type=all',route=>route.fulfill({json:{updatedAt:new Date(now).toISOString(),count:1,trains:[
    {id:'ld-01307',trainCode:'01307',type:'long_distance',latitude:37.39,longitude:-5.98,timestamp:new Date(now).toISOString(),
      originCode:'51003',destinationCode:'51405',originName:'Sevilla',destinationName:'Cádiz',productName:'MD'}]}}));
  await hidden.route('https://radardetrenes.com/api/v1/stations/*/board-renfe',route=>route.fulfill({json:{updatedAt:now,arrivals:[],departures:[]}}));
  await hidden.goto(base+'/#itinerarios',{waitUntil:'domcontentloaded',timeout:45000});
  await hidden.locator('#timetableCurrentCount').filter({hasText:'1 / 1'}).waitFor({timeout:15000});
  await hidden.locator('.timetable-current-result').first().click();
  await hidden.locator('#showNational').click();releaseHidden();
  await hidden.waitForFunction(()=>!document.querySelector('#timetableRange').disabled,null,{timeout:15000});
  await hidden.locator('#showTimetable').click();
  await hidden.locator('#timetableStops tr').nth(2).waitFor({timeout:15000});
  assert.match(await hidden.locator('#timetableJourneyMeta').innerText(),/detectado en la última instantánea/);
  assert.equal(await hidden.locator('#timetableStops tr').count(),3);
  await hidden.close();console.log('OK · cruce al volver si el GTFS terminó en otra vista');

  const missing=await browser.newPage({viewport:{width:1280,height:800}});
  await missing.clock.setFixedTime(new Date(now));
  await missing.route('**/data/itinerarios-renfe.json',route=>route.fulfill({status:503,body:'offline'}));
  await missing.route('https://radardetrenes.com/api/v1/fleet?type=all',route=>route.fulfill({json:{updatedAt:new Date(now).toISOString(),count:1,trains:[
    {id:'ld-01307',trainCode:'01307',type:'long_distance',latitude:37.39,longitude:-5.98,timestamp:new Date(now).toISOString(),
      originCode:'51003',destinationCode:'51405',originName:'Sevilla',destinationName:'Cádiz',productName:'MD'}]}}));
  await missing.goto(base+'/#itinerarios',{waitUntil:'domcontentloaded',timeout:45000});
  await missing.locator('#timetableCurrentCount').filter({hasText:'1 / 1'}).waitFor({timeout:15000});
  await missing.locator('#timetableDatasetStatus').filter({hasText:'No se pudieron cargar'}).waitFor({timeout:15000});
  assert.match(await missing.locator('.timetable-current-result').first().innerText(),/Horarios no disponibles/);
  await missing.locator('.timetable-current-result').first().click();
  assert.match(await missing.locator('#timetableJourneyMeta').innerText(),/horarios no disponibles/);
  assert.match(await missing.locator('#timetableStops').innerText(),/No hay horarios disponibles/);
  assert.equal(await missing.locator('#timetableRange').isDisabled(),true);
  await missing.close();
  console.log('OK · flota disponible aunque los horarios fallen');
}finally{await browser.close();}
