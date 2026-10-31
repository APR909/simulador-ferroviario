// Live journeys: controlled Radar snapshots, safe GTFS join and pause/expiry.
// Run after servidor.py has started: node tests/browser-current.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base=process.env.VIALAB_URL || 'http://127.0.0.1:8000';
const now=Date.parse('2026-10-31T00:30:00+01:00');
const data={schema:1,timezone:'Europe/Madrid',start_date:'2026-10-30',days:4,generated_at:'2026-10-31T00:00:00Z',
  sources:[{id:'av',label:'AV',included_from:'2026-10-30',included_until:'2026-11-02'},
    {id:'cer',label:'Cercanías',included_from:'2026-10-30',included_until:'2026-11-02'}],
  stops:[['51003','Sevilla Santa Justa',37.3924,-5.9748],['51100','San Bernardo',37.3775,-5.9795],['51405','Cádiz',36.529,-6.288]],
  trips:[[0,'01307','Media Distancia','1',[0,23*3600+50*60,23*3600+50*60,1,24*3600+5*60,24*3600+7*60,2,24*3600+50*60,24*3600+50*60]]]};
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  let calls=0,stale=false,changed=false;
  page.on('pageerror',e=>errors.push(e.message));
  await page.clock.install({time:new Date(now)});
  await page.route('**/data/itinerarios-renfe.json',route=>route.fulfill({json:data}));
  // The other views may poll independently. Give them a valid local response
  // so the pause assertion measures only the itinerary's Radar polling.
  await page.route('**/api/trenes**',async route=>{
    const seconds=(await page.evaluate(()=>Date.now()))/1000;
    const scope=new URL(route.request().url()).searchParams.get('ambito')==='espana'?'espana':'sevilla';
    const empty={status:'fresh',header_timestamp:seconds,count:0,vehicles:[]};
    return route.fulfill({json:{scope,generated_at:seconds,fresh_seconds:90,feeds:{cercanias:empty,larga_distancia:empty}}});
  });
  await page.route('https://radardetrenes.com/api/v1/fleet?type=all',async route=>{
    calls++;const current=await page.evaluate(()=>Date.now()),time=new Date(stale?current-180000:current).toISOString();
    const trains=[{id:'ld-01307',trainCode:'01307',type:'long_distance',latitude:37.39,longitude:-5.98,timestamp:time,
      originCode:changed?'99999':'51003',destinationCode:'51405',originName:'Sevilla',destinationName:'Cádiz',productName:'MD',nextStationName:'San Bernardo',delayMinutes:7},
      {id:'c-23502',trainCode:'23502',type:'commuter',latitude:37.38,longitude:-5.97,timestamp:time,
        originCode:'51003',destinationCode:'51405',originName:'Sevilla',destinationName:'Cádiz',productName:'Cercanías',line:'C1'},
      {id:'old',trainCode:'99999',type:'long_distance',latitude:37.4,longitude:-5.9,timestamp:time,stale:true}];
    return route.fulfill({json:{updatedAt:time,count:trains.length,trains}});
  });
  await page.route('https://radardetrenes.com/api/v1/stations/*/board-renfe',async route=>{
    const current=await page.evaluate(()=>Date.now());return route.fulfill({json:{updatedAt:current,arrivals:[],departures:[]}});
  });
  await page.goto(base+'/#itinerarios',{waitUntil:'domcontentloaded',timeout:45000});
  await page.locator('#timetableRange:not([disabled])').waitFor({timeout:45000});
  await page.locator('#timetableCurrentCount').filter({hasText:'2 / 2'}).waitFor({timeout:15000});
  await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now())+1000));
  assert.equal(calls,1,'la lista se carga automáticamente sin servidor propio');
  assert.match(await page.locator('#timetableCurrentStatus').innerText(),/cobertura parcial.*1 sin hora GPS individual verificada/);
  assert.equal(await page.locator('.timetable-current-result').count(),2);
  await page.locator('#timetableCurrentSearch').fill('cadiz');
  assert.equal(await page.locator('#timetableCurrentCount').innerText(),'2 / 2');
  assert.doesNotMatch(await page.locator('#timetableCurrentStatus').innerText(),/instantánea —/);
  await page.locator('#timetableCurrentType').selectOption('long_distance');
  assert.equal(await page.locator('#timetableCurrentCount').innerText(),'1 / 2');
  const card=page.locator('.timetable-current-result').first();
  assert.match(await card.innerText(),/01307.*DETECTADO/s);
  assert.match(await card.innerText(),/Paradas programadas disponibles/);
  await card.click();
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/detectado en la última instantánea/);
  assert.equal(await page.locator('#timetableStops tr').count(),3);
  assert.match(await page.locator('#timetableMapNotice').innerText(),/no son un recorrido GPS histórico/);
  await page.locator('#timetableCurrentMap').uncheck();
  assert.equal(await page.locator('#timetableCurrentMap').isChecked(),false);
  // If a provider reuses the same id for a different route, it must not be
  // attached to the previously selected GTFS itinerary.
  changed=true;await page.clock.fastForward(31000);
  await page.locator('.timetable-current-result').filter({hasText:'01307'}).filter({hasText:'Sin itinerario inequívoco asociado'}).waitFor({timeout:15000});
  assert.doesNotMatch(await page.locator('#timetableJourneyMeta').innerText(),/detectado en la última instantánea/);

  // A detected train without an unambiguous schedule stays visible but does
  // not acquire a made-up list of stations or actual arrival times.
  await page.locator('#timetableCurrentType').selectOption('commuter');
  assert.equal(await page.locator('#timetableCurrentCount').innerText(),'1 / 2');
  await page.locator('.timetable-current-result').first().click();
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/sin itinerario GTFS inequívoco/);
  assert.match(await page.locator('#timetableStops').innerText(),/no hay una coincidencia única/);
  assert.match(await page.locator('#timetableMapNotice').innerText(),/no representa el trazado real/);

  const previous=calls;await page.locator('#showNational').click();await page.clock.fastForward(60000);
  assert.equal(calls,previous,'no debe consultar la flota desde la vista oculta');
  await page.locator('#showTimetable').click();
  await page.locator('#timetableCurrentCount').filter({hasText:'1 / 2'}).waitFor({timeout:15000});
  assert.equal(calls,previous+1,'reanuda la consulta al volver');

  // An old snapshot is not shown as current or falsely treated as zero trains.
  stale=true;await page.clock.fastForward(31000);
  await page.locator('#timetableCurrentStatus').filter({hasText:'SIN DATOS RECIENTES'}).waitFor({timeout:15000});
  assert.equal(await page.locator('#timetableCurrentCount').innerText(),'—');
  assert.equal(await page.locator('.timetable-current-result').count(),0);
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/sin datos recientes|no se puede confirmar/i);
  assert.deepEqual(errors,[]);
  console.log('OK · recorridos actuales, cruce GTFS, filtros, pausa y caducidad');

  const mobile=await browser.newPage({viewport:{width:375,height:812},isMobile:true,hasTouch:true});
  await mobile.route('**/data/itinerarios-renfe.json',route=>route.fulfill({json:data}));
  await mobile.goto(base+'/#itinerarios',{waitUntil:'domcontentloaded',timeout:45000});
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await mobile.close();console.log('OK · sección actual adaptable a móvil');
}finally{await browser.close();}
