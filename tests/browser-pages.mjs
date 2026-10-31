// Optional integration check for a static GitHub-Pages-like HTTP server.
// Start: python3 -m http.server 8001 --bind 127.0.0.1
// Then:  node tests/browser-pages.mjs
// Fixtures are synthetic; they are never published as real train positions.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.VIALAB_STATIC_URL||'http://127.0.0.1:8001';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
let errors=[];
async function makePage(){const p=await browser.newPage({viewport:{width:1440,height:900}});p.setDefaultTimeout(30000);p.on('pageerror',e=>errors.push(e.message));
  await p.addInitScript(()=>{let value;window.__testMaps={};Object.defineProperty(window,'L',{configurable:true,get(){return value},set(v){value=v;if(v?.map){const old=v.map;v.map=(id,...a)=>{const map=old(id,...a);window.__testMaps[id]=map;return map}}}})});return p;}
async function ready(p){await p.waitForFunction(()=>document.querySelector('#nationalWayCount')?.textContent==='45.695',null,{timeout:60000});}
const markerLat=(p,id)=>p.evaluate(id=>Object.values(window.__testMaps.nationalMap._layers).find(m=>m.options?.title?.includes(id))?.getLatLng().lat,id);
try {
  const p=await makePage();let radarCalls=0,baseTime=Math.floor(Date.now()/1000);
  await p.route(url=>url.origin==='https://radardetrenes.com'&&url.pathname==='/api/v1/fleet',route=>{
    radarCalls++;const now=Math.floor(Date.now()/1000),iso=n=>new Date(n*1000).toISOString();
    const trains=[{id:'ld-SINTETICO',trainCode:'SINTETICO',type:'long_distance',latitude:radarCalls===1?37.39:37.40,longitude:-5.98,
      timestamp:iso(radarCalls===1?baseTime-25:baseTime),productName:'Alta Velocidad',productCategory:'AV',originName:'Madrid <img src=x>',destinationName:'Sevilla'},
      {id:'ld-MD',trainCode:'SINTETICO-MD',type:'long_distance',latitude:40.4,longitude:-3.7,timestamp:iso(baseTime),productName:'Media Distancia'},
      {id:'c-SINTETICO',trainCode:'SINTETICO-C',type:'commuter',latitude:37.38,longitude:-5.99,timestamp:iso(baseTime),productName:'Cercanías'}];
    return route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify({count:trains.length,trains,updatedAt:iso(now)})});
  });
  await p.goto(base+'/',{waitUntil:'domcontentloaded'});await ready(p);
  await p.waitForFunction(()=>document.querySelector('#nationalAVCount')?.textContent==='2');
  await p.waitForFunction(()=>document.querySelector('#nationalCCCount')?.textContent==='1');
  assert.equal(radarCalls,1,'Sevilla y España deben compartir una sola consulta a Radar');
  assert.match(await p.locator('#nationalAVStatus').innerText(),/RadarDeTrenes.*consulta directa desde el navegador/);
  assert.match(await p.locator('#nationalCCStatus').innerText(),/sin hora GPS individual verificada/);
  assert.equal(await p.locator('#nationalLiveBadge').innerText(),'COBERTURA PARCIAL');
  await p.waitForFunction(()=>document.querySelector('#cancelBadge')?.textContent==='SIN SERVIDOR');
  assert.equal(await p.locator('#ltvBadge').innerText(),'INSTANTÁNEA');
  await p.locator('#nationalExpressOnly').check();assert.equal(await p.locator('.national-marker').count(),1);
  await p.locator('#nationalExpressOnly').uncheck();
  assert.equal(await markerLat(p,'SINTETICO'),37.39);
  // Wait for the ordinary 30 s poll rather than modifying browser clocks;
  // requestAnimationFrame and performance.now must share a time base.
  await p.waitForFunction(()=>document.querySelector('.national-marker.is-interpolating'),null,{timeout:45000});
  await p.waitForTimeout(1000);const lat=await markerLat(p,'SINTETICO');assert.ok(lat>37.39&&lat<37.40);
  assert.equal(radarCalls,2);await p.locator('#showSevilla').click();
  await p.waitForFunction(()=>document.querySelector('#liveTotal')?.textContent==='2');
  assert.match(await p.locator('#liveProvider').innerText(),/RadarDeTrenes.*navegador/);
  assert.equal(await p.locator('.train-card').count(),10);await p.close();
  console.log('GitHub Pages simulado: 404 de API propia, fallback, caché, filtros y animación OK');

  const bad=await makePage();await bad.route(url=>url.origin==='https://radardetrenes.com'&&url.pathname==='/api/v1/fleet',route=>route.fulfill({status:503,headers:{'Access-Control-Allow-Origin':'*'},body:'offline'}));
  await bad.goto(base+'/',{waitUntil:'domcontentloaded'});await ready(bad);
  await bad.waitForFunction(()=>document.querySelector('#nationalLiveBadge')?.textContent==='SIN DATOS');
  assert.equal(await bad.locator('#nationalAVCount').innerText(),'—');assert.equal(await bad.locator('.national-marker').count(),0);
  await bad.close();console.log('Sin Radar: no se muestra un cero ficticio OK');
  assert.deepEqual(errors,[],`Errores JavaScript: ${errors.join('; ')}`);
} finally {await browser.close();}
