// Deterministic browser integration for the live itinerary.
// Run after starting servidor.py on port 8000: node tests/browser-timetable.mjs
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const url=process.env.VIALAB_URL || 'http://127.0.0.1:8000';
const now=Date.parse('2026-10-31T00:30:00+01:00');
const first=Date.parse('2026-10-30T23:50:00+01:00');
const last=Date.parse('2026-10-31T00:50:00+01:00');
const fixture={schema:1,timezone:'Europe/Madrid',start_date:'2026-10-30',days:4,generated_at:'2026-10-31T00:00:00Z',
  sources:[{id:'av',label:'AV',included_from:'2026-10-30',included_until:'2026-11-02'},
    {id:'cer',label:'Cercanías',included_from:'2026-10-30',included_until:'2026-11-02'}],
  stops:[['51003','Sevilla Santa Justa',37.3924,-5.9748],['51100','San Bernardo',37.3775,-5.9795],['51405','Cádiz',36.529,-6.288]],
  trips:[[0,'01307','Media Distancia','1',[0,23*3600+50*60,23*3600+50*60,1,24*3600+5*60,24*3600+7*60,2,24*3600+50*60,24*3600+50*60]]]};

const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];let boardCalls=0,mode='normal';const byStation={};
  page.on('pageerror',error=>errors.push(error.message));
  await page.clock.install({time:new Date(now)});
  await page.route('**/data/itinerarios-renfe.json',route=>route.fulfill({json:fixture}));
  await page.route('https://radardetrenes.com/api/v1/stations/*/board-renfe',async route=>{
    boardCalls++;
    const code=route.request().url().split('/').at(-2),round=byStation[code]=(byStation[code]||0)+1;
    const current=await page.evaluate(()=>Date.now());
    const sourceTime=current-(mode==='stale'?180000:mode==='near-expiry'?119000:0);
    const base={trainCode:'01307',stationCode:code,originCode:'51003',destinationCode:'51405',trafficType:'AVLDMD',timestamp:sourceTime};
    const dep=code==='51003'?[{...base,plannedTime:first,timeType:'REAL',delayMinutes:round===1?5:6}]:[];
    const arr=code==='51405'?[{...base,plannedTime:last,timeType:'ESTIMATED',delayMinutes:round===1?10:12}]:[];
    return route.fulfill({json:{updatedAt:sourceTime,departures:dep,arrivals:arr}});
  });
  await page.goto(`${url}/#itinerarios`,{waitUntil:'domcontentloaded',timeout:45000});
  await page.locator('#timetableRange:not([disabled])').waitFor({timeout:45000});
  assert.equal(await page.locator('#timetableTime').innerText(),'31/10 · 00:30');
  assert.equal(await page.locator('#timetableCount').innerText(),'1');
  await page.locator('.timetable-result').first().click();
  const start=page.locator('#timetable-stop-0 td').nth(2),end=page.locator('#timetable-stop-2 td').nth(1);
  await start.locator('.timetable-time-live.real').waitFor({timeout:15000});
  assert.equal(boardCalls,3,'la primera consulta debe iniciarse sin pulsar el botón');
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/día de servicio 30\/10\/2026.*según horario/);
  assert.equal(await page.locator('#timetableStops tr').count(),3);
  assert.equal(await start.locator('.timetable-time-planned b').innerText(),'30/10 · 23:50');
  assert.equal(await start.locator('.timetable-time-live b').innerText(),'30/10 · 23:55');
  assert.match(await start.locator('.timetable-time-live small').innerText(),/real · \+5 min/);
  assert.equal(await end.locator('.timetable-time-planned b').innerText(),'31/10 · 00:50');
  assert.equal(await end.locator('.timetable-time-live b').innerText(),'31/10 · 01:00');
  assert.match(await end.locator('.timetable-time-live small').innerText(),/estimada · \+10 min/);
  assert.match(await page.locator('#timetableBoardStatus').innerText(),/AUTO.*3 tablón\(es\) recientes.*2 hora\(s\) coincidentes/);
  assert.match(await page.locator('#timetable-stop-1 td').nth(1).innerText(),/sin coincidencia actual/);
  await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now())+1000));

  // A manual check within 30 seconds reuses the shared station cache.
  await page.locator('#timetableBoardRefresh').click();
  await page.locator('#timetableBoardStatus').filter({hasText:'2 hora(s) coincidentes'}).waitFor();
  assert.equal(boardCalls,3);

  // Advance the clock: live values change automatically without another click.
  await page.clock.fastForward(46100);
  await start.locator('.timetable-time-live small').filter({hasText:'real · +6 min'}).waitFor({timeout:15000});
  assert.equal(boardCalls,6);
  assert.equal(await start.locator('.timetable-time-planned b').innerText(),'30/10 · 23:50');
  assert.equal(await start.locator('.timetable-time-live b').innerText(),'30/10 · 23:56');
  assert.match(await end.locator('.timetable-time-live small').innerText(),/estimada · \+12 min/);

  // Leaving the view pauses network traffic; returning immediately resumes it.
  await page.locator('#showNational').click();
  const pausedCalls=boardCalls;await page.clock.fastForward(90000);
  assert.equal(boardCalls,pausedCalls,'no debe consultar tablones fuera de la vista');
  await page.locator('#showTimetable').click();
  await page.locator('#timetableBoardStatus').filter({hasText:'2 hora(s) coincidentes'}).waitFor({timeout:15000});
  assert.equal(boardCalls,pausedCalls+3);

  // An invisible browser tab also pauses; on visibility it resumes.
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  const hiddenCalls=boardCalls;await page.clock.fastForward(90000);
  assert.equal(boardCalls,hiddenCalls,'no debe consultar tablones en una pestaña oculta');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await page.locator('#timetableBoardStatus').filter({hasText:'2 hora(s) coincidentes'}).waitFor({timeout:15000});
  assert.equal(boardCalls,hiddenCalls+3);

  // Source timestamps near the TTL expire even if the next poll has not run.
  mode='near-expiry';await page.clock.fastForward(46100);
  await page.locator('#timetableBoardStatus').filter({hasText:'2 hora(s) coincidentes'}).waitFor({timeout:15000});
  await page.clock.fastForward(1500);
  assert.equal(await page.locator('.timetable-time-live').count(),0,'no se deben presentar valores caducados como actuales');
  assert.equal(await start.locator('.timetable-time-planned b').innerText(),'30/10 · 23:50');
  assert.match(await page.locator('#timetableBoardStatus').innerText(),/0 hora\(s\) coincidentes/);

  // A stale board is visible as unavailable, not as a real or punctual event.
  mode='stale';await page.clock.fastForward(46100);
  await page.locator('#timetableBoardStatus').filter({hasText:'3 tablón(es) desactualizados'}).waitFor({timeout:15000});
  assert.equal(await page.locator('.timetable-time-live').count(),0);
  assert.match(await start.innerText(),/tablón desactualizado/);

  // Keep an explicitly selected journey after its scheduled arrival, so that
  // late arrivals are not lost merely because the scheduled interval ended.
  mode='normal';await page.clock.fastForward(30*60*1000);
  assert.match(await page.locator('#timetableJourneyHeading').innerText(),/01307/);
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/viaje conservado para seguimiento/);
  assert.equal(await page.locator('#timetableCount').innerText(),'0');

  await page.locator('#timetableSearch').fill('cadiz');
  await page.locator('#timetableSearch').fill('inexistente');
  assert.equal(await page.locator('#timetableCount').innerText(),'0');
  await page.locator('#timetableSearch').fill('');
  await page.locator('[data-timetable-offset="24"]').click();
  await page.locator('[data-timetable-offset="0"]').click();
  assert.equal(await page.locator('#timetableView').isVisible(),true);
  assert.deepEqual(errors,[]);
  console.log('OK · consulta automática, horarios simultáneos, actualización, pausa, caducidad y viaje retrasado');
  await page.close();

  // Respect HTTP 429 and Retry-After, including for the manual refresh button.
  const throttle=await browser.newPage({viewport:{width:1300,height:800}});let limited=true,requests=0;
  await throttle.clock.install({time:new Date(now)});
  await throttle.route('**/data/itinerarios-renfe.json',route=>route.fulfill({json:fixture}));
  await throttle.route('https://radardetrenes.com/api/v1/stations/*/board-renfe',async route=>{
    requests++;
    if(limited)return route.fulfill({status:429,headers:{'Retry-After':'120','Access-Control-Allow-Origin':'*','Access-Control-Expose-Headers':'Retry-After'},body:'limit'});
    const current=await throttle.evaluate(()=>Date.now());
    return route.fulfill({json:{updatedAt:current,arrivals:[],departures:[]}});
  });
  await throttle.goto(`${url}/#itinerarios`,{waitUntil:'domcontentloaded',timeout:45000});
  await throttle.locator('#timetableRange:not([disabled])').waitFor({timeout:45000});
  await throttle.locator('.timetable-result').first().click();
  await throttle.locator('#timetableBoardStatus').filter({hasText:'límite de consultas'}).waitFor({timeout:15000});
  assert.equal(await throttle.locator('#timetableBoardRefresh').isDisabled(),true);
  await throttle.clock.pauseAt(new Date(await throttle.evaluate(()=>Date.now())+1000));
  const limitedCalls=requests;limited=false;await throttle.clock.fastForward(60000);
  assert.equal(requests,limitedCalls,'no debe reintentar antes de Retry-After');
  await throttle.clock.fastForward(61000);
  await throttle.locator('#timetableBoardStatus').filter({hasText:'3 tablón(es) recientes'}).waitFor({timeout:15000});
  assert.equal(requests,limitedCalls+3);
  console.log('OK · límite HTTP 429 y reintento controlado');
  await throttle.close();

  // Rapidly changing trains cancels in-flight requests and cannot attach an
  // old cached promise to the new selection, even for the same stations.
  const race=await browser.newPage({viewport:{width:1300,height:800}});let phase='slow',releaseOld,firstRequest;
  const entered=new Promise(resolve=>{firstRequest=resolve}),gate=new Promise(resolve=>{releaseOld=resolve});
  const second=[...fixture.trips[0]];second[1]='01308';
  await race.clock.setFixedTime(new Date(now));
  await race.route('**/data/itinerarios-renfe.json',route=>route.fulfill({json:{...fixture,trips:[fixture.trips[0],second]}}));
  await race.route('https://radardetrenes.com/api/v1/stations/*/board-renfe',async route=>{
    const slow=phase==='slow',code=route.request().url().split('/').at(-2);
    if(slow){firstRequest();await gate;}
    const base={trainCode:slow?'01307':'01308',stationCode:code,originCode:'51003',destinationCode:'51405',trafficType:'AVLDMD',timestamp:now};
    const dep=code==='51003'?[{...base,plannedTime:first,timeType:'REAL',delayMinutes:slow?5:9}]:[];
    try {await route.fulfill({json:{updatedAt:now,departures:dep,arrivals:[]}});} catch (_) { /* the old request was aborted */ }
  });
  await race.goto(`${url}/#itinerarios`,{waitUntil:'domcontentloaded',timeout:45000});
  await race.locator('#timetableRange:not([disabled])').waitFor({timeout:45000});
  await race.locator('.timetable-result').first().click();await entered;
  phase='new';await race.locator('.timetable-result').nth(1).click();
  await race.locator('#timetable-stop-0 .timetable-time-live small').filter({hasText:'real · +9 min'}).waitFor({timeout:15000});
  releaseOld();
  assert.match(await race.locator('#timetableJourneyHeading').innerText(),/01308/);
  assert.match(await race.locator('#timetable-stop-0 .timetable-time-live small').innerText(),/\+9 min/);
  console.log('OK · cancelación segura al cambiar de tren');
  await race.close();

  const mobile=await browser.newPage({viewport:{width:375,height:812},isMobile:true,hasTouch:true});
  await mobile.clock.setFixedTime(new Date(now));
  await mobile.route('**/data/itinerarios-renfe.json',route=>route.fulfill({json:fixture}));
  await mobile.route('https://radardetrenes.com/api/v1/stations/*/board-renfe',route=>route.fulfill({json:{updatedAt:now,arrivals:[],departures:[]}}));
  await mobile.goto(`${url}/#itinerarios`,{waitUntil:'domcontentloaded',timeout:45000});
  await mobile.locator('#timetableRange:not([disabled])').waitFor({timeout:45000});
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no debe haber desbordamiento horizontal');
  assert.equal(await mobile.locator('#showTimetable').isVisible(),true);
  await mobile.locator('.timetable-result').first().click();
  assert.match(await mobile.locator('#timetableJourneyHeading').innerText(),/01307/);
  await mobile.locator('#timetableBoardStatus').filter({hasText:'3 tablón(es) recientes'}).waitFor({timeout:15000});
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'la tabla no debe desbordar la página móvil');
  console.log('OK · interfaz móvil sin desbordamiento');

  const offline=await browser.newContext({offline:true});
  const file=await offline.newPage();const fileErrors=[];file.on('pageerror',e=>fileErrors.push(e.message));
  await file.goto(pathToFileURL(`${process.cwd()}/simulador.html`).href+'#itinerarios',{waitUntil:'domcontentloaded',timeout:45000});
  await file.locator('#timetableRange:not([disabled])').waitFor({timeout:45000});
  assert.match(await file.locator('#timetableDatasetStatus').innerText(),/Instantánea/);
  assert.deepEqual(fileErrors,[]);
  await offline.close();
  console.log('OK · HTML autocontenido sin red');
} finally {await browser.close();}
