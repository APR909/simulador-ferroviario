// Regression: loading Sevilla must not block other views or overwrite imports.
// Start servidor.py first, then: node tests/browser-startup.mjs
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const base=process.env.VIALAB_URL||'http://127.0.0.1:8000';
const now=Date.parse('2026-10-31T00:30:00+01:00');
const data={schema:1,timezone:'Europe/Madrid',start_date:'2026-10-30',days:4,generated_at:'2026-10-31T00:00:00Z',
  sources:[{id:'av',label:'AV',included_from:'2026-10-30',included_until:'2026-11-02'},
    {id:'cer',label:'Cercanías',included_from:'2026-10-30',included_until:'2026-11-02'}],
  stops:[['51003','Sevilla Santa Justa',37.3924,-5.9748],['51405','Cádiz',36.529,-6.288]],
  trips:[[0,'01307','Media Distancia','1',[0,23*3600+50*60,23*3600+50*60,1,24*3600+50*60,24*3600+50*60]]]};
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:original.call(this,type,...args);};});
  await page.clock.setFixedTime(new Date(now));
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{entered=resolve;});
  await page.route('**/data/sevilla-osm.json',async route=>{entered();await gate;await route.continue();});
  await page.route('**/data/itinerarios-renfe.json',route=>route.fulfill({json:data}));
  await page.route('**/api/trenes**',route=>{
    const scope=new URL(route.request().url()).searchParams.get('ambito')==='espana'?'espana':'sevilla';
    const empty={status:'fresh',header_timestamp:now/1000,count:0,vehicles:[]};
    return route.fulfill({json:{scope,generated_at:now/1000,fresh_seconds:90,feeds:{cercanias:empty,larga_distancia:empty}}});
  });
  await page.route('https://radardetrenes.com/api/v1/fleet?type=all',route=>route.fulfill({json:{updatedAt:new Date(now).toISOString(),count:1,trains:[
    {id:'ld-01307',trainCode:'01307',type:'long_distance',latitude:37.39,longitude:-5.98,timestamp:new Date(now).toISOString(),
      originCode:'51003',destinationCode:'51405',originName:'Sevilla',destinationName:'Cádiz',productName:'MD'}]}}));
  await page.goto(base+'/#itinerarios',{waitUntil:'commit',timeout:45000});
  await requested;
  await page.locator('#timetableView').waitFor({state:'visible',timeout:5000});
  await page.locator('#timetableCurrentCount').filter({hasText:'1 / 1'}).waitFor({timeout:15000});
  await page.locator('#showSevilla').click();
  await page.locator('.import-details summary').click();
  assert.equal(await page.locator('#playButton').isDisabled(),true);
  assert.equal(await page.locator('#restoreSample').isDisabled(),true);

  // Import a different file while the bundled request is pending. A late
  // startup response must not replace the user's chosen graph.
  await page.locator('#osmFile').setInputFiles({name:'mi-red.json',mimeType:'application/json',buffer:await readFile(new URL('../data/sevilla-osm.json',import.meta.url))});
  await page.locator('#datasetName').filter({hasText:'mi-red.json'}).waitFor({timeout:30000});
  await page.locator('#showTimetable').click();
  release();
  await page.waitForFunction(()=>!document.querySelector('#restoreSample').disabled,null,{timeout:30000});
  assert.equal(await page.locator('#timetableView').isVisible(),true);
  await page.locator('#showSevilla').click();
  assert.equal(await page.locator('#datasetName').innerText(),'mi-red.json');
  await page.locator('#restoreSample').click();
  await page.waitForFunction(()=>document.querySelectorAll('.train-card').length===10,null,{timeout:30000});
  assert.match(await page.locator('#datasetName').innerText(),/Sevilla metropolitana/);
  await page.locator('#showTimetable').click();
  await page.locator('#timetableCurrentCount').filter({hasText:'1 / 1'}).waitFor({timeout:15000});
  assert.deepEqual(errors,[]);
  console.log('OK · vistas independientes, importación no sobrescrita y restauración de Sevilla');
}finally{await browser.close();}
