// Optional browser integration check; fixtures below are synthetic, not real trains.
// Start servidor.py first, install Playwright separately, then run:
//   node tests/browser-motion.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const baseUrl=process.env.VIALAB_URL || 'http://127.0.0.1:8000';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
const errors=[];
const now=()=>Math.floor(Date.now()/1000);
const feed=(cars,t=now())=>({status:'fresh',header_timestamp:t,fetched_at:t,vehicles:cars,count:cars.length,excluded_stale:0,excluded_ambiguous:0,feed_time_fallback:0});
const vehicle=(id,lat,lon,t,service='Alta Velocidad')=>({id:`radar:${id}`,label:id,trip_id:id,latitude:lat,longitude:lon,
  observed_at:t,time_basis:'vehicle',service_name:service,source_provider:'radar',origin:'Origen <img src=x>',destination:'Destino'});
function response(scope,ld,cc=[],header=now()) {
  return {scope,generated_at:header,fresh_seconds:90,service_catalog:{status:'radar_product'},
          feeds:{cercanias:feed(cc,header),larga_distancia:{...feed(ld,header),source_provider:'radar',direct_status:'stale'}}};
}
async function page(options={}) {
  const p=await browser.newPage({viewport:{width:1440,height:900},...options});p.setDefaultTimeout(30000);
  p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>{let Lvalue;window.__testMaps={};Object.defineProperty(window,'L',{configurable:true,get(){return Lvalue},set(v){
    Lvalue=v;if(v?.map){const old=v.map;v.map=(id,...args)=>{const map=old(id,...args);window.__testMaps[id]=map;return map}}}})});
  return p;
}
async function nationalReady(p){await p.waitForFunction(()=>document.querySelector('#nationalWayCount')?.textContent==='45.695',null,{timeout:60000});}
const getLat=(p,map,id)=>p.evaluate(({map,id})=>{
  const m=Object.values(window.__testMaps[map]._layers).find(x=>x.options?.title?.includes(id));
  return m ? m.getLatLng().lat : null;
},{map,id});
const popup=(p,map,id)=>p.evaluate(({map,id})=>{
  Object.values(window.__testMaps[map]._layers).find(x=>x.options?.title?.includes(id)).openPopup();
},{map,id}); // Never return the Leaflet object: its map contains tens of thousands of layers.

try {
  // National view: source attribution, filter, interpolation, conflict and ageing.
  const p=await page();let calls=0,mode='motion';const initial=now();
  await p.route('**/api/trenes**',route=>{
    const national=route.request().url().includes('ambito=espana');if(!national)return route.fulfill({json:response('sevilla',[])});
    calls++;let ld;
    if(mode==='age')ld=[vehicle('AGE-AV',40.4,-3.7,now()-89)];
    else ld=[vehicle('SINTETICO-AV',calls===1?40.4:calls===2?40.41:40.42,-3.7,calls===1?initial-30:initial),
             vehicle('SINTETICO-MD',39.5,-2,initial,'Media Distancia')];
    const cc=[{id:'cc-fixture',label:'C-FIXTURE',latitude:41,longitude:-4,observed_at:initial,time_basis:'vehicle'}];
    return route.fulfill({json:response('espana',ld,cc)});
  });
  await p.goto(baseUrl+'/',{waitUntil:'domcontentloaded'});await nationalReady(p);
  await p.waitForFunction(()=>document.querySelector('#nationalAVCount')?.textContent==='2');
  assert.equal(await p.locator('.national-marker').count(),2);
  assert.match(await p.locator('#nationalAVStatus').innerText(),/RadarDeTrenes/);
  assert.match(await p.locator('#nationalExpressCount').innerText(),/identificada: 1/);
  await p.locator('#nationalExpressOnly').check();assert.equal(await p.locator('.national-marker').count(),1);
  assert.equal(await p.locator('.national-marker-dot.express').count(),1);
  await p.locator('#nationalExpressOnly').uncheck();await p.locator('#nationalCommuter').check();assert.equal(await p.locator('.national-marker').count(),3);
  await p.locator('#nationalCommuter').uncheck();
  assert.equal(await getLat(p,'nationalMap','SINTETICO-AV'),40.4);
  await p.locator('#nationalLiveRefresh').click();await p.waitForFunction(()=>document.querySelector('.national-marker.is-interpolating'));
  await p.waitForTimeout(1100);const intermediate=await getLat(p,'nationalMap','SINTETICO-AV');assert.ok(intermediate>40.4&&intermediate<40.41);
  await popup(p,'nationalMap','SINTETICO-AV');const info=p.locator('.leaflet-popup').filter({hasText:'SINTETICO-AV'});
  assert.match(await info.innerText(),/RADARDETRENES/);assert.match(await info.innerText(),/estimado en línea recta/);
  assert.match(await info.innerText(),/Último punto observado/);assert.equal(await info.locator('img').count(),0);
  await p.locator('#nationalAnimate').uncheck();assert.ok(Math.abs((await getLat(p,'nationalMap','SINTETICO-AV'))-40.41)<1e-9);
  await p.locator('#nationalLiveRefresh').click();await p.waitForFunction(()=>document.querySelector('#nationalMotionStatus')?.textContent.includes('contradictorias'));
  assert.equal(await getLat(p,'nationalMap','SINTETICO-AV'),null);
  mode='age';await p.locator('#nationalLiveRefresh').click();await p.waitForFunction(()=>document.querySelector('#nationalAVCount')?.textContent==='1');
  await p.waitForFunction(()=>document.querySelector('#nationalAVCount')?.textContent==='0',null,{timeout:12000});
  assert.equal(await p.locator('.national-marker').count(),0,'expired individual position must disappear');
  await p.close();console.log('España: animación, filtro, atribución, conflicto y caducidad OK');

  // Sevilla: independent layer and switch to the latest fix when disabled.
  const local=await page();let localCalls=0;const t=now();
  await local.route('**/api/trenes**',route=>{
    if(route.request().url().includes('ambito=espana'))return route.fulfill({json:response('espana',[])});
    localCalls++;const ld=[vehicle('SEVILLA-AV',localCalls===1?37.39:37.40,-5.98,localCalls===1?t-30:t)];
    const cc=[{id:'local-c',label:'LOCAL-C',latitude:37.37,longitude:-5.99,observed_at:t,time_basis:'vehicle'}];
    return route.fulfill({json:response('sevilla',ld,cc)});
  });
  await local.goto(baseUrl+'/#sevilla',{waitUntil:'domcontentloaded'});await local.waitForFunction(()=>document.querySelector('#liveTotal')?.textContent==='2');
  assert.equal(await local.locator('.real-train-marker').count(),2);assert.equal(await local.locator('.real-train-pin.express').count(),1);
  await local.waitForFunction(()=>document.querySelectorAll('.train-card').length===10,null,{timeout:45000});
  assert.equal(await local.locator('.train-card').count(),10);
  await local.locator('#liveRefresh').click();await local.waitForFunction(()=>document.querySelector('.real-train-marker.is-interpolating'));
  await local.waitForTimeout(1000);const between=await getLat(local,'map','SEVILLA-AV');assert.ok(between>37.39&&between<37.40);
  await local.locator('#liveAnimate').uncheck();assert.ok(Math.abs((await getLat(local,'map','SEVILLA-AV'))-37.40)<1e-9);
  await local.close();console.log('Sevilla: observaciones independientes y simulación OK');

  const reduced=await page({reducedMotion:'reduce'});await reduced.route('**/api/trenes**',route=>route.fulfill({json:response(route.request().url().includes('espana')?'espana':'sevilla',[])}));
  await reduced.goto(baseUrl+'/',{waitUntil:'domcontentloaded'});await nationalReady(reduced);assert.equal(await reduced.locator('#nationalAnimate').isChecked(),false);
  await reduced.locator('#showSevilla').click();assert.equal(await reduced.locator('#liveAnimate').isChecked(),false);await reduced.close();

  const mobile=await page({viewport:{width:390,height:844}});await mobile.route('**/api/trenes**',route=>route.fulfill({json:response(route.request().url().includes('espana')?'espana':'sevilla',[])}));
  await mobile.goto(baseUrl+'/',{waitUntil:'domcontentloaded'});await nationalReady(mobile);
  const widths=await mobile.evaluate(()=>[document.documentElement.clientWidth,document.documentElement.scrollWidth]);assert.ok(widths[1]<=widths[0]+1);await mobile.close();
  console.log('Movimiento reducido y móvil OK');

  const standalone=await page({viewport:{width:1280,height:820}});await standalone.context().setOffline(true);
  await standalone.goto(pathToFileURL(resolve('simulador.html')).href,{waitUntil:'domcontentloaded'});await nationalReady(standalone);
  await standalone.waitForFunction(()=>document.querySelector('#nationalLiveBadge')?.textContent==='SIN DATOS');
  assert.equal(await standalone.locator('.national-marker').count(),0);assert.equal(await standalone.locator('#ltvBadge').innerText(),'INSTANTÁNEA');
  await standalone.locator('#showSevilla').click();
  await standalone.waitForFunction(()=>document.querySelectorAll('.train-card').length===10,null,{timeout:45000});
  assert.equal(await standalone.locator('.train-card').count(),10);await standalone.close();
  console.log('HTML autocontenido sin red OK');

  const isolated=await page({viewport:{width:1200,height:800}});
  await isolated.route('**/api/**',route=>route.abort());
  await isolated.setContent(`<iframe title="demo" sandbox="allow-scripts" src="${baseUrl}/simulador.html" style="width:1100px;height:750px"></iframe>`);
  const frame=await (await isolated.$('iframe')).contentFrame();await nationalReady(frame);
  await frame.waitForFunction(()=>document.querySelector('#nationalLiveBadge')?.textContent==='SIN DATOS',null,{timeout:30000});
  assert.equal(await frame.locator('#ltvBadge').innerText(),'INSTANTÁNEA');
  await frame.locator('#showSevilla').click();
  await frame.waitForFunction(()=>document.querySelectorAll('.train-card').length===10,null,{timeout:45000});
  assert.equal(await frame.locator('.train-card').count(),10);await isolated.close();
  console.log('Visor aislado: datos estáticos y simulación OK');
  assert.deepEqual(errors,[],`Errores JavaScript: ${errors.join('; ')}`);
} finally {await browser.close();}
