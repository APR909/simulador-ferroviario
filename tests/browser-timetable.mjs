// Deterministic browser integration, using fixture data and mocked station boards.
// Run: node tests/browser-timetable.mjs (after starting a server on port 8000).
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
  const errors=[];let boardCalls=0;
  page.on('pageerror',error=>errors.push(error.message));
  await page.clock.setFixedTime(new Date(now));
  await page.route('**/data/itinerarios-renfe.json',route=>route.fulfill({json:fixture}));
  await page.route('https://radardetrenes.com/api/v1/stations/*/board-renfe',route=>{
    boardCalls++;
    const code=route.request().url().split('/').at(-2);
    const base={trainCode:'01307',stationCode:code,originCode:'51003',destinationCode:'51405',trafficType:'AVLDMD',timestamp:now};
    const dep=code==='51003'?[{...base,plannedTime:first,timeType:'REAL',delayMinutes:5}]:[];
    const arr=code==='51405'?[{...base,plannedTime:last,timeType:'ESTIMATED',delayMinutes:10}]:[];
    return route.fulfill({json:{updatedAt:now,departures:dep,arrivals:arr}});
  });
  await page.goto(`${url}/#itinerarios`,{waitUntil:'domcontentloaded',timeout:45000});
  await page.locator('#timetableRange:not([disabled])').waitFor({timeout:45000});
  assert.equal(await page.locator('#timetableTime').innerText(),'31/10 · 00:30');
  assert.equal(await page.locator('#timetableCount').innerText(),'1');
  await page.locator('.timetable-result').first().click();
  assert.match(await page.locator('#timetableJourneyMeta').innerText(),/día de servicio 30\/10\/2026.*según horario/);
  assert.equal(await page.locator('#timetableStops tr').count(),3);
  assert.equal(await page.locator('#timetable-stop-0 td').nth(2).locator('small').innerText(),'programada');
  await page.locator('#timetableBoardRefresh').click();
  await page.waitForFunction(()=>!document.querySelector('#timetableBoardRefresh').disabled,{timeout:30000});
  assert.equal(boardCalls,3);
  assert.match(await page.locator('#timetableBoardStatus').innerText(),/2 hora\(s\) estimadas o reales coincidentes/);
  assert.equal(await page.locator('#timetable-stop-0 td').nth(2).locator('small').innerText(),'real');
  assert.equal(await page.locator('#timetable-stop-0 td').nth(2).locator('b').innerText(),'30/10 · 23:55');
  assert.equal(await page.locator('#timetable-stop-2 td').nth(1).locator('small').innerText(),'estimada');
  assert.equal(await page.locator('#timetable-stop-2 td').nth(1).locator('b').innerText(),'31/10 · 01:00');
  await page.locator('#timetableBoardRefresh').click();
  await page.waitForFunction(()=>!document.querySelector('#timetableBoardRefresh').disabled,{timeout:30000});
  assert.equal(boardCalls,3,'los tablones deben reutilizar la caché');
  await page.locator('#timetableSearch').fill('cadiz');assert.equal(await page.locator('#timetableCount').innerText(),'1');
  await page.locator('#timetableSearch').fill('inexistente');assert.equal(await page.locator('#timetableCount').innerText(),'0');
  await page.locator('#timetableSearch').fill('');
  await page.locator('[data-timetable-offset="24"]').click();assert.equal(await page.locator('#timetableTime').innerText(),'30/10 · 00:30');
  assert.equal(await page.locator('#timetableCount').innerText(),'0');
  await page.locator('[data-timetable-offset="0"]').click();
  await page.locator('#showNational').click();await page.locator('#showTimetable').click();
  assert.equal(await page.locator('#timetableView').isVisible(),true);
  assert.deepEqual(errors,[]);
  console.log('OK · ventana de 24 h, búsqueda, selección, etiquetas reales/estimadas, caché y navegación');

  const mobile=await browser.newPage({viewport:{width:375,height:812},isMobile:true,hasTouch:true});
  await mobile.clock.setFixedTime(new Date(now));
  await mobile.route('**/data/itinerarios-renfe.json',route=>route.fulfill({json:fixture}));
  await mobile.goto(`${url}/#itinerarios`,{waitUntil:'domcontentloaded',timeout:45000});
  await mobile.locator('#timetableRange:not([disabled])').waitFor({timeout:45000});
  assert.equal(await mobile.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no debe haber desbordamiento horizontal');
  assert.equal(await mobile.locator('#showTimetable').isVisible(),true);
  await mobile.locator('.timetable-result').first().click();
  assert.match(await mobile.locator('#timetableJourneyHeading').innerText(),/01307/);
  console.log('OK · interfaz móvil');

  const offline=await browser.newContext({offline:true});
  const file=await offline.newPage();const fileErrors=[];file.on('pageerror',e=>fileErrors.push(e.message));
  await file.goto(pathToFileURL(`${process.cwd()}/simulador.html`).href+'#itinerarios',{waitUntil:'domcontentloaded',timeout:45000});
  await file.locator('#timetableRange:not([disabled])').waitFor({timeout:45000});
  assert.match(await file.locator('#timetableDatasetStatus').innerText(),/Instantánea/);
  assert.deepEqual(fileErrors,[]);
  await offline.close();
  console.log('OK · HTML autocontenido sin red');
} finally {await browser.close();}
