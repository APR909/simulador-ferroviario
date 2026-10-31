import { LIVE_POLL_MS, summarizeLive, isExpressService } from './realtime.js?v=12';
import { fetchLivePositions } from './live-source.js?v=16';
import { createLiveMotionLayer, createLiveTrainIcon, liveIconKind } from './live-motion.js?v=12';
import { initializeInfrastructure, infrastructureTrackPopup } from './infrastructure.js?v=12';
import { initializeLimitations } from './limitations.js?v=12';
import { initializeCancellations } from './cancellations.js?v=12';

// National infrastructure is an OSM way extract, not a list of services.
const NATIONAL_STYLE = {
  service:{color:'#a8b9ac',weight:1.05,opacity:.58,pane:'nat-service'},
  rail:{color:'#587a6d',weight:1.45,opacity:.77,pane:'nat-rail'},
  narrow:{color:'#238994',weight:1.7,opacity:.9,pane:'nat-narrow'},
  urban:{color:'#9e76b8',weight:1.6,opacity:.8,pane:'nat-urban'},
  highspeed:{color:'#df644c',weight:2.8,opacity:.98,pane:'nat-highspeed'},
};
const NATIONAL_ORDER = ['service','rail','narrow','urban','highspeed'];
const NATIONAL_DARK_COLORS={service:'#779588',rail:'#a2cbb7',narrow:'#68d0db',urban:'#d2aaf2',highspeed:'#ff9676'};
function nationalCurrentStyle(key) {
  return {...NATIONAL_STYLE[key], color:document.documentElement.dataset.theme==='dark' ? NATIONAL_DARK_COLORS[key] : NATIONAL_STYLE[key].color};
}
const NATIONAL_REGIONS = {
  peninsula:{label:'Península y Baleares',bounds:[[35.05,-9.80],[44.20,4.60]]},
  canarias:{label:'Canarias',bounds:[[27.52,-18.35],[29.70,-13.05]]},
  toda:{label:'Toda España',bounds:[[27.45,-18.50],[44.25,4.65]]},
};
const nationalEl = id => document.getElementById(id);
const nationalClock = new Intl.DateTimeFormat('es-ES', {
  timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',
});

export function isRecognizedExpress(serviceName) {
  return isExpressService(serviceName);
}

/** Return only observations allowed by the toggles; never invent a position. */
export function selectNationalVehicles(summary, options) {
  return summary.vehicles.filter(vehicle => {
    if (vehicle.source==='cercanias') return options.commuter && !options.expressOnly;
    if (vehicle.source==='larga_distancia') return options.longDistance && (!options.expressOnly || isRecognizedExpress(vehicle.service_name));
    return false;
  });
}

function nationalDisplayTime(value) {
  if (!Number.isFinite(value) || value<=0) return 'hora desconocida';
  const d=new Date(value*1000);
  return Number.isFinite(d.getTime()) ? nationalClock.format(d) : 'hora desconocida';
}
function nationalFeedStatus(feed) {
  if (feed.status==='stale') return `Dato atrasado · ${nationalDisplayTime(feed.header_timestamp)} · no se muestra`;
  if (feed.status==='error') return 'Fuente no disponible';
  const notes=[];
  if (feed.excluded_stale) notes.push(`${feed.excluded_stale} antigua(s) excluida(s)`);
  if (feed.excluded_ambiguous) notes.push(`${feed.excluded_ambiguous} ambigua(s) excluida(s)`);
  if (feed.excluded_reported_stale) notes.push(`${feed.excluded_reported_stale} marcada(s) como antiguas por RadarDeTrenes`);
  if (feed.feed_time_fallback) notes.push(`${feed.feed_time_fallback} sin hora GPS individual verificada`);
  if (feed.excluded_invalid) notes.push(`${feed.excluded_invalid} registro(s) no válido(s)`);
  const prefix=feed.source_provider==='radar' ? 'RadarDeTrenes · Renfe' : 'Feed';
  if (feed.source_provider==='radar') {
    if(feed.access_mode==='browser')notes.push('consulta directa desde el navegador');
    else if(feed.direct_status)notes.push(feed.direct_status==='partial' ? 'GTFS directo sin posiciones válidas' : 'GTFS directo atrasado o no disponible');
  }
  return `${prefix} ${nationalDisplayTime(feed.header_timestamp)}${notes.length ? ' · '+notes.join(' · ') : ''}`;
}
function nationalStatusClass(feed) { return feed.status==='fresh' ? 'feed-status-ok' : 'feed-status-warn'; }

/**
 * A grid prevents a click on one way from scanning every way in the country.
 * Geometry is still rendered as a few Canvas multipolylines, not 45k DOM nodes.
 */
function nationalIndexFeatures(features) {
  const grid=new Map(), wide=[], entries=[];
  const scale=2; // 0.5 degree cells
  for (const feature of features) {
    const points=feature[6]; if (!Array.isArray(points) || points.length<2) continue;
    let south=Infinity,north=-Infinity,west=Infinity,east=-Infinity;
    for (const point of points) {
      if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue;
      south=Math.min(south,point[0]); north=Math.max(north,point[0]); west=Math.min(west,point[1]); east=Math.max(east,point[1]);
    }
    if (!Number.isFinite(south)) continue;
    const index=entries.length; entries.push({feature,south,north,west,east});
    const y0=Math.floor(south*scale),y1=Math.floor(north*scale),x0=Math.floor(west*scale),x1=Math.floor(east*scale);
    if ((y1-y0+1)*(x1-x0+1)>200) { wide.push(index); continue; }
    for (let y=y0;y<=y1;y++) for (let x=x0;x<=x1;x++) {
      const key=`${y},${x}`;
      if (!grid.has(key)) grid.set(key,[]);
      grid.get(key).push(index);
    }
  }
  return {grid,wide,entries,scale};
}
function nationalNearestFeature(map,index,latlng,isVisible) {
  const target=map.latLngToContainerPoint(latlng), tolerance=9;
  const cornerA=map.containerPointToLatLng([target.x-tolerance,target.y-tolerance]);
  const cornerB=map.containerPointToLatLng([target.x+tolerance,target.y+tolerance]);
  const south=Math.min(cornerA.lat,cornerB.lat),north=Math.max(cornerA.lat,cornerB.lat);
  const west=Math.min(cornerA.lng,cornerB.lng),east=Math.max(cornerA.lng,cornerB.lng);
  const candidates=new Set(index.wide);
  for (let y=Math.floor(south*index.scale);y<=Math.floor(north*index.scale);y++) {
    for (let x=Math.floor(west*index.scale);x<=Math.floor(east*index.scale);x++) {
      for (const i of index.grid.get(`${y},${x}`)||[]) candidates.add(i);
    }
  }
  let best=null,bestDistance=tolerance;
  for (const i of candidates) {
    const entry=index.entries[i], feature=entry.feature;
    if (!isVisible(feature[1]) || entry.north<south || entry.south>north || entry.east<west || entry.west>east) continue;
    let previous=null;
    for (const point of feature[6]) {
      const projected=map.latLngToContainerPoint(point);
      if (previous) {
        const distance=L.LineUtil.pointToSegmentDistance(target,previous,projected);
        if (distance<bestDistance) { bestDistance=distance; best=feature; }
      }
      previous=projected;
    }
  }
  return best;
}
function nationalTextElement(tag,text) {
  const element=document.createElement(tag); element.textContent=text; return element;
}
function nationalTrackPopup(feature) {
  const groups={highspeed:'ALTA VELOCIDAD ETIQUETADA EN OSM',rail:'FERROCARRIL CONVENCIONAL',narrow:'VÍA ESTRECHA',urban:'METRO / TRANVÍA',service:'VÍA DE SERVICIO'};
  const tags={railway:feature[5],name:feature[2],ref:feature[3],maxspeed:feature[4],...(feature[7] || {})};
  return infrastructureTrackPopup({id:feature[0],tags,name:feature[2],groupLabel:groups[feature[1]] || 'VÍA OPENSTREETMAP'});
}
function nationalLivePopup(vehicle) {
  const popup=document.createElement('div'); popup.className='national-popup';
  const source=vehicle.source_provider==='radar' ? 'RENFE · VÍA RADARDETRENES (INDEPENDIENTE)' :
    vehicle.source==='cercanias' ? 'RENFE · CERCANÍAS' : 'RENFE · AV / LARGA Y MEDIA DISTANCIA';
  popup.append(nationalTextElement('small',source));
  popup.append(nationalTextElement('strong',`${vehicle.service_name ? vehicle.service_name+' · ' : ''}${vehicle.label || vehicle.id || 'Vehículo'}`));
  const basis=vehicle.time_basis==='feed' ? 'Hora del feed; sin hora GPS individual' : 'Última posición GPS';
  popup.append(nationalTextElement('p',`${basis}: ${nationalDisplayTime(vehicle.observed_at)}`));
  popup.append(nationalTextElement('p',`Último punto observado: ${vehicle.latitude.toFixed(5)}, ${vehicle.longitude.toFixed(5)}`));
  if (vehicle.origin || vehicle.destination) popup.append(nationalTextElement('p',`Trayecto: ${vehicle.origin || '—'} → ${vehicle.destination || '—'}`));
  if (vehicle.trip_id) popup.append(nationalTextElement('p',`Viaje: ${vehicle.trip_id}`));
  if (vehicle.service_name) popup.append(nationalTextElement('p',vehicle.source_provider==='radar'
    ? 'Tipo de servicio según RadarDeTrenes; no indica el modelo ni la velocidad actual.'
    : 'Tipo de servicio identificado mediante el GTFS estático de Renfe.'));
  const caution=nationalTextElement('p','Movimiento entre GPS estimado en línea recta; no necesariamente sigue la vía ni es la posición exacta. Se detiene en el último punto recibido.');
  caution.className='live-motion-caution';popup.append(caution);return popup;
}
function nationalVehicleMarker(vehicle) {
  const commuter=vehicle.source==='cercanias';
  const marker=L.marker([vehicle.latitude,vehicle.longitude],{
    icon:createLiveTrainIcon(vehicle,'national'),zIndexOffset:2000,
    title:`Renfe ${vehicle.service_name || (commuter ? 'Cercanías' : 'AV / LD / MD')}: ${vehicle.label || vehicle.id}`,
    alt:`Tren Renfe ${vehicle.label || vehicle.id}; movimiento estimado`,
  }).bindPopup(nationalLivePopup(vehicle));
  marker.__liveKind=liveIconKind(vehicle);return marker;
}
function updateNationalLiveMarker(marker,vehicle) {
  marker.setPopupContent(nationalLivePopup(vehicle));
  const kind=liveIconKind(vehicle);if(kind!==marker.__liveKind){marker.setIcon(createLiveTrainIcon(vehicle,'national'));marker.__liveKind=kind;}
}

/** Initialize once, when the Spain tab is first made visible. */
export async function initializeNationalMap(setupBasemap) {
  const map=L.map('nationalMap',{zoomControl:false,preferCanvas:true,zoomSnap:.5,maxZoom:19}).setView([40,-4],6);
  L.control.zoom({position:'topright'}).addTo(map);
  map.attributionControl.addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>');
  const layers={},renderers={};
  NATIONAL_ORDER.forEach((key,i)=>{
    map.createPane(NATIONAL_STYLE[key].pane);
    map.getPane(NATIONAL_STYLE[key].pane).style.zIndex=String(401+i);
    renderers[key]=L.canvas({pane:NATIONAL_STYLE[key].pane,padding:.25});
  });
  map.createPane('nat-stations'); map.getPane('nat-stations').style.zIndex='430';
  const stationRenderer=L.canvas({pane:'nat-stations',padding:.2});
  const stationLayer=L.layerGroup().addTo(map),liveLayer=L.layerGroup().addTo(map);
  const nationalAnimate=nationalEl('nationalAnimate');
  if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)nationalAnimate.checked=false;
  const nationalMotion=createLiveMotionLayer({layer:liveLayer,createMarker:nationalVehicleMarker,updateMarker:updateNationalLiveMarker,
    isVisible:()=>!nationalEl('nationalView').hidden,isEnabled:()=>nationalAnimate.checked});
  nationalAnimate.addEventListener('change',()=>nationalMotion.setEnabled(nationalAnimate.checked));
  const limitations=initializeLimitations(map);
  const cancellations=initializeCancellations(map);
  initializeInfrastructure(map,'national');
  window.addEventListener('vialab:themechange',()=>{
    for (const key of NATIONAL_ORDER) if (layers[key]) layers[key].setStyle(nationalCurrentStyle(key));
  });
  let dataset=null, featureIndex=null, livePayload=null, liveReceivedAt=0, liveBusy=false, lastLiveKey='';
  let lastRequestAt=0,liveTimer=null;
  const isVisible=key=>Boolean(nationalEl(`nationalLayer-${key}`)?.checked);
  const setRegion=key=>{
    const region=NATIONAL_REGIONS[key]; if (!region) return;
    map.fitBounds(region.bounds,{padding:[25,25],animate:false});
    nationalEl('nationalArea').textContent=region.label;
    for (const button of document.querySelectorAll('[data-national-region]')) {
      button.classList.toggle('active',button.dataset.nationalRegion===key);
      button.setAttribute('aria-pressed',String(button.dataset.nationalRegion===key));
    }
  };
  for (const button of document.querySelectorAll('[data-national-region]')) button.addEventListener('click',()=>setRegion(button.dataset.nationalRegion));
  for (const input of document.querySelectorAll('[data-national-layer]')) {
    input.id=`nationalLayer-${input.dataset.nationalLayer}`;
    input.addEventListener('change',()=>{
      const layer=layers[input.dataset.nationalLayer]; if (!layer) return;
      if (input.checked) layer.addTo(map); else map.removeLayer(layer);
    });
  }
  setRegion('peninsula');
  nationalEl('nationalBaseRetry').addEventListener('click',()=>setupBasemap(map,nationalEl('nationalBaseStatus'),nationalEl('nationalBaseRetry')));
  setupBasemap(map,nationalEl('nationalBaseStatus'),nationalEl('nationalBaseRetry'));

  function renderStations() {
    if (!dataset) return;
    stationLayer.clearLayers();
    if (map.getZoom()<9) { nationalEl('nationalStationsStatus').textContent='Acerca el mapa para ver estaciones OSM.'; return; }
    const bounds=map.getBounds(),seen=new Set(); let count=0, limited=false;
    for (const station of dataset.stations || []) {
      const [id,lat,lon,name,kind]=station;
      if (!bounds.contains([lat,lon])) continue;
      const key=`${name}:${lat.toFixed(3)}:${lon.toFixed(3)}`;
      if (seen.has(key)) continue; seen.add(key);
      if (count>=600) { limited=true; break; }
      const caption=nationalTextElement('span',name);
      L.circleMarker([lat,lon],{pane:'nat-stations',renderer:stationRenderer,radius:2.6,weight:1,color:'#fff',fillColor:'#536f61',fillOpacity:.95,bubblingMouseEvents:false})
        .bindTooltip(caption).bindPopup(nationalTextElement('span',`${name} · ${kind} OSM ${id}`)).addTo(stationLayer);
      count++;
    }
    nationalEl('nationalStationsStatus').textContent=`${count} paradas OSM visibles${limited ? ' · máximo 600, amplía el mapa' : ''}.`;
  }
  map.on('moveend',renderStations);
  map.on('click',event=>{
    if (event.infrastructureHandled || !featureIndex) return;
    const selected=nationalNearestFeature(map,featureIndex,event.latlng,isVisible);
    if (selected) L.popup().setLatLng(event.latlng).setContent(nationalTrackPopup(selected)).openOn(map);
  });

  function liveUnavailable(message) {
    livePayload=null; nationalMotion.clear(); lastLiveKey='';
    nationalEl('nationalExpressCount').textContent='Alta velocidad identificada: —';
    nationalEl('nationalAVCount').textContent='—'; nationalEl('nationalCCCount').textContent='—';
    nationalEl('nationalAVStatus').textContent='Fuente no disponible'; nationalEl('nationalCCStatus').textContent='Fuente no disponible';
    nationalEl('nationalAVStatus').className='feed-status-warn'; nationalEl('nationalCCStatus').className='feed-status-warn';
    nationalEl('nationalLiveBadge').textContent='SIN DATOS'; nationalEl('nationalLiveBadge').className='live-badge offline';
    nationalEl('nationalLiveUpdated').textContent=message;
    nationalEl('nationalExpressOnly').disabled=true; nationalEl('nationalExpressOnly').checked=false;
    nationalEl('nationalServiceInfo').textContent='El feed AV también incluye larga y media distancia; no todos los servicios se pueden identificar.';
  }
  function renderLive() {
    if (!livePayload) return;
    const now=livePayload.generated_at+Math.max(0,(performance.now()-liveReceivedAt)/1000);
    const summary=summarizeLive(livePayload,now);
    const partial=summary.usable<2 || [summary.cercanias,summary.larga].some(feed=>feed.status==='partial');
    nationalEl('nationalLiveBadge').textContent=!summary.usable ? 'SIN DATOS RECIENTES' : partial ? 'COBERTURA PARCIAL' : 'RECIENTES*';
    nationalEl('nationalLiveBadge').className=`live-badge ${!summary.usable ? 'offline' : partial ? 'partial' : 'fresh'}`;
    for (const [feed,countId,statusId] of [[summary.larga,'nationalAVCount','nationalAVStatus'],[summary.cercanias,'nationalCCCount','nationalCCStatus']]) {
      nationalEl(countId).textContent=feed.count===null ? '—' : String(feed.count);
      nationalEl(statusId).textContent=nationalFeedStatus(feed);
      nationalEl(statusId).className=nationalStatusClass(feed);
    }
    const classified=summary.larga.vehicles.filter(vehicle=>Boolean(vehicle.service_name)).length;
    const express=summary.larga.vehicles.filter(vehicle=>isRecognizedExpress(vehicle.service_name)).length;
    const catalogStatus=livePayload.service_catalog?.status;
    const canFilter=['available','radar_product'].includes(catalogStatus) && classified>0;
    nationalEl('nationalExpressCount').textContent=summary.larga.count===null ? 'Alta velocidad identificada: —' :
      `Alta velocidad identificada: ${express} · solo datos disponibles`;
    nationalEl('nationalExpressOnly').disabled=!canFilter;
    if (!canFilter) nationalEl('nationalExpressOnly').checked=false;
    nationalEl('nationalServiceInfo').textContent=canFilter
      ? `${classified} de ${summary.larga.vehicles.length} tipos identificados ${catalogStatus==='radar_product'?'por RadarDeTrenes':'con GTFS de Renfe'}. El filtro excluye los no identificados y otros servicios.`
      : 'El feed AV también incluye larga y media distancia; no todos los servicios se pueden identificar.';
    const lastFetch=Math.max(summary.cercanias.fetched_at||0,summary.larga.fetched_at||0);
    nationalEl('nationalLiveUpdated').textContent=`Consulta ${nationalDisplayTime(lastFetch)} · máx. cada 30 s`;
    const options={longDistance:nationalEl('nationalLongDistance').checked,commuter:nationalEl('nationalCommuter').checked,expressOnly:nationalEl('nationalExpressOnly').checked};
    const selected=selectNationalVehicles(summary,options);
    const key=JSON.stringify(selected.map(v=>[v.source,v.source_provider,v.id,v.label,v.latitude,v.longitude,v.observed_at,v.time_basis,v.service_name,v.trip_id,v.origin,v.destination,v.origin_code,v.destination_code]));
    if (key!==lastLiveKey) {
      const state=nationalMotion.update(selected);
      nationalEl('nationalMotionStatus').textContent=state.suppressed
        ? `${state.suppressed} posición(es) con lecturas contradictorias ocultas. Movimiento estimado en línea recta, nunca más allá del último GPS.`
        : 'Movimiento en línea recta estimado entre dos GPS recibidos; puede no seguir la vía y nunca avanza más allá del último dato.';
      lastLiveKey=key;
    }
  }
  function scheduleLiveRefresh() {
    clearTimeout(liveTimer);liveTimer=null;
    if (!document.hidden && !nationalEl('nationalView').hidden) {
      liveTimer=setTimeout(()=>{
        if (!document.hidden && !nationalEl('nationalView').hidden) refreshLive();
      },LIVE_POLL_MS);
    }
  }
  async function refreshLive() {
    if (liveBusy) return;
    liveBusy=true; lastRequestAt=performance.now(); nationalEl('nationalLiveRefresh').disabled=true;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),20000);
    try {
      const payload=await fetchLivePositions('espana',{signal:controller.signal});
      // Count the full request duration conservatively as part of the age.
      livePayload=payload; liveReceivedAt=lastRequestAt; renderLive();
    } catch (_) { liveUnavailable('No se pudo consultar la API local ni RadarDeTrenes; revisa la conexión.'); }
    finally { clearTimeout(timeout);liveBusy=false;nationalEl('nationalLiveRefresh').disabled=false;scheduleLiveRefresh(); }
  }
  nationalEl('nationalLiveRefresh').addEventListener('click',refreshLive);
  for (const id of ['nationalLongDistance','nationalCommuter','nationalExpressOnly']) nationalEl(id).addEventListener('change',renderLive);
  // Schedule from the end of the previous fetch, not a fixed interval started
  // before it. Otherwise a poll can repeatedly land just before the shared
  // 30-second cache expires and postpone new observations by another cycle.
  setInterval(()=>{if (!document.hidden && !nationalEl('nationalView').hidden) renderLive();},5000);
  document.addEventListener('visibilitychange',()=>{
    if (document.hidden) {clearTimeout(liveTimer);liveTimer=null;}
    else if (!nationalEl('nationalView').hidden) {renderLive();nationalMotion.resume();refreshLive();}
  });

  try {
    const response=window.RAIL_SPAIN_SAMPLE ? null : await fetch('./data/espana-osm.json');
    if (response && !response.ok) throw new Error(`HTTP ${response.status}`);
    dataset=window.RAIL_SPAIN_SAMPLE || await response.json();
    if (!Array.isArray(dataset.features) || !dataset.counts) throw new Error('Formato nacional no válido');
    const grouped=Object.fromEntries(NATIONAL_ORDER.map(key=>[key,[]]));
    for (const feature of dataset.features) if (grouped[feature[1]] && Array.isArray(feature[6])) grouped[feature[1]].push(feature[6]);
    for (const key of NATIONAL_ORDER) {
      const style=nationalCurrentStyle(key);
      layers[key]=L.polyline(grouped[key],{...style,renderer:renderers[key],interactive:false,smoothFactor:1.2});
      if (isVisible(key)) layers[key].addTo(map);
      nationalEl(`count-${key}`).textContent=(dataset.counts[key]||0).toLocaleString('es-ES');
      // Let the browser paint between large classes of railway ways.
      await new Promise(resolve=>requestAnimationFrame(resolve));
    }
    featureIndex=nationalIndexFeatures(dataset.features);
    nationalEl('nationalWayCount').textContent=dataset.features.length.toLocaleString('es-ES');
    nationalEl('nationalDataDate').textContent=`Instantánea OSM · ${dataset.source_date || 'fecha desconocida'}`;
    nationalEl('nationalNotice').textContent='Vías OSM · pulsa un tramo para consultar sus datos.';
    renderStations();
  } catch (error) {
    nationalEl('nationalNotice').textContent=`No se pudo cargar la red nacional: ${error.message}.`;
    nationalEl('nationalNotice').parentElement.classList.add('error');
    console.error(error);
  }
  if (!document.hidden && !nationalEl('nationalView').hidden) refreshLive();
  return {
    show() {
      requestAnimationFrame(()=>{map.invalidateSize({animate:false});renderStations();});
      limitations.show();cancellations.show();nationalMotion.resume();
      if (!livePayload || performance.now()-lastRequestAt>=LIVE_POLL_MS) refreshLive();
      else {renderLive();scheduleLiveRefresh();}
    },
    map,
  };
}
