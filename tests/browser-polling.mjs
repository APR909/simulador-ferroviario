// Regression: poll after the shared Radar cache expires and only in the visible view.
// Start a static server on port 8001, then: node tests/browser-polling.mjs
import assert from 'node:assert/strict';
import {chromium} from 'playwright';

const base=process.env.VIALAB_STATIC_URL||'http://127.0.0.1:8001';
const start=Date.parse('2026-10-31T00:30:00+01:00');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
try {
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl2'?null:original.call(this,type,...args);};});
  await page.clock.install({time:new Date(start)});
  let release,entered,calls=0;
  const gate=new Promise(resolve=>{release=resolve;}),requested=new Promise(resolve=>{entered=resolve;});
  await page.route('**/data/espana-osm.json',async route=>{
    entered();await gate;
    await route.fulfill({json:{features:[[1,'rail','Vía de prueba','','','rail',[[37.39,-5.98],[37.40,-5.97]]]],stations:[],counts:{rail:1},source_date:'2026-10-30'}});
  });
  await page.route('**/api/trenes**',async route=>{
    const scope=new URL(route.request().url()).searchParams.get('ambito');
    if(scope==='espana')return route.fulfill({status:404,body:'static host'});
    const now=(await page.evaluate(()=>Date.now()))/1000,empty={status:'fresh',header_timestamp:now,count:0,vehicles:[]};
    return route.fulfill({json:{scope:'sevilla',generated_at:now,fresh_seconds:90,feeds:{cercanias:empty,larga_distancia:empty}}});
  });
  await page.route('https://radardetrenes.com/api/v1/fleet?type=all',async route=>{
    calls++;const time=new Date(await page.evaluate(()=>Date.now())).toISOString();
    const trains=Array.from({length:calls},(_,index)=>({id:`polling-${index}`,trainCode:`0130${index}`,type:'long_distance',latitude:37.39,longitude:-5.98,timestamp:time,productName:'MD'}));
    return route.fulfill({json:{updatedAt:time,count:trains.length,trains}});
  });
  await page.goto(base+'/#espana',{waitUntil:'domcontentloaded',timeout:45000});
  await requested;
  // Start the OSM download before the first live request and keep the clock
  // paused, reproducing an interval that would fire too early for the cache.
  await page.clock.pauseAt(new Date(await page.evaluate(()=>Date.now())+1000));
  await page.clock.fastForward(5000);
  const response=page.waitForResponse(r=>r.url().includes('/data/espana-osm.json'));
  release();await response;
  // National initialization yields for five animation frames while drawing.
  for(let i=0;i<7;i++){await page.clock.runFor(25);await page.waitForTimeout(10);}
  await page.locator('#nationalAVCount').filter({hasText:'1'}).waitFor({timeout:15000});
  assert.equal(calls,1,'solo la vista España debe consultar al iniciarse');
  const waitForRenderedCount=expected=>page.waitForFunction(value=>document.querySelector('#nationalAVCount')?.textContent===String(value),expected,{timeout:15000});
  // runFor executes timers at their due time; fastForward would coalesce an
  // early fixed interval at the endpoint and miss the original cache race.
  await page.clock.runFor(31000);
  await waitForRenderedCount(2);
  assert.equal(calls,2,'debe obtener una nueva instantánea tras 30 s, no esperar 60 s');

  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await page.clock.fastForward(62000);
  assert.equal(calls,2,'no consulta mientras la pestaña está oculta');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await waitForRenderedCount(3);
  assert.equal(calls,3,'reanuda al mostrar la pestaña');

  await page.locator('#showSevilla').click();
  await page.clock.fastForward(62000);
  assert.equal(calls,3,'España no consulta mientras se muestra Sevilla');
  await page.locator('#showNational').click();
  await waitForRenderedCount(4);
  assert.equal(calls,4,'España reanuda su consulta al volver');
  assert.deepEqual(errors,[]);
  console.log('OK · sondeo tras la caché y pausa/reanudación por vista y pestaña');
}finally{await browser.close();}
