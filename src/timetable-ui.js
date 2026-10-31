import { TIMETABLE_URL, TIMETABLE_WINDOW_MS, indexTimetable, findTimetableJourneys, formatTimetableTime, madridCalendarDate, matchBoardEvent, createBoardSource } from './timetable.js?v=13';

const timetableElement = id => document.getElementById(id);
function timetableNode(tag,text,className='') {
  const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;
}
function timetableDateLabel(value) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))return 'fecha desconocida';
  const [y,m,d]=value.split('-');return `${d}/${m}/${y}`;
}
function timetablePatternName(journey) {
  return `${journey.pattern.route || 'Renfe'} · ${journey.pattern.code}`;
}
function timetableStopEvent(journey,index,kind) {
  const stop=journey.pattern.visits[index];
  return journey.serviceStart+(kind==='arrivals'?stop.arrival:stop.departure)*1000;
}

/** An independent itinerary view: the map draws station-to-station chords,
 * not train positions or recorded GPS tracks. */
export async function initializeTimetableView(setupBasemap) {
  const map=L.map('timetableMap',{zoomControl:false,preferCanvas:true,zoomSnap:.5,maxZoom:18}).setView([40,-4],6);
  L.control.zoom({position:'topright'}).addTo(map);
  map.attributionControl.addAttribution('&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>');
  const drawing=L.layerGroup().addTo(map),boardSource=createBoardSource();
  const state={index:null,windowEnd:Date.now(),results:[],limit:12,selected:null,boardValues:new Map(),
    selectionVersion:0,boardBusy:false,markers:new Map(),statusBase:''};
  setupBasemap(map,timetableElement('timetableBaseStatus'),timetableElement('timetableBaseRetry'));
  timetableElement('timetableBaseRetry').addEventListener('click',()=>setupBasemap(map,timetableElement('timetableBaseStatus'),timetableElement('timetableBaseRetry')));

  function updateClock() {
    const range=timetableElement('timetableRange'),value=Math.max(0,Math.min(1440,Number(range.value)||0));
    const instant=state.windowEnd-TIMETABLE_WINDOW_MS+value*60000;
    timetableElement('timetableTime').textContent=formatTimetableTime(instant);
    range.setAttribute('aria-valuetext',`${formatTimetableTime(instant)} · hora de Madrid`);
    timetableElement('timetableStart').textContent=formatTimetableTime(state.windowEnd-TIMETABLE_WINDOW_MS);
    timetableElement('timetableEnd').textContent=`${formatTimetableTime(state.windowEnd)} · ahora`;
    return instant;
  }
  function currentDescription(journey) {
    const first=journey.pattern.visits[0].station.name,last=journey.pattern.visits.at(-1).station.name;
    return `${first} → ${last}`;
  }
  function makeResult(journey) {
    const button=timetableNode('button',undefined,'timetable-result');button.type='button';
    button.classList.toggle('selected',state.selected?.key===journey.key);
    button.setAttribute('aria-pressed',String(state.selected?.key===journey.key));
    const head=timetableNode('span',undefined,'timetable-result-head');
    head.append(timetableNode('strong',timetablePatternName(journey)),timetableNode('small','PROGRAMADO'));
    button.append(head,timetableNode('span',currentDescription(journey),'timetable-result-route'),
      timetableNode('span',`${formatTimetableTime(journey.departure)} → ${formatTimetableTime(journey.arrival)}`,'timetable-result-time'));
    button.addEventListener('click',()=>selectJourney(journey));
    return button;
  }
  function renderList() {
    const container=timetableElement('timetableResults');container.replaceChildren();
    if(!state.results.length)container.append(timetableNode('p','No hay servicios programados coincidentes en el calendario disponible.','timetable-empty'));
    else for(const journey of state.results.slice(0,state.limit))container.append(makeResult(journey));
    timetableElement('timetableMore').hidden=state.limit>=state.results.length;
    timetableElement('timetableMore').textContent=`Mostrar más (${Math.max(0,state.results.length-state.limit)} restantes)`;
  }
  function resetSelection() {
    state.selectionVersion++;state.selected=null;state.boardValues.clear();state.boardBusy=false;state.markers.clear();drawing.clearLayers();
    timetableElement('timetableJourneyHeading').textContent='Selecciona un viaje';
    timetableElement('timetableJourneyMeta').textContent='Se mostrarán las paradas y sus horas publicadas.';
    timetableElement('timetableMapNotice').textContent='Selecciona un viaje para ver sus estaciones.';
    timetableElement('timetableBoardStatus').textContent='No hay un viaje seleccionado.';
    timetableElement('timetableBoardRefresh').disabled=true;
    const cell=timetableNode('td','Selecciona un viaje en la lista.');cell.colSpan=3;
    const row=timetableNode('tr');row.append(cell);timetableElement('timetableStops').replaceChildren(row);
  }
  function updateResults() {
    const instant=updateClock();
    if(!state.index)return;
    const av=timetableElement('timetableAV').checked,commuter=timetableElement('timetableCommuter').checked;
    state.results=findTimetableJourneys(state.index,instant,{query:timetableElement('timetableSearch').value,av,commuter});
    const day=madridCalendarDate(instant), sources=state.index.metadata.sources;
    const enabled=sources.filter((_,i)=>i===0?av:commuter);
    const missing=enabled.filter(source=>!day || !source.included_from || !source.included_until || day<source.included_from || day>source.included_until ||
      (Array.isArray(source.included_dates) && !source.included_dates.includes(day)));
    const archived=enabled.filter(source=>Array.isArray(source.archived_dates) && source.archived_dates.some(entry=>entry?.date===day));
    const status=timetableElement('timetableDatasetStatus');
    status.classList.toggle('warning',missing.length>0 || archived.length>0);
    const notices=(missing.length ? `SIN COBERTURA para ${missing.map(s=>s.label).join(' y ')} en esta fecha. No implica que no circularan trenes. ` : '')+
      (archived.length ? `Horario anterior conservado de una instantánea previa para ${archived.map(s=>s.label).join(' y ')}; puede no incluir cambios posteriores. ` : '');
    status.textContent=notices+state.statusBase;
    timetableElement('timetableCount').textContent=missing.length===enabled.length && enabled.length && !state.results.length ? '—' : state.results.length.toLocaleString('es-ES')+(missing.length?'*':'');
    if(state.selected && !state.results.some(j=>j.key===state.selected.key))resetSelection();
    renderList();
  }
  function drawJourney(journey) {
    drawing.clearLayers();state.markers.clear();
    const coordinates=journey.pattern.visits.map(v=>[v.station.latitude,v.station.longitude]);
    L.polyline(coordinates,{color:'#32a893',weight:3,opacity:.9,dashArray:'6 8',interactive:false}).addTo(drawing);
    journey.pattern.visits.forEach((visit,index)=>{
      const terminal=index===0||index===journey.pattern.visits.length-1;
      const marker=L.circleMarker([visit.station.latitude,visit.station.longitude],{radius:terminal?6:4,weight:2,color:'#fff',
        fillColor:terminal?'#edab58':'#3ab7a1',fillOpacity:1}).addTo(drawing);
      marker.bindTooltip(timetableNode('span',visit.station.name));
      marker.on('click',()=>{const row=timetableElement(`timetable-stop-${index}`);row?.scrollIntoView({block:'nearest'});});
      state.markers.set(index,marker);
    });
    const bounds=L.latLngBounds(coordinates);
    if(bounds.isValid())requestAnimationFrame(()=>{map.invalidateSize({animate:false});map.fitBounds(bounds,{padding:[35,35],maxZoom:12,animate:false});});
    timetableElement('timetableMapNotice').textContent='Paradas programadas · la línea recta no representa la vía ni un recorrido GPS.';
  }
  function timetableTimeCell(journey,index,kind) {
    const cell=timetableNode('td'),last=journey.pattern.visits.length-1;
    if((kind==='arrivals' && index===0)||(kind==='departures' && index===last)) {cell.textContent='—';return cell;}
    const actual=state.boardValues.get(`${index}:${kind}`);
    const timestamp=actual?.time ?? timetableStopEvent(journey,index,kind);
    cell.append(timetableNode('b',formatTimetableTime(timestamp)),timetableNode('small',actual?.kind || 'programada',actual?.kind || 'programada'));
    if(actual)cell.title=`Hora ${actual.kind}: programada más ${actual.delayMinutes} min de demora publicada. Tablón consultado ${formatTimetableTime(actual.updatedAt)}.`;
    return cell;
  }
  function renderStops() {
    const journey=state.selected;if(!journey)return;
    const body=timetableElement('timetableStops');body.replaceChildren();
    journey.pattern.visits.forEach((visit,index)=>{
      const row=timetableNode('tr');row.id=`timetable-stop-${index}`;
      const stationCell=timetableNode('td'),button=timetableNode('button',visit.station.name,'timetable-stop-button');button.type='button';
      button.title='Centrar esta estación en el mapa';
      button.addEventListener('click',()=>{
        map.setView([visit.station.latitude,visit.station.longitude],Math.max(map.getZoom(),10),{animate:false});
        state.markers.get(index)?.openTooltip();
      });
      stationCell.append(button);row.append(stationCell,timetableTimeCell(journey,index,'arrivals'),timetableTimeCell(journey,index,'departures'));
      body.append(row);
    });
  }
  function selectJourney(journey) {
    state.selectionVersion++;state.selected=journey;state.boardValues.clear();state.boardBusy=false;
    timetableElement('timetableJourneyHeading').textContent=timetablePatternName(journey);
    timetableElement('timetableJourneyMeta').textContent=`${currentDescription(journey)} · día de servicio ${timetableDateLabel(journey.serviceDate)} · según horario`;
    timetableElement('timetableBoardRefresh').disabled=false;
    timetableElement('timetableBoardStatus').textContent='Pulsa «Consultar horas disponibles» para buscar estimaciones o horas reales en los tablones actuales.';
    drawJourney(journey);renderStops();renderList();
    if(window.matchMedia?.('(max-width:650px)').matches)timetableElement('timetableJourneyHeading').scrollIntoView({behavior:'smooth',block:'center'});
  }
  async function refreshBoards() {
    const journey=state.selected;if(!journey||state.boardBusy)return;
    state.boardBusy=true;const version=state.selectionVersion,visits=journey.pattern.visits,now=Date.now();
    state.boardValues.clear();renderStops();
    timetableElement('timetableBoardRefresh').disabled=true;
    // No bulk scrape: at most 12 unique numeric station codes, with no more
    // than three concurrent requests and a 30 s per-station cache.
    const candidates=visits.map((visit,index)=>({index,code:visit.station.code,
      distance:Math.abs(timetableStopEvent(journey,index,'arrivals')-now)}))
      .filter(item=>/^\d{1,8}$/.test(item.code))
      .sort((a,b)=>a.distance-b.distance);
    const byCode=new Map();
    for(const item of candidates)if(!byCode.has(item.code.replace(/^0+(?=\d)/,'')))byCode.set(item.code.replace(/^0+(?=\d)/,''),item);
    const codes=[...byCode.keys()].slice(0,12),boards=new Map();let cursor=0,failed=0;
    timetableElement('timetableBoardStatus').textContent=`Consultando hasta ${codes.length} tablones actuales…`;
    async function worker() {
      while(cursor<codes.length) {
        const code=codes[cursor++];
        try{boards.set(code,await boardSource.get(code));}catch(_){failed++;}
      }
    }
    await Promise.all(Array.from({length:Math.min(3,codes.length)},worker));
    if(version!==state.selectionVersion)return;
    let matched=0;
    for(let index=0;index<visits.length;index++) {
      const code=visits[index].station.code.replace(/^0+(?=\d)/,''),board=boards.get(code);
      if(!board)continue;
      for(const kind of ['arrivals','departures']) {
        if((kind==='arrivals'&&index===0)||(kind==='departures'&&index===visits.length-1))continue;
        const event=matchBoardEvent(board,journey,index,kind,Date.now());
        if(event){state.boardValues.set(`${index}:${kind}`,event);matched++;}
      }
    }
    state.boardBusy=false;timetableElement('timetableBoardRefresh').disabled=false;renderStops();
    const remaining=Math.max(0,byCode.size-codes.length);
    timetableElement('timetableBoardStatus').textContent=boards.size
      ? `${boards.size} tablón(es) consultados · ${matched} hora(s) estimadas o reales coincidentes${remaining ? ` · límite de 12; ${remaining} paradas sin consultar` : ''}. Las demás son programadas.`
      : `No se pudieron consultar los tablones${failed ? ' · revisa la conexión' : ''}. Se mantienen las horas programadas.`;
  }
  timetableElement('timetableRange').addEventListener('input',()=>{state.limit=12;updateResults();});
  timetableElement('timetableSearch').addEventListener('input',()=>{state.limit=12;updateResults();});
  for(const id of ['timetableAV','timetableCommuter'])timetableElement(id).addEventListener('change',()=>{state.limit=12;updateResults();});
  timetableElement('timetableMore').addEventListener('click',()=>{state.limit+=12;renderList();});
  timetableElement('timetableBoardRefresh').addEventListener('click',refreshBoards);
  for(const button of document.querySelectorAll('[data-timetable-offset]'))button.addEventListener('click',()=>{
    state.windowEnd=Date.now();timetableElement('timetableRange').value=String(1440-Number(button.dataset.timetableOffset)*60);
    state.limit=12;updateResults();
  });
  setInterval(()=>{
    if(document.hidden || timetableElement('timetableView').hidden)return;
    const range=timetableElement('timetableRange'),wasNow=Number(range.value)>=1439,previous=state.windowEnd-TIMETABLE_WINDOW_MS+Number(range.value)*60000;
    state.windowEnd=Date.now();
    range.value=String(wasNow?1440:Math.max(0,Math.min(1440,Math.round((previous-(state.windowEnd-TIMETABLE_WINDOW_MS))/60000))));
    updateResults();
  },60000);
  updateClock();
  try {
    let payload=window.RAIL_TIMETABLE_SAMPLE;
    if(!payload){const response=await fetch(TIMETABLE_URL);if(!response.ok)throw new Error(`HTTP ${response.status}`);payload=await response.json();}
    state.index=indexTimetable(payload);
    const [av,cer]=payload.sources;
    const captured=Date.parse(payload.generated_at);
    const date=Number.isFinite(captured)?formatTimetableTime(captured):'desconocida';
    state.statusBase=`Instantánea ${date} · Días de servicio incluidos: AV/LD/MD ${timetableDateLabel(av.included_from)}–${timetableDateLabel(av.included_until)}; Cercanías ${timetableDateLabel(cer.included_from)}–${timetableDateLabel(cer.included_until)}. Puede haber horarios incompletos o cambios.`;
    timetableElement('timetableRange').disabled=false;timetableElement('timetableSearch').disabled=false;
    updateResults();
  } catch(error) {
    timetableElement('timetableDatasetStatus').textContent=`No se pudieron cargar los horarios: ${error.message}.`;
    timetableElement('timetableCount').textContent='—';
    timetableElement('timetableResults').replaceChildren(timetableNode('p','No hay una instantánea de horarios disponible.','timetable-empty'));
    console.error(error);
  }
  return {show(){requestAnimationFrame(()=>map.invalidateSize({animate:false}));updateResults();},map};
}
