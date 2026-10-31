import { TIMETABLE_URL, TIMETABLE_WINDOW_MS, TIMETABLE_BOARD_REFRESH_MS, indexTimetable, findTimetableJourneys, formatTimetableTime, madridCalendarDate, matchBoardEvent, createBoardSource, isTimetableBoardFresh, isTimetableBoardValueFresh } from './timetable.js?v=14';

const timetableElement = id => document.getElementById(id);
const timetableLiveClock = new Intl.DateTimeFormat('es-ES',{
  timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',
});
function timetableBoardCode(value) {
  return typeof value==='string' && /^\d{1,8}$/.test(value) ? value.replace(/^0+(?=\d)/,'') : '';
}
function timetableDelayLabel(minutes) {
  return minutes===0 ? 'sin demora publicada' : `${minutes>0?'+':''}${minutes} min`;
}
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
  const state={index:null,windowEnd:Date.now(),results:[],limit:12,selected:null,boardValues:new Map(),stationStates:new Map(),
    selectionVersion:0,active:false,poll:null,pollTimer:null,expiryTimer:null,lastCycle:null,firstCycle:false,retryAfter:0,markers:new Map(),statusBase:''};
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
    state.selectionVersion++;stopAuto();state.selected=null;state.boardValues.clear();state.stationStates.clear();state.lastCycle=null;state.firstCycle=false;state.markers.clear();drawing.clearLayers();
    timetableElement('timetableJourneyHeading').textContent='Selecciona un viaje';
    timetableElement('timetableJourneyMeta').textContent='Se mostrarán las paradas y sus horas publicadas.';
    timetableElement('timetableMapNotice').textContent='Selecciona un viaje para ver sus estaciones.';
    timetableElement('timetableBoardStatus').textContent='Selecciona un viaje para activar la consulta automática.';
    timetableElement('timetableBoardRefresh').disabled=true;
    const cell=timetableNode('td','Selecciona un viaje en la lista.');cell.colSpan=3;
    const row=timetableNode('tr');row.append(cell);timetableElement('timetableStops').replaceChildren(row);
  }
  function updateResults({preserveSelection=false}={}) {
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
    const selectedIsListed=state.selected && state.results.some(j=>j.key===state.selected.key);
    if(state.selected && !selectedIsListed && !preserveSelection)resetSelection();
    else if(state.selected) {
      const journey=state.selected;
      timetableElement('timetableJourneyMeta').textContent=`${currentDescription(journey)} · día de servicio ${timetableDateLabel(journey.serviceDate)} · según horario`+
        (selectedIsListed?'':' · viaje conservado para seguimiento, fuera del instante programado');
    }
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
    const planned=timetableNode('div',undefined,'timetable-time-planned');
    planned.append(timetableNode('b',formatTimetableTime(timetableStopEvent(journey,index,kind))),timetableNode('small','programada','programada'));
    cell.append(planned);
    const value=state.boardValues.get(`${index}:${kind}`),actual=isTimetableBoardValueFresh(value) ? value : null;
    if(actual) {
      const live=timetableNode('div',undefined,`timetable-time-live ${actual.kind}`);
      live.append(timetableNode('b',formatTimetableTime(actual.time)),timetableNode('small',`${actual.kind} · ${timetableDelayLabel(actual.delayMinutes)}`,actual.kind));
      live.title=`Hora ${actual.kind}: programada más ${actual.delayMinutes} min de demora publicada. Última actualización del tablón: ${formatTimetableTime(actual.updatedAt)}.`;
      cell.append(live);
    } else {
      const code=timetableBoardCode(journey.pattern.visits[index].station.code),status=state.stationStates.get(code);
      let message=state.poll ? 'consultando…' : 'sin dato actual';
      if(!code)message='sin código de tablón';
      else if(status==='omitted')message='parada no consultada';
      else if(status==='error')message='tablón no disponible';
      else if(status==='rate')message='límite de consultas';
      else if(status==='stale')message='tablón desactualizado';
      else if(status==='ok')message='sin coincidencia actual';
      cell.append(timetableNode('small',message,'timetable-no-live'));
    }
    return cell;
  }
  function renderStops() {
    const journey=state.selected;if(!journey)return;
    const body=timetableElement('timetableStops'),wrap=body.closest('.timetable-table-wrap'),scrollTop=wrap?.scrollTop || 0;
    const focused=document.activeElement?.closest?.('tr[id^="timetable-stop-"]')?.id;
    body.replaceChildren();
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
    if(focused)timetableElement(focused)?.querySelector('button')?.focus({preventScroll:true});
    if(wrap)wrap.scrollTop=scrollTop;
  }
  function canPoll() {
    return Boolean(state.selected && state.active && !document.hidden && !timetableElement('timetableView').hidden);
  }
  function stopAuto() {
    clearTimeout(state.pollTimer);state.pollTimer=null;
    clearTimeout(state.expiryTimer);state.expiryTimer=null;
    const poll=state.poll;state.poll=null;poll?.controller.abort();
  }
  function updateBoardStatus() {
    const button=timetableElement('timetableBoardRefresh'),status=timetableElement('timetableBoardStatus'),now=Date.now();
    button.disabled=!canPoll() || Boolean(state.poll) || now<state.retryAfter;
    if(!state.selected){status.textContent='Selecciona un viaje para activar la consulta automática.';return;}
    if(!canPoll()){status.textContent='Actualización automática pausada mientras esta vista o pestaña está oculta.';return;}
    if(state.poll){status.textContent='AUTO · consultando los tablones actuales…';return;}
    if(now<state.retryAfter){status.textContent='AUTO · límite de consultas del proveedor; se respetará el tiempo de espera antes de reintentar.';return;}
    if(!state.lastCycle){status.textContent='AUTO · iniciando consulta de tablones actuales…';return;}
    const {fresh,stale,failed,omitted,at}=state.lastCycle;
    const parts=['AUTO · cada ~45 s',`${fresh} tablón(es) recientes`,`${state.boardValues.size} hora(s) coincidentes`,
      `última comprobación ${timetableLiveClock.format(new Date(at))} · Madrid`];
    if(stale)parts.push(`${stale} tablón(es) desactualizados`);
    if(failed)parts.push(`${failed} tablón(es) no disponibles`);
    if(omitted)parts.push(`límite de 12 · ${omitted} paradas sin consultar`);
    status.textContent=parts.join(' · ')+'.';
  }
  function scheduleNextPoll() {
    clearTimeout(state.pollTimer);state.pollTimer=null;
    if(!canPoll())return;
    const delay=Math.max(TIMETABLE_BOARD_REFRESH_MS,state.retryAfter-Date.now());
    // Browsers cap setTimeout at a signed 32-bit millisecond interval.
    state.pollTimer=setTimeout(refreshBoards,Math.min(delay,2147483000));
  }
  function scheduleExpiry() {
    clearTimeout(state.expiryTimer);state.expiryTimer=null;
    if(!canPoll() || !state.boardValues.size)return;
    const expiry=Math.min(...[...state.boardValues.values()].map(value=>value.validUntil));
    state.expiryTimer=setTimeout(()=>{
      for(const [key,value] of state.boardValues)if(!isTimetableBoardValueFresh(value))state.boardValues.delete(key);
      renderStops();updateBoardStatus();scheduleExpiry();
    },Math.max(1,Math.min(2147483000,expiry-Date.now()+1)));
  }
  function pauseAuto() {
    stopAuto();state.boardValues.clear();state.stationStates.clear();state.lastCycle=null;
    renderStops();updateBoardStatus();
  }
  function selectJourney(journey) {
    state.selectionVersion++;stopAuto();state.selected=journey;state.boardValues.clear();state.stationStates.clear();state.lastCycle=null;state.firstCycle=true;
    timetableElement('timetableJourneyHeading').textContent=timetablePatternName(journey);
    timetableElement('timetableJourneyMeta').textContent=`${currentDescription(journey)} · día de servicio ${timetableDateLabel(journey.serviceDate)} · según horario`;
    drawJourney(journey);renderStops();renderList();updateBoardStatus();
    if(canPoll())refreshBoards();
    if(window.matchMedia?.('(max-width:650px)').matches)timetableElement('timetableJourneyHeading').scrollIntoView({behavior:'smooth',block:'center'});
  }
  async function refreshBoards() {
    clearTimeout(state.pollTimer);state.pollTimer=null;
    if(!canPoll() || state.poll)return;
    if(Date.now()<state.retryAfter){updateBoardStatus();scheduleNextPoll();return;}
    const journey=state.selected,visits=journey.pattern.visits,now=Date.now();
    const token={version:state.selectionVersion,controller:new AbortController()};state.poll=token;
    // No bulk scrape: at most 12 unique numeric station codes, with no more
    // than three concurrent requests and a 30 s per-station cache.
    const candidates=visits.map((visit,index)=>({index,code:timetableBoardCode(visit.station.code),
      distance:Math.abs(timetableStopEvent(journey,index,'arrivals')-now)}))
      .filter(item=>item.code)
      .sort((a,b)=>a.distance-b.distance);
    const byCode=new Map();for(const item of candidates)if(!byCode.has(item.code))byCode.set(item.code,item);
    const codes=[...byCode.keys()].slice(0,12),boards=new Map(),failed=new Set();let cursor=0,rateLimited=false;
    renderStops();updateBoardStatus();
    async function worker() {
      while(cursor<codes.length && !token.controller.signal.aborted && !rateLimited) {
        const code=codes[cursor++];
        try {
          const board=await boardSource.get(code,{signal:token.controller.signal});
          if(!token.controller.signal.aborted)boards.set(code,board);
        } catch(error) {
          if(token.controller.signal.aborted || state.poll!==token)return;
          failed.add(code);
          if(error?.status===429){rateLimited=true;state.retryAfter=Math.max(state.retryAfter,Date.now()+(error.retryAfterMs||120000));}
        }
      }
    }
    await Promise.all(Array.from({length:Math.min(3,codes.length)},worker));
    if(state.poll!==token || token.version!==state.selectionVersion || !canPoll())return;
    state.poll=null;
    const checkedAt=Date.now(),stationStates=new Map(),values=new Map();let fresh=0,stale=0;
    for(const code of byCode.keys())stationStates.set(code,'omitted');
    for(const code of codes)stationStates.set(code,rateLimited?'rate':'error');
    for(const [code,board] of boards) {
      if(isTimetableBoardFresh(board,checkedAt)){stationStates.set(code,'ok');fresh++;}
      else{stationStates.set(code,'stale');stale++;}
    }
    for(const code of failed)stationStates.set(code,rateLimited?'rate':'error');
    for(let index=0;index<visits.length;index++) {
      const code=timetableBoardCode(visits[index].station.code),board=boards.get(code);
      if(!board || stationStates.get(code)!=='ok')continue;
      for(const kind of ['arrivals','departures']) {
        if((kind==='arrivals'&&index===0)||(kind==='departures'&&index===visits.length-1))continue;
        const event=matchBoardEvent(board,journey,index,kind,checkedAt);
        if(event)values.set(`${index}:${kind}`,event);
      }
    }
    state.stationStates=stationStates;state.boardValues=values;
    state.lastCycle={fresh,stale,failed:failed.size,omitted:Math.max(0,byCode.size-codes.length),at:checkedAt};
    renderStops();
    // On the first cycle only, reveal the live event nearest the present.
    // Never move the user's table on subsequent automatic updates.
    if(state.firstCycle && values.size) {
      const [key]=[...values.entries()].sort((a,b)=>Math.abs(a[1].time-checkedAt)-Math.abs(b[1].time-checkedAt))[0];
      const row=timetableElement(`timetable-stop-${key.split(':')[0]}`),wrap=row?.closest('.timetable-table-wrap');
      if(row && wrap)wrap.scrollTop+=row.getBoundingClientRect().top-wrap.getBoundingClientRect().top-wrap.clientHeight/3;
    }
    state.firstCycle=false;
    updateBoardStatus();scheduleExpiry();scheduleNextPoll();
  }
  timetableElement('timetableRange').addEventListener('input',()=>{state.limit=12;updateResults();});
  timetableElement('timetableSearch').addEventListener('input',()=>{state.limit=12;updateResults();});
  for(const id of ['timetableAV','timetableCommuter'])timetableElement(id).addEventListener('change',()=>{state.limit=12;updateResults();});
  timetableElement('timetableMore').addEventListener('click',()=>{state.limit+=12;renderList();});
  timetableElement('timetableBoardRefresh').addEventListener('click',refreshBoards);
  function advanceWindow() {
    const range=timetableElement('timetableRange'),wasNow=Number(range.value)>=1439,previous=state.windowEnd-TIMETABLE_WINDOW_MS+Number(range.value)*60000;
    state.windowEnd=Date.now();
    range.value=String(wasNow?1440:Math.max(0,Math.min(1440,Math.round((previous-(state.windowEnd-TIMETABLE_WINDOW_MS))/60000))));
    updateResults({preserveSelection:true});
  }
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)pauseAuto();
    else if(state.active){advanceWindow();if(state.selected)refreshBoards();}
  });
  for(const button of document.querySelectorAll('[data-timetable-offset]'))button.addEventListener('click',()=>{
    state.windowEnd=Date.now();timetableElement('timetableRange').value=String(1440-Number(button.dataset.timetableOffset)*60);
    state.limit=12;updateResults();
  });
  setInterval(()=>{
    if(document.hidden || timetableElement('timetableView').hidden)return;
    advanceWindow();
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
  return {
    show(){
      state.active=true;
      requestAnimationFrame(()=>map.invalidateSize({animate:false}));
      advanceWindow();
      if(state.selected && !document.hidden)refreshBoards();else updateBoardStatus();
    },
    hide(){state.active=false;pauseAuto();},
    map,
  };
}
