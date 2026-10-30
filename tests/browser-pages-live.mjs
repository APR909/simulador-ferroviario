// Optional live smoke test: no fixtures, counts naturally vary with time.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
const base=process.env.VIALAB_STATIC_URL||'http://127.0.0.1:8001';
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
try {
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',async r=>{if(r.url().startsWith('https://radardetrenes.com/api/v1/fleet'))console.log('Radar:',r.status(),'CORS:',(await r.allHeaders())['access-control-allow-origin']);});
 await page.goto(base+'/',{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>document.querySelector('#nationalWayCount')?.textContent==='45.695',{timeout:60000});
 await page.waitForFunction(()=>!document.querySelector('#nationalAVStatus')?.textContent.includes('Consultando'),{timeout:40000});
 const status=await page.locator('#nationalAVStatus').innerText(),cc=await page.locator('#nationalCCStatus').innerText();
 console.log('AV/LD/MD:',await page.locator('#nationalAVCount').innerText(),status);
 console.log('Cercanías:',await page.locator('#nationalCCCount').innerText(),cc);
 console.log('Alta velocidad:',await page.locator('#nationalExpressCount').innerText());
 console.log('Cancelaciones:',await page.locator('#cancelBadge').innerText(),'LTV:',await page.locator('#ltvBadge').innerText());
 assert.match(status,/RadarDeTrenes/);assert.match(status,/consulta directa desde el navegador/);
 assert.match(cc,/RadarDeTrenes/);assert.equal(await page.locator('#cancelBadge').innerText(),'SIN SERVIDOR');
 assert.equal(await page.locator('#ltvBadge').innerText(),'INSTANTÁNEA');assert.deepEqual(errors,[]);
} finally {await browser.close();}
