import { buildGraph, shortestPath } from './graph.js';
import { pointAt, sliceRoute } from './geo.js';
import { buildDemoScenario, makeCustomScenarioLine } from './scenario.js';
import { MultiSimulation } from './multiline.js';
import { LIVE_POLL_MS, summarizeLive, isExpressService } from './realtime.js?v=12';
import { fetchLivePositions } from './live-source.js?v=12';
import { createLiveMotionLayer, createLiveTrainIcon, liveIconKind } from './live-motion.js?v=12';
import { initializeNationalMap } from './national.js?v=12';
import { initializeTimetableView } from './timetable-ui.js?v=13';
import { initializeInfrastructure, infrastructureTrackPopup } from './infrastructure.js?v=12';
import { initializeTheme } from './theme.js?v=12';

initializeTheme();

const $ = id => document.getElementById(id);
const STEP = 0.1;
const map = L.map('map', { zoomControl: false, preferCanvas: true, zoomSnap: 0.5, maxZoom: 19 }).setView([37.39, -5.98], 11);
L.control.zoom({ position: 'topright' }).addTo(map);
// OSM geometry is bundled and remains usable without the optional basemap.
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';
const BASE_ATTRIBUTION = '<a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> &copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a>';
map.attributionControl.addAttribution(OSM_ATTRIBUTION);
const networkLayers = { rail:L.layerGroup(), subway:L.layerGroup(), tram:L.layerGroup() };
const networkLayer = L.layerGroup(Object.values(networkLayers)).addTo(map);
const stationLayer = L.layerGroup();
const routeLayer = L.layerGroup().addTo(map);
const trainLayer = L.layerGroup().addTo(map);
const liveLayer = L.layerGroup().addTo(map);
const selectionLayer = L.layerGroup().addTo(map);

let bundledData, graph=null, sim=null;
let scenarioLines=[], trainConfigs=[], customLineNumber=0;
let running=false, rate=4, picking=false, pickedOrigin=null, datasetLabel='';
let focusOnFirstPlay=true, trainMarkers=new Map(), trainBodies=new Map();
let lastBlockKey='', lastRender=0, previousFrame=null, accumulated=0, dataLoadSequence=0;

function setNotice(message,kind='') {
  $('noticeText').textContent=message;
  $('mapNotice').className='map-notice'+(kind ? ` ${kind}` : '');
}
function setPicking(value) {
  picking=value; pickedOrigin=null; selectionLayer.clearLayers();
  $('routeButton').classList.toggle('active',value);
  $('routeButton').setAttribute('aria-pressed',String(value));
  $('cancelRoute').hidden=!value;
  $('map').classList.toggle('route-picking',value);
  if (value) {
    setRunning(false);
    setNotice('Elige origen y destino; añadir la línea reinicia el escenario.', 'warn');
  } else if (sim) setNotice('Servicios y horarios ficticios, independientes de Renfe.');
  else setNotice('Elige un recorrido para empezar.', 'warn');
}
function setRunning(value) {
  running=Boolean(value && sim); accumulated=0;
  $('statePill').classList.toggle('running',running);
  $('statePill').innerHTML=`<span class="pill-dot"></span> ${running ? 'EN MARCHA' : 'EN PAUSA'}`;
  $('playButton').querySelector('span').textContent=running ? 'Pausar simulación' : 'Iniciar simulación';
  $('playIcon').innerHTML=running ? '<path d="M5.5 4h3v12h-3zm6 0h3v12h-3z"/>' : '<path d="M6 3.8v12.4L16 10 6 3.8Z"/>';
  if (running && !picking) setNotice('Simulación activa · líneas, horarios y reservas ficticios.');
}
function setDisabled() {
  for (const id of ['playButton','resetButton','incidentButton','delayButton','managedTrain','applyPlan']) $(id).disabled=!sim;
  $('routeButton').disabled=!graph; $('fitButton').disabled=!graph; $('fitRouteButton').disabled=!sim;
}
function km(metres) {
  return (metres/1000).toLocaleString('es-ES',{minimumFractionDigits:1,maximumFractionDigits:1})+' km';
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
}
function timeString(seconds) {
  const value=(8*3600+Math.floor(seconds))%86400;
  return [Math.floor(value/3600),Math.floor(value/60)%60,value%60].map(x=>String(x).padStart(2,'0')).join(':');
}
function nearestNode(latlng) {
  const point=map.latLngToContainerPoint(latlng);
  let best=null,bestDistance=30;
  for (const [id,node] of graph.nodes) {
    if (!(graph.adj.get(id)?.length)) continue;
    const distance=point.distanceTo(map.latLngToContainerPoint([node.lat,node.lon]));
    if (distance<bestDistance) { bestDistance=distance; best=id; }
  }
  return best;
}
function fitCurrent() {
  if (graph?.lines.length) map.fitBounds(L.latLngBounds(graph.lines.flat()),{padding:[35,35],maxZoom:16,animate:false});
}
function fitRoute() {
  if (!sim?.lines.length) return;
  const points=sim.lines.flatMap(line=>line.route.points.map(point=>[point.lat,point.lon]));
  map.fitBounds(L.latLngBounds(points),{padding:[60,60],maxZoom:16.5,animate:false});
}
function fitLine(id) {
  const line=sim?.lineById.get(id);
  if (line) {
    map.fitBounds(L.latLngBounds(line.route.points.map(p=>[p.lat,p.lon])),{padding:[65,65],maxZoom:16.5,animate:false});
    if (window.matchMedia('(max-width:650px)').matches) document.querySelector('.map-wrap').scrollIntoView({behavior:'smooth',block:'center'});
  }
}
function railwayGroup(type) {
  return type==='tram' ? 'tram' : (type==='subway'||type==='light_rail') ? 'subway' : 'rail';
}
function drawNetwork() {
  for (const layer of Object.values(networkLayers)) layer.clearLayers();
  const dark=document.documentElement.dataset.theme==='dark';
  const styles=dark
    ? {rail:{color:'#9fc3b0',weight:2.6,opacity:.88},subway:{color:'#d1aaee',weight:3.5,opacity:.94},tram:{color:'#ffbd7f',weight:3.5,opacity:.95}}
    : {rail:{color:'#526e65',weight:2.6,opacity:.86},subway:{color:'#8d60af',weight:3.5,opacity:.94},tram:{color:'#d77d3c',weight:3.5,opacity:.95}};
  for (const line of graph.lineRecords) {
    const group=railwayGroup(line.tags.railway);
    const path=L.polyline(line.points,{...styles[group],interactive:true});
    path.on('click',event=>{
      if (picking) return; // Let the map select a node while adding a route.
      L.popup().setLatLng(event.latlng).setContent(infrastructureTrackPopup({id:line.wayId,tags:line.tags,name:line.tags.name})).openOn(map);
    });
    path.addTo(networkLayers[group]);
  }
} 
window.addEventListener('vialab:themechange',()=>{if (graph) drawNetwork();});
initializeInfrastructure(map,'local',{canOpen:()=>!picking});
function drawStations(data) {
  stationLayer.clearLayers(); const seen=new Set();
  for (const station of data.stations || []) {
    if (!Number.isFinite(station.lat)||!Number.isFinite(station.lon)||!station.tags?.name) continue;
    const key=`${station.tags.name}:${station.lat.toFixed(3)}:${station.lon.toFixed(3)}:${station.tags.railway}`;
    if (seen.has(key)) continue; seen.add(key);
    const tooltip=document.createElement('span'); tooltip.textContent=station.tags.name;
    L.circleMarker([station.lat,station.lon],{radius:3,weight:1.5,color:'#fff',fillColor:'#466b60',fillOpacity:.95}).bindTooltip(tooltip).addTo(stationLayer);
  }
  updateStations();
}
function updateStations() {
  if (map.getZoom()>=12) { if (!map.hasLayer(stationLayer)) stationLayer.addTo(map); }
  else if (map.hasLayer(stationLayer)) map.removeLayer(stationLayer);
}
map.on('zoomend',updateStations);
for (const checkbox of document.querySelectorAll('[data-layer]')) {
  checkbox.addEventListener('change',()=>{
    const layer=networkLayers[checkbox.dataset.layer]; if (!layer) return;
    if (checkbox.checked) networkLayer.addLayer(layer); else networkLayer.removeLayer(layer);
  });
}
const TRAIN_SVG='<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="5" y="3" width="10" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 8.5h9M7 17l1.2-2m4.8 2-1.2-2M7.4 12.1h.1m5.1 0h.1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
function mapTrainIcon(train) {
  const html=`<div class="train-pin" style="--train-color:${train.line.color}"><span class="train-pin-bubble">${TRAIN_SVG}</span><span class="train-pin-label">SIM ${train.id}</span></div>`;
  return L.divIcon({className:'train-marker',html,iconSize:[68,29],iconAnchor:[14,14]});
}
function drawRoutes() {
  routeLayer.clearLayers(); trainLayer.clearLayers(); trainMarkers=new Map(); trainBodies=new Map(); lastBlockKey='';
  if (!sim) return;
  // The L3 dashes leave L2 visible where their OSM geometry overlaps.
  for (const line of sim.lines) L.polyline(line.route.points.map(p=>[p.lat,p.lon]),{color:'#fff',opacity:.75,weight:9,interactive:false}).addTo(routeLayer);
  for (const line of sim.lines) L.polyline(line.route.points.map(p=>[p.lat,p.lon]),{color:line.color,opacity:.95,weight:line.dash ? 4 : 5,dashArray:line.dash||null,interactive:false}).addTo(routeLayer);
  for (const train of sim.trains) {
    const body=L.polyline([],{color:train.line.color,weight:9,opacity:1,interactive:false});
    // The simulated pins have no click action; leave the underlying OSM
    // switches and track details accessible even when a pin overlaps them.
    const marker=L.marker(pointAt(train.line.route,0),{icon:mapTrainIcon(train),keyboard:false,interactive:false,zIndexOffset:1000,title:`SIM ${train.id} · ${train.lineId}`});
    trainBodies.set(train.id,body); trainMarkers.set(train.id,marker);
  }
}
function createCards() {
  if (!sim) {
    $('lineCount').textContent='00'; $('trainCount').textContent='00';
    $('lineCards').innerHTML='<p class="empty-small">Sin líneas seleccionadas.</p>';
    $('trainCards').innerHTML='<p class="empty-small">Selecciona un recorrido para crear trenes.</p>';
    $('managedTrain').innerHTML=''; $('planRows').innerHTML=''; return;
  }
  const previous=$('managedTrain').value;
  $('lineCount').textContent=String(sim.lines.length).padStart(2,'0');
  $('trainCount').textContent=String(sim.trains.length).padStart(2,'0');
  $('lineCards').innerHTML=sim.lines.map(line=>`<button type="button" class="line-card" data-line-id="${line.id}" style="--line-color:${line.color}" title="Centrar ${line.name}"><span class="line-swatch"></span><span class="line-copy"><span class="line-name"><b>${line.id}</b>${line.name}</span><span class="line-sub">${km(line.route.length)} · ficticia</span></span><span class="line-count" id="line-status-${line.id}">—</span></button>`).join('');
  $('trainCards').innerHTML=sim.trains.map(train=>`<button type="button" class="train-card" data-train-id="${train.id}" id="train-${train.id}" title="Gestionar tren ${train.id}" style="--train-color:${train.line.color}"><span class="train-icon">${TRAIN_SVG}</span><span><span class="train-name">SIM ${train.id}<span class="train-role">${train.lineId}</span></span><span class="train-status" id="status-${train.id}">Preparado</span></span><span class="train-speed"><strong id="speed-${train.id}">0</strong> <span>km/h</span></span></button>`).join('');
  $('managedTrain').innerHTML=sim.trains.map(train=>`<option value="${train.id}">SIM ${train.id} · ${train.lineId} ${train.line.shortName}</option>`).join('');
  if (sim.trainById.has(previous)) $('managedTrain').value=previous;
  $('planRows').innerHTML=trainConfigs.map(config=>`<div class="plan-row"><span class="plan-train">SIM ${config.id}<small>${config.lineId}</small></span><input type="number" min="5" max="160" step="1" value="${config.speedKmh}" data-plan-speed="${config.id}" aria-label="Velocidad máxima del tren ${config.id} en kilómetros por hora"><input type="number" min="0" max="86400" step="1" value="${config.departureSeconds}" data-plan-depart="${config.id}" aria-label="Salida del tren ${config.id} en segundos desde las ocho"></div>`).join('');
}
function updateBlocks() {
  if (!sim) { $('blockStrip').innerHTML='<span class="empty-small">Sin tramos compartidos.</span>'; $('dockSummary').textContent='—'; $('dispatchEvent').textContent='Sin movimientos todavía.'; return; }
  const key=sim.sharedResources.map(resource=>`${resource.owner||'-'}:${resource.occupiedBy||'-'}`).join('|');
  if (key!==lastBlockKey) {
    lastBlockKey=key;
    const resources=[...sim.sharedResources].sort((a,b)=>Number(Boolean(b.occupiedBy))-Number(Boolean(a.occupiedBy))||Number(Boolean(b.owner))-Number(Boolean(a.owner))||a.label.localeCompare(b.label));
    $('blockStrip').innerHTML=resources.length ? resources.map(resource=>{
      const state=resource.occupiedBy ? 'occupied' : resource.owner ? 'reserved' : 'free';
      const status=resource.occupiedBy ? `Ocup. ${resource.occupiedBy}` : resource.owner ? `Res. ${resource.owner}` : 'Libre';
      const title=`${resource.kind==='junction' ? 'Cruce' : 'Tramo'} OSM ${resource.key.slice(2)} · líneas ${[...resource.lineIds].join(', ')}`;
      return `<div class="block-chip ${state}" title="${escapeHtml(title)}"><span class="block-id">${resource.label}</span><span class="block-owner">${status}</span></div>`;
    }).join('') : '<span class="empty-small">Estas líneas no comparten nodos o tramos OSM.</span>';
  }
  const occupied=sim.sharedResources.filter(resource=>resource.occupiedBy).length;
  const reserved=sim.sharedResources.filter(resource=>resource.owner&&!resource.occupiedBy).length;
  const waiting=sim.trains.filter(train=>sim.status(train).startsWith('Espera')).length;
  $('dockSummary').textContent=`${occupied} ocupados · ${reserved} reservados · ${waiting} trenes esperando`;
  const event=sim.events.at(-1);
  $('dispatchEvent').textContent=event ? `${timeString(event.time)} · ${event.text}` : 'Sin movimientos todavía.';
}
function render() {
  $('clock').textContent=timeString(sim?.elapsed||0);
  if (!sim) { setDisabled(); updateBlocks(); return; }
  for (const line of sim.lines) {
    const active=sim.trains.filter(train=>train.lineId===line.id && train.phase==='active').length;
    const element=$(`line-status-${line.id}`); if (element) element.textContent=`${active} en vía`;
  }
  for (const train of sim.trains) {
    const speed=$(`speed-${train.id}`),status=$(`status-${train.id}`),card=$(`train-${train.id}`);
    if (speed) speed.textContent=Math.round(train.speed*3.6);
    if (status) {
      const text=sim.status(train);
      const display=running ? text : train.phase==='active' && sim.elapsed<STEP && !train.incident ? 'Listo · simulación en pausa' : `Pausa · ${text}`;
      status.textContent=`${display} · ${train.completedTrips} ${train.completedTrips===1 ? 'pasada' : 'pasadas'}`;
      status.title=text;
    }
    card?.classList.toggle('selected',train.id===$('managedTrain').value);
    const marker=trainMarkers.get(train.id),body=trainBodies.get(train.id),route=train.line.route;
    const showMarker=train.phase==='active' && train.head<=route.length;
    const showBody=train.phase==='active' && train.head-train.length<route.length;
    if (marker && showMarker) { marker.setLatLng(pointAt(route,train.head)); if (!trainLayer.hasLayer(marker)) marker.addTo(trainLayer); }
    else if (marker && trainLayer.hasLayer(marker)) trainLayer.removeLayer(marker);
    if (body && showBody) { body.setLatLngs(sliceRoute(route,train.head-train.length,train.head)); if (!trainLayer.hasLayer(body)) body.addTo(trainLayer); }
    else if (body && trainLayer.hasLayer(body)) trainLayer.removeLayer(body);
  }
  const selected=sim.trainById.get($('managedTrain').value),incident=Boolean(selected?.incident);
  $('incidentButton').classList.toggle('active',incident);
  $('incidentButton').setAttribute('aria-pressed',String(incident));
  $('incidentButton').querySelector('.incident-label').textContent=incident ? 'Resolver incidencia' : 'Simular incidencia';
  $('incidentButton').querySelector('.incident-symbol').textContent=incident ? '−' : '＋';
  updateBlocks(); setDisabled();
}
function createSimulation(lines,configs,{focus=true}={}) {
  // Construct first: a rejected route must leave the current scenario intact.
  const next=new MultiSimulation(graph,lines,configs);
  scenarioLines=lines; trainConfigs=configs.map(config=>({...config})); sim=next; focusOnFirstPlay=true;
  setRunning(false); setPicking(false);
  $('routeLength').textContent=`${sim.lines.length} líneas`;
  $('blockCount').textContent=`${sim.trains.length} trenes`;
  $('routeDescription').textContent=`${km(sim.lines.reduce((sum,line)=>sum+line.route.length,0))} de recorridos · pueden solaparse`;
  drawRoutes(); createCards(); render();
  if (focus) fitRoute();
}
function loadGraph(data,label,isSample=false) {
  const nextGraph=buildGraph(data);
  if (nextGraph.edges.size>30000) throw new Error('La zona es demasiado grande para este prototipo. Importa un área más pequeña.');
  const nextScenario=isSample ? buildDemoScenario(data,nextGraph) : null;
  if (nextScenario) new MultiSimulation(nextGraph,nextScenario.lines,nextScenario.trains);
  graph=nextGraph; datasetLabel=label; sim=null; scenarioLines=[]; trainConfigs=[]; customLineNumber=0;
  setRunning(false); setPicking(false); drawNetwork(); drawStations(data); drawRoutes(); createCards();
  $('datasetName').textContent=label; $('mapArea').textContent=isSample ? 'Sevilla metropolitana' : label;
  $('networkMeta').textContent=`${graph.wayCount.toLocaleString('es-ES')} fragmentos · ${graph.nodes.size.toLocaleString('es-ES')} nodos`;
  $('routeLength').textContent='—'; $('blockCount').textContent='sin líneas'; $('routeDescription').textContent='Selecciona origen y destino';
  render();
  if (nextScenario) {
    createSimulation(nextScenario.lines,nextScenario.trains,{focus:true});
    setNotice('Cinco líneas ficticias listas. Selecciona «Iniciar simulación».');
  } else {
    fitCurrent(); setPicking(true);
    if (graph.missingReferences) setNotice(`Faltan ${graph.missingReferences} referencias a nodos. Elige un origen en la red disponible.`, 'warn');
  }
}

$('playButton').addEventListener('click',()=>{
  if (picking) setPicking(false);
  setRunning(!running);
  if (running && focusOnFirstPlay) {
    fitRoute(); focusOnFirstPlay=false;
    if (window.matchMedia('(max-width:650px)').matches) {
      const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      document.querySelector('.map-wrap').scrollIntoView({behavior:reduce ? 'auto' : 'smooth',block:'center'});
    }
  }
  render();
});
$('resetButton').addEventListener('click',()=>{
  if (!sim) return;
  try { createSimulation(scenarioLines,trainConfigs,{focus:false}); setNotice('Escenario reiniciado con el plan actual.'); }
  catch (error) { setNotice(error.message,'error'); }
});
$('managedTrain').addEventListener('change',render);
$('trainCards').addEventListener('click',event=>{
  const card=event.target.closest('[data-train-id]'); if (!card || !sim) return;
  $('managedTrain').value=card.dataset.trainId; render();
});
$('lineCards').addEventListener('click',event=>{
  const card=event.target.closest('[data-line-id]'); if (card) fitLine(card.dataset.lineId);
});
$('incidentButton').addEventListener('click',()=>{
  const train=sim?.trainById.get($('managedTrain').value); if (!train) return;
  const active=!train.incident; sim.setIncident(train.id,active);
  setNotice(active ? `Incidencia ficticia: el tren ${train.id} frenará o esperará.` : `Incidencia del tren ${train.id} resuelta.`,active ? 'warn' : '');
  render();
});
$('delayButton').addEventListener('click',()=>{
  const train=sim?.trainById.get($('managedTrain').value); if (!train) return;
  sim.delayTrain(train.id,60);
  setNotice(`Retardo ficticio de 60 s aplicado al tren ${train.id}.`,'warn'); render();
});
$('applyPlan').addEventListener('click',()=>{
  if (!sim) return;
  try {
    const configs=trainConfigs.map(config=>{
      const speed=document.querySelector(`[data-plan-speed="${config.id}"]`), depart=document.querySelector(`[data-plan-depart="${config.id}"]`);
      if (!speed || !depart || speed.value.trim()==='' || depart.value.trim()==='') throw new Error('Completa todas las velocidades y salidas.');
      return {...config,speedKmh:Number(speed.value),departureSeconds:Number(depart.value)};
    });
    if (configs.some(config=>!Number.isFinite(config.speedKmh)||config.speedKmh<5||config.speedKmh>160||!Number.isInteger(config.departureSeconds)||config.departureSeconds<0||config.departureSeconds>86400)) throw new Error('Usa 5–160 km/h y salidas enteras entre 0 y 86400 s.');
    createSimulation(scenarioLines,configs,{focus:false}); setNotice('Plan aplicado; escenario reiniciado en pausa.');
  } catch (error) { setNotice(error.message,'error'); }
});
for (const button of document.querySelectorAll('[data-rate]')) {
  button.setAttribute('aria-pressed',button.classList.contains('active') ? 'true' : 'false');
  button.addEventListener('click',()=>{
    rate=Number(button.dataset.rate);
    for (const item of document.querySelectorAll('[data-rate]')) { item.classList.toggle('active',item===button); item.setAttribute('aria-pressed',String(item===button)); }
  });
}
$('fitButton').addEventListener('click',fitCurrent);
$('fitRouteButton').addEventListener('click',fitRoute);
$('routeButton').addEventListener('click',()=>setPicking(!picking));
$('cancelRoute').addEventListener('click',()=>setPicking(false));
$('restoreSample').addEventListener('click',()=>{
  dataLoadSequence++;
  try { loadGraph(bundledData,'Sevilla metropolitana · OSM',true); setNotice('Escenario de Sevilla restaurado.'); }
  catch (error) { setNotice(error.message,'error'); }
});
$('osmFile').addEventListener('change',async event=>{
  const file=event.target.files?.[0]; if (!file) return;
  const sequence=++dataLoadSequence;
  try {
    if (file.size>15000000) throw new Error('Archivo demasiado grande: el límite del prototipo es 15 MB.');
    const data=JSON.parse(await file.text()); if (sequence!==dataLoadSequence) return;
    loadGraph(data,file.name,false);
  } catch (error) { if (sequence===dataLoadSequence) setNotice(`No se pudo importar: ${error.message}`,'error'); }
  finally { event.target.value=''; }
});
map.on('click',event=>{
  if (!picking || !graph) return;
  const id=nearestNode(event.latlng);
  if (!id) { setNotice('Haz clic más cerca de un nodo de vía; amplía el mapa si hace falta.','warn'); return; }
  const node=graph.nodes.get(id);
  if (!pickedOrigin) {
    pickedOrigin=id; selectionLayer.clearLayers();
    L.circleMarker([node.lat,node.lon],{radius:7,fillColor:'#2a8a78',color:'#fff',weight:3,fillOpacity:1,interactive:false}).addTo(selectionLayer);
    setNotice('Origen seleccionado. Ahora haz clic en el destino.','warn'); return;
  }
  if (id===pickedOrigin) { setNotice('El destino debe ser diferente del origen.','warn'); return; }
  const path=shortestPath(graph,pickedOrigin,id);
  if (!path) { setNotice('No hay conexión por nodos OSM entre esos puntos. Prueba otro destino.','error'); return; }
  try {
    const number=customLineNumber+1;
    const added=makeCustomScenarioLine(graph,path,number,[`U${number}A`,`U${number}B`]);
    createSimulation([...scenarioLines,added.line],[...trainConfigs,...added.trains]);
    customLineNumber=number;
    setNotice(`Línea ${added.line.id} añadida. Escenario reiniciado; recorrido no validado.`,'warn');
  } catch (error) { setNotice(error.message,'error'); }
});

// Renfe GTFS-RT positions are separate from the fictitious simulation. The
// browser calls only our same-origin fixed-URL proxy; it never calls localhost.
let livePayload = null, liveReceivedAt = 0, liveBusy = false, lastLiveKey = '';
const liveClock = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function displayLiveTime(value) {
  if (!Number.isFinite(value) || value <= 0) return 'hora desconocida';
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? liveClock.format(date) : 'hora desconocida';
}
function liveSourceName(source) {
  return source === 'cercanias' ? 'Cercanías' : 'AV / Larga y Media Distancia';
}
function localLivePopup(vehicle) {
  const popup=document.createElement('div');popup.className='live-popup';
  const caption=document.createElement('small');
  caption.textContent=vehicle.source_provider==='radar' ? 'RENFE · VÍA RADARDETRENES (INDEPENDIENTE)' : `RENFE · ${liveSourceName(vehicle.source).toUpperCase()}`;
  const heading=document.createElement('strong');
  heading.textContent=`${vehicle.service_name ? vehicle.service_name+' · ' : ''}${vehicle.label || vehicle.id || 'Vehículo'}`;
  const detail=document.createElement('p');
  detail.textContent=`${vehicle.time_basis==='feed' ? 'Hora del feed (sin hora GPS individual)' : 'Última posición GPS'}: ${displayLiveTime(vehicle.observed_at)}`;
  const coordinates=document.createElement('p');
  coordinates.textContent=`Último punto observado: ${vehicle.latitude.toFixed(5)}, ${vehicle.longitude.toFixed(5)}`;
  popup.append(caption,heading,detail,coordinates);
  if(vehicle.origin || vehicle.destination){const p=document.createElement('p');p.textContent=`Trayecto: ${vehicle.origin || '—'} → ${vehicle.destination || '—'}`;popup.append(p);}
  if(vehicle.trip_id){const p=document.createElement('p');p.textContent=`Viaje: ${vehicle.trip_id}`;popup.append(p);}
  const caution=document.createElement('p');caution.className='live-motion-caution';
  caution.textContent='El movimiento entre GPS es una estimación en línea recta; no necesariamente sigue la vía y no es la posición exacta. Se detiene en el último punto recibido.';
  popup.append(caution);return popup;
}
function localLiveMarker(vehicle) {
  const marker=L.marker([vehicle.latitude,vehicle.longitude],{
    icon:createLiveTrainIcon(vehicle,'local'),title:`Renfe ${liveSourceName(vehicle.source)}: ${vehicle.label || vehicle.id}`,
    alt:`Tren Renfe ${vehicle.label || vehicle.id}; movimiento estimado`,zIndexOffset:2500,
  }).bindPopup(localLivePopup(vehicle));
  marker.__liveKind=liveIconKind(vehicle);return marker;
}
function updateLocalLiveMarker(marker,vehicle) {
  marker.setPopupContent(localLivePopup(vehicle));
  const kind=liveIconKind(vehicle);if(kind!==marker.__liveKind){marker.setIcon(createLiveTrainIcon(vehicle,'local'));marker.__liveKind=kind;}
}
const localAnimate=$('liveAnimate');
if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)localAnimate.checked=false;
const localMotion=createLiveMotionLayer({layer:liveLayer,createMarker:localLiveMarker,updateMarker:updateLocalLiveMarker,
  isVisible:()=>!$('sevillaView').hidden,isEnabled:()=>localAnimate.checked});
localAnimate.addEventListener('change',()=>localMotion.setEnabled(localAnimate.checked));
function feedStatus(feed) {
  if (feed.status === 'stale') return `Dato atrasado · ${displayLiveTime(feed.header_timestamp)}`;
  if (feed.status === 'error') return 'No disponible';
  const notes=[];
  if(feed.excluded_stale)notes.push(`${feed.excluded_stale} antigua(s) excluida(s)`);
  if(feed.excluded_ambiguous)notes.push(`${feed.excluded_ambiguous} posición(es) ambigua(s)`);
  if(feed.excluded_reported_stale)notes.push(`${feed.excluded_reported_stale} marcada(s) como antiguas por RadarDeTrenes`);
  if(feed.feed_time_fallback)notes.push(`${feed.feed_time_fallback} sin hora GPS individual verificada`);
  if(feed.access_mode==='browser')notes.push('consulta directa desde el navegador');
  const prefix=feed.source_provider==='radar' ? 'RadarDeTrenes · Renfe' : 'Feed';
  return `${prefix} ${displayLiveTime(feed.header_timestamp)}${notes.length?' · '+notes.join(' · '):''}`;
}
function renderLive() {
  if (!livePayload) return;
  // Age from the server's time plus monotonic time elapsed, rather than relying
  // on the user's clock. Old positions disappear even if refresh is throttled.
  const now = livePayload.generated_at + Math.max(0, (performance.now() - liveReceivedAt) / 1000);
  const summary = summarizeLive(livePayload, now);
  const partial = summary.usable < 2 || [summary.cercanias, summary.larga].some(feed => feed.status === 'partial');
  $('liveTotal').textContent = summary.total === null ? '—' : String(summary.total);
  $('liveCoverage').textContent = summary.usable ? `${summary.usable}/2 fuentes Renfe recientes${partial ? ' · parcial' : ''}` : 'Sin fuentes recientes';
  $('liveBadge').textContent = summary.usable ? (partial ? 'COBERTURA PARCIAL' : 'EN DIRECTO*') : 'SIN DATOS RECIENTES';
  $('liveBadge').className = `live-badge ${!summary.usable ? 'offline' : partial ? 'partial' : 'fresh'}`;
  for (const [feed, countId, statusId] of [
    [summary.cercanias, 'liveCercanias', 'liveCercaniasStatus'],
    [summary.larga, 'liveLarga', 'liveLargaStatus'],
  ]) {
    $(countId).textContent = feed.count === null ? '—' : String(feed.count);
    $(statusId).textContent = feedStatus(feed);
    $(statusId).title = feed.feed_time_fallback
      ? 'Cuando falta la hora de la posición individual se usa la hora de publicación del feed; no garantiza la edad real del GPS.'
      : feed.message || '';
    $(statusId).className = feed.status === 'fresh' ? 'feed-status-ok' : 'feed-status-warn';
  }
  $('liveProvider').textContent=summary.larga.access_mode==='browser'
    ? 'AV / LD / MD y Cercanías: datos de Renfe vía RadarDeTrenes (independiente), consultados desde el navegador.'
    : summary.larga.source_provider==='radar'
      ? `AV / LD / MD: Renfe vía RadarDeTrenes (independiente); ${summary.larga.direct_status==='partial' ? 'feed directo sin posiciones válidas' : 'feed directo atrasado o no disponible'}.`
      : 'AV / LD / MD: feed GTFS-RT directo de Renfe cuando está disponible.';
  const lastFetch = Math.max(summary.cercanias.fetched_at || 0, summary.larga.fetched_at || 0);
  $('liveUpdated').textContent = `Consulta ${displayLiveTime(lastFetch)} · máx. cada 30 s`;
  const key = JSON.stringify(summary.vehicles.map(v => [v.source,v.source_provider,v.id,v.label,v.latitude,v.longitude,v.observed_at,v.time_basis,v.service_name,v.trip_id,v.origin,v.destination,v.origin_code,v.destination_code]));
  if (key !== lastLiveKey) {
    const state=localMotion.update(summary.vehicles);
    $('liveMotionStatus').textContent=state.suppressed
      ? `${state.suppressed} posición(es) con lecturas contradictorias ocultas. Movimiento estimado en línea recta, nunca más allá del último GPS.`
      : 'Movimiento en línea recta estimado entre dos GPS recibidos; puede no seguir la vía y nunca avanza más allá del último dato.';
    lastLiveKey = key;
  }
}
function liveUnavailable(message) {
  livePayload = null; lastLiveKey = ''; localMotion.clear();
  $('liveProvider').textContent='Sin conexión con las fuentes de posiciones.';
  $('liveTotal').textContent = '—'; $('liveCoverage').textContent = 'No se pueden consultar las fuentes';
  $('liveCercanias').textContent = '—'; $('liveLarga').textContent = '—';
  $('liveCercaniasStatus').textContent = 'No disponible'; $('liveLargaStatus').textContent = 'No disponible';
  $('liveCercaniasStatus').className = 'feed-status-warn'; $('liveLargaStatus').className = 'feed-status-warn';
  $('liveBadge').textContent = 'SIN DATOS'; $('liveBadge').className = 'live-badge offline';
  $('liveUpdated').textContent = message;
}
async function refreshLive() {
  if (liveBusy) return;
  liveBusy = true;
  $('liveRefresh').disabled = true;
  // Conservatively include the whole request in the apparent age, so network
  // latency cannot make an old snapshot look recent.
  const requestStartedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const payload = await fetchLivePositions('sevilla', { signal: controller.signal });
    livePayload = payload; liveReceivedAt = requestStartedAt;
    renderLive();
  } catch (_) {
    liveUnavailable('No se pudo consultar la API local ni RadarDeTrenes; revisa la conexión.');
  } finally {
    clearTimeout(timeout); liveBusy = false; $('liveRefresh').disabled = false;
  }
}
$('liveRefresh').addEventListener('click', refreshLive);
setInterval(refreshLive, LIVE_POLL_MS);
setInterval(renderLive, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { renderLive(); localMotion.resume(); refreshLive(); } });
refreshLive();

function animationFrame(now) {
  if (previousFrame !== null && running && sim) {
    accumulated += Math.min(0.25, Math.max(0, (now - previousFrame) / 1000)) * rate;
    try {
      while (accumulated >= STEP) { sim.step(STEP); accumulated -= STEP; }
    } catch (error) {
      setRunning(false);
      setNotice(`Simulación detenida: ${error.message}`, 'error');
      console.error(error);
    }
  }
  previousFrame = now;
  if (now - lastRender >= 100) { render(); lastRender = now; }
  requestAnimationFrame(animationFrame);
}

try {
  const response = window.RAIL_SAMPLE ? null : await fetch('./data/sevilla-osm.json');
  if (response && !response.ok) throw new Error(`HTTP ${response.status}`);
  bundledData = window.RAIL_SAMPLE || await response.json();
  loadGraph(bundledData, 'Sevilla metropolitana · OSM', true);
} catch (error) {
  setNotice(`No se pudieron cargar los datos: ${error.message}. Usa un servidor local.`, 'error');
  console.error(error);
  setDisabled();
}
requestAnimationFrame(animationFrame);

/**
 * OpenFreeMap serves vector tiles without an API key. If the renderer or
 * network is unavailable we keep the included railway data on the grid,
 * instead of displaying blocked raster-tile images.
 */
async function initializeBasemap(targetMap=map, status=$('baseStatusText'), retry=$('baseRetry')) {
  status.textContent = 'Conectando mapa de fondo…';
  status.parentElement.classList.remove('unavailable');
  retry.hidden = true;
  let layer = null;
  let timeout = null;
  let styleTimeout = null;
  let finished = false;
  let ready = false;
  let failures = 0;
  let addedAttribution = false;
  let themeListener = null;
  let switchingStyle = false;
  const styleForTheme = () => document.documentElement.dataset.theme === 'dark'
    ? 'https://tiles.openfreemap.org/styles/dark'
    : 'https://tiles.openfreemap.org/styles/positron';
  let activeStyle = styleForTheme();

  const fallback = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    clearTimeout(styleTimeout);
    if (themeListener) window.removeEventListener('vialab:themechange', themeListener);
    if (layer && targetMap.hasLayer(layer)) {
      try { targetMap.removeLayer(layer); } catch (_) { layer.getContainer?.()?.remove(); }
    }
    if (addedAttribution) targetMap.attributionControl.removeAttribution(BASE_ATTRIBUTION);
    status.textContent = 'Fondo no disponible · vías visibles';
    status.parentElement.classList.add('unavailable');
    retry.hidden = false;
  };

  try {
    // MapLibre 6 requires WebGL2. The simulation itself does not.
    const probe = document.createElement('canvas').getContext('webgl2');
    if (!probe) { fallback(); return; }
    probe.getExtension('WEBGL_lose_context')?.loseContext();

    // Standalone HTML provides Blob URLs; the modular app loads local files.
    const embedded = window.RAIL_BASEMAP_URLS || {};
    const libraryUrl = embedded.library || new URL('../vendor/maplibre-gl.mjs', import.meta.url).href;
    const workerUrl = embedded.worker || new URL('../vendor/maplibre-gl-worker.mjs', import.meta.url).href;
    const pluginUrl = embedded.plugin || new URL('../vendor/leaflet-maplibre-gl.js', import.meta.url).href;
    const maplibre = await import(libraryUrl);
    maplibre.setWorkerUrl(workerUrl);
    window.maplibregl = maplibre;
    await import(pluginUrl);
    if (typeof L.maplibreGL !== 'function') throw new Error('No se cargó el adaptador del mapa.');

    layer = L.maplibreGL({
      style: activeStyle,
      interactive: false,
      attributionControl: false,
      renderWorldCopies: false
    });
    layer.addTo(targetMap);
    const vectorMap = layer.getMaplibreMap();
    themeListener = () => {
      const next = styleForTheme();
      if (finished || !ready || next === activeStyle) return;
      activeStyle = next;
      failures = 0;
      switchingStyle = true;
      status.textContent = 'Cambiando fondo…';
      clearTimeout(styleTimeout);
      styleTimeout = setTimeout(() => { if (switchingStyle) fallback(); }, 10000);
      try { vectorMap.setStyle(next); } catch (_) { fallback(); }
    };
    window.addEventListener('vialab:themechange', themeListener);
    vectorMap.on('style.load', () => {
      if (finished) return;
      switchingStyle = false;
      clearTimeout(styleTimeout);
      if (ready) status.textContent = 'Fondo: OpenFreeMap';
      if (activeStyle.endsWith('/dark')) {
        // The upstream dark style uses very dim labels. Lift the place names
        // without changing the source tiles or painting over railway layers.
        for (const layer of vectorMap.getStyle()?.layers || []) {
          if (layer.type === 'symbol' && layer.id.startsWith('place_')) vectorMap.setPaintProperty(layer.id,'text-color','#a9bdb2');
          else if (layer.type === 'symbol' && layer.id.startsWith('highway_name')) vectorMap.setPaintProperty(layer.id,'text-color','#8b9c94');
          else if (layer.id === 'water_name') vectorMap.setPaintProperty(layer.id,'text-color','#7e959b');
        }
      }
    });
    vectorMap.on('load', () => {
      if (finished) return;
      ready = true;
      clearTimeout(timeout);
      if (!addedAttribution) {
        targetMap.attributionControl.addAttribution(BASE_ATTRIBUTION);
        addedAttribution = true;
      }
      status.textContent = 'Fondo: OpenFreeMap';
      themeListener(); // Apply a theme change made while the first style loaded.
    });
    vectorMap.on('error', event => {
      failures++;
      console.warn('No se pudo cargar un recurso del mapa de fondo:', event.error?.message || 'error desconocido');
      // A failed style, or repeated failed tile/glyph loads, means the base
      // is unusable. Keep trains and track overlays instead.
      if (!ready || switchingStyle || failures >= 4) fallback();
    });
    vectorMap.on('webglcontextlost', fallback);
    timeout = setTimeout(() => { if (!ready) fallback(); }, 15000);
  } catch (error) {
    console.warn('No se pudo iniciar el mapa de fondo:', error.message);
    fallback();
  }
}
$('baseRetry').addEventListener('click', () => initializeBasemap());
let localBasemapStarted=false, nationalPromise=null, timetablePromise=null, activeView='sevilla';
function ensureLocalBasemap() {
  if (!localBasemapStarted) { localBasemapStarted=true; initializeBasemap(); }
}
async function changeView(view,updateHash=true) {
  if (!['sevilla','espana','itinerarios'].includes(view)) return;
  activeView=view;
  if (view!=='sevilla' && running) { setRunning(false); setNotice('Simulación de Sevilla pausada al cambiar de mapa.'); render(); }
  $('sevillaView').hidden=view!=='sevilla'; $('nationalView').hidden=view!=='espana'; $('timetableView').hidden=view!=='itinerarios';
  for (const [id,current] of [['showSevilla','sevilla'],['showNational','espana'],['showTimetable','itinerarios']]) {
    $(id).classList.toggle('active',view===current); $(id).setAttribute('aria-pressed',String(view===current));
  }
  if (updateHash) { try { history.replaceState(null,'',`#${view}`); } catch (_) { /* file:// sandbox */ } }
  if (view==='sevilla') {
    ensureLocalBasemap();
    localMotion.resume();
    requestAnimationFrame(()=>map.invalidateSize({animate:false}));
  } else if (view==='espana') {
    if (!nationalPromise) nationalPromise=initializeNationalMap(initializeBasemap);
    try {
      const controller=await nationalPromise;
      if (activeView==='espana') controller.show();
    } catch (error) {
      $('nationalNotice').textContent=`No se pudo iniciar el mapa: ${error.message}.`;
      console.error(error);
      nationalPromise=null;
    }
  } else {
    if (!timetablePromise) timetablePromise=initializeTimetableView(initializeBasemap);
    try {
      const controller=await timetablePromise;
      if (activeView==='itinerarios') controller.show();
    } catch (error) {
      $('timetableDatasetStatus').textContent=`No se pudo iniciar la línea de tiempo: ${error.message}.`;
      console.error(error);
      timetablePromise=null;
    }
  }
}
$('showSevilla').addEventListener('click',()=>changeView('sevilla'));
$('showNational').addEventListener('click',()=>changeView('espana'));
$('showTimetable').addEventListener('click',()=>changeView('itinerarios'));
const initialView=location.hash==='#sevilla' ? 'sevilla' : location.hash==='#itinerarios' ? 'itinerarios' : 'espana';
changeView(initialView,false);
