import { TIMETABLE_URL, TIMETABLE_WINDOW_MS, TIMETABLE_BOARD_REFRESH_MS, indexTimetable, findTimetableJourneys, formatTimetableTime, timetableSearchText, madridCalendarDate, matchBoardEvent, createBoardSource, isTimetableBoardFresh, isTimetableBoardValueFresh } from './timetable.js?v=15';
import { LIVE_POLL_MS, summarizeLive, recentTimestamp } from './realtime.js?v=12';
import { fetchRadarPositions } from './live-source.js?v=16';
import { matchLiveJourneys } from './live-journeys.js?v=15';

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
  const drawing=L.layerGroup().addTo(map),currentLayer=L.layerGroup().addTo(map),boardSource=createBoardSource();
  const state={index:null,timetableStatus:'loading',windowEnd:Date.now(),results:[],limit:12,selected:null,boardValues:new Map(),stationStates:new Map(),
    selectionVersion:0,active:false,poll:null,pollTimer:null,expiryTimer:null,lastCycle:null,firstCycle:false,retryAfter:0,markers:new Map(),statusBase:'',
    current:{payload:null,vehicles:[],filtered:[],matches:new Map(),selectedId:null,selectedKey:null,selectedSignature:'',pendingMatch:false,limit:8,busy:false,sequence:0,timer:null,expiry:null,status:'loading'}};
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
    state.selectionVersion++;stopAuto();state.selected=null;state.current.selectedId=null;state.current.selectedKey=null;state.current.selectedSignature='';state.current.pendingMatch=false;state.boardValues.clear();state.stationStates.clear();state.lastCycle=null;state.firstCycle=false;state.markers.clear();drawing.clearLayers();
    timetableElement('timetableJourneyHeading').textContent='Selecciona un viaje';
    timetableElement('timetableJourneyMeta').textContent='Se mostrarán las paradas y sus horas publicadas.';
    timetableElement('timetableMapNotice').textContent='Selecciona un viaje para ver sus estaciones.';
    timetableElement('timetableBoardStatus').textContent='Selecciona un viaje para activar la consulta automática.';
    timetableElement('timetableBoardRefresh').disabled=true;
    const cell=timetableNode('td','Selecciona un viaje en la lista.');cell.colSpan=3;
    const row=timetableNode('tr');row.append(cell);timetableElement('timetableStops').replaceChildren(row);
    renderCurrentList();renderCurrentMap();
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
      const current=state.current.selectedId ? state.current.vehicles.find(v=>v.id===state.current.selectedId) : null;
      const observation=state.current.selectedId ? ` · ${current && state.current.status==='ready' ? 'detectado en la última instantánea' : currentSelectionUnavailable()}` : '';
      timetableElement('timetableJourneyMeta').textContent=`${currentDescription(journey)} · día de servicio ${timetableDateLabel(journey.serviceDate)} · según horario${observation}`+
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
    timetableElement('timetableMapNotice').textContent='Línea entre paradas programadas · puntos de la instantánea actual; no son un recorrido GPS histórico.';
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
  function selectJourney(journey,{liveId=null}={}) {
    state.selectionVersion++;stopAuto();state.selected=journey;state.current.selectedId=liveId;state.current.selectedKey=liveId ? journey.key : null;state.current.selectedSignature=liveId ? currentIdentity(state.current.vehicles.find(v=>v.id===liveId)) : '';state.current.pendingMatch=false;state.boardValues.clear();state.stationStates.clear();state.lastCycle=null;state.firstCycle=true;
    timetableElement('timetableJourneyHeading').textContent=timetablePatternName(journey);
    timetableElement('timetableJourneyMeta').textContent=`${currentDescription(journey)} · día de servicio ${timetableDateLabel(journey.serviceDate)} · según horario`;
    drawJourney(journey);renderStops();renderList();renderCurrentList();renderCurrentMap();updateBoardStatus();
    if(liveId)updateResults({preserveSelection:true});
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
  function currentCanPoll() {
    return state.active && !document.hidden && !timetableElement('timetableView').hidden;
  }
  function currentSearchText(vehicle) {
    return timetableSearchText([vehicle.label,vehicle.service_name,vehicle.line,vehicle.origin,vehicle.destination,vehicle.next_station].join(' '));
  }
  function currentIdentity(vehicle) {
    return vehicle ? JSON.stringify([vehicle.type,vehicle.label,vehicle.origin_code,vehicle.destination_code,Boolean(vehicle.route_ambiguous)]) : '';
  }
  function currentName(vehicle) {
    return `${vehicle.service_name || (vehicle.type==='commuter'?'Cercanías':'Renfe')} · ${vehicle.label}`;
  }
  function currentRoute(vehicle) {
    return `${vehicle.origin || 'Origen no publicado'} → ${vehicle.destination || 'Destino no publicado'}`;
  }
  function currentSelectionUnavailable() {
    switch(state.current.status) {
      case 'ready': return 'ya no aparece en la instantánea actual; esto no confirma que haya terminado';
      case 'paused': return 'consulta pausada; posición actual no confirmada';
      case 'loading': return 'consultando la posición actual';
      default: return 'sin datos recientes; no se puede confirmar la posición actual';
    }
  }
  // Keep a selected, unmatched train truthful across loss and recovery. The
  // schematic is restored on reappearance without moving the user's map.
  function drawUnmatchedCurrent(vehicle,{focus=false}={}) {
    drawing.clearLayers();
    if(!vehicle) {
      timetableElement('timetableJourneyMeta').textContent=currentSelectionUnavailable();
      timetableElement('timetableMapNotice').textContent='Sin posición actual confirmada; no se dibuja un recorrido observado.';
      timetableElement('timetableBoardStatus').textContent='Sin datos actuales del tren seleccionado; no se inventan horarios.';
      const cell=timetableNode('td','Sin datos confirmados no se pueden mostrar paradas ni horarios actuales.');cell.colSpan=3;
      const row=timetableNode('tr');row.append(cell);timetableElement('timetableStops').replaceChildren(row);
      return;
    }
    const pending=!state.index && state.timetableStatus==='loading',unavailable=!state.index && state.timetableStatus==='error';
    timetableElement('timetableJourneyMeta').textContent=`${currentRoute(vehicle)} · ${pending?'horarios cargando':unavailable?'horarios no disponibles':'sin itinerario GTFS inequívoco'}`;
    timetableElement('timetableBoardStatus').textContent=pending?'Cargando horarios; aún no se pueden confirmar las paradas.':
      unavailable?'Horarios no disponibles; no se inventan paradas ni horarios.':'Sin paradas asociadas con seguridad; no se inventan horarios.';
    const cell=timetableNode('td',pending?'Cargando los horarios programados.':unavailable?'No hay horarios disponibles para contrastar este tren.':
      'La fuente muestra este tren, pero no hay una coincidencia única de recorrido y horario.');cell.colSpan=3;
    const row=timetableNode('tr');row.append(cell);timetableElement('timetableStops').replaceChildren(row);
    const stops=state.index?.metadata?.stops || [],origin=timetableBoardCode(vehicle.origin_code),destination=timetableBoardCode(vehicle.destination_code);
    const start=!vehicle.route_ambiguous && origin ? stops.find(s=>timetableBoardCode(s[0])===origin) : null;
    const end=!vehicle.route_ambiguous && destination ? stops.find(s=>timetableBoardCode(s[0])===destination) : null;
    const points=[[vehicle.latitude,vehicle.longitude]];
    if(start && end && [start[2],start[3],end[2],end[3]].every(Number.isFinite)) {
      const endpoints=[[start[2],start[3]],[end[2],end[3]]];L.polyline(endpoints,{color:'#32a893',weight:3,opacity:.8,dashArray:'6 8',interactive:false}).addTo(drawing);
      for(const point of endpoints)L.circleMarker(point,{radius:5,color:'#fff',weight:2,fillColor:'#edab58',fillOpacity:1}).addTo(drawing);
      points.push(...endpoints);
    }
    timetableElement('timetableMapNotice').textContent='Punto de la instantánea actual; si hay línea, solo une origen y destino, no representa el trazado real.';
    if(focus) {
      const bounds=L.latLngBounds(points);if(points.length>1)map.fitBounds(bounds,{padding:[35,35],maxZoom:10,animate:false});else map.setView(points[0],9,{animate:false});
    }
  }
  function renderCurrentList() {
    const live=state.current,container=timetableElement('timetableCurrentResults'),count=timetableElement('timetableCurrentCount');
    const query=timetableSearchText(timetableElement('timetableCurrentSearch').value),type=timetableElement('timetableCurrentType').value;
    live.filtered=live.vehicles.filter(v=>(type==='all'||v.type===type) && (!query || currentSearchText(v).includes(query)));
    live.filtered.sort((a,b)=>String(a.label).localeCompare(String(b.label),'es',{numeric:true}));
    count.textContent=live.status==='ready' ? `${live.filtered.length.toLocaleString('es-ES')} / ${live.vehicles.length.toLocaleString('es-ES')}` : '—';
    container.replaceChildren();
    if(live.status==='ready' && !live.filtered.length)container.append(timetableNode('p','No hay trenes detectados que coincidan con el filtro.','timetable-empty'));
    else if(live.status!=='ready')container.append(timetableNode('p',live.status==='paused'?'La consulta se reanuda al volver a esta vista.':'A la espera de una instantánea reciente.','timetable-empty'));
    for(const vehicle of live.filtered.slice(0,live.limit)) {
      const button=timetableNode('button',undefined,'timetable-result timetable-current-result');button.type='button';
      button.classList.toggle('selected',live.selectedId===vehicle.id);button.setAttribute('aria-pressed',String(live.selectedId===vehicle.id));
      const head=timetableNode('span',undefined,'timetable-result-head');
      head.append(timetableNode('strong',currentName(vehicle)),timetableNode('small','DETECTADO','timetable-current-badge'));
      button.append(head,timetableNode('span',currentRoute(vehicle),'timetable-result-route'));
      const detail=[vehicle.line,vehicle.next_station?`Próxima: ${vehicle.next_station}`:'',
        Number.isInteger(vehicle.delay_minutes)?`Demora publicada: ${timetableDelayLabel(vehicle.delay_minutes)}`:''].filter(Boolean).join(' · ');
      if(detail)button.append(timetableNode('span',detail,'timetable-result-time'));
      const matchLabel=live.matches.has(vehicle.id)?'Paradas programadas disponibles':!state.index && state.timetableStatus==='loading'?'Cargando horarios…':
        !state.index && state.timetableStatus==='error'?'Horarios no disponibles':'Sin itinerario inequívoco asociado';
      button.append(timetableNode('span',matchLabel,'timetable-current-match'));
      button.addEventListener('click',()=>selectCurrent(vehicle.id));container.append(button);
    }
    const more=timetableElement('timetableCurrentMore');more.hidden=live.status!=='ready' || live.limit>=live.filtered.length;
    more.textContent=`Mostrar más (${Math.max(0,live.filtered.length-live.limit)} restantes)`;
  }
  function renderCurrentMap() {
    const live=state.current;currentLayer.clearLayers();
    const enabled=timetableElement('timetableCurrentMap').checked;
    if(!enabled)return;
    const vehicles=live.filtered.slice(0,800);
    const selectedVehicle=live.vehicles.find(v=>v.id===live.selectedId);
    if(selectedVehicle && !vehicles.some(v=>v.id===selectedVehicle.id))vehicles.push(selectedVehicle);
    for(const vehicle of vehicles) {
      const selected=vehicle.id===live.selectedId,commuter=vehicle.time_basis==='feed';
      const marker=L.circleMarker([vehicle.latitude,vehicle.longitude],{radius:selected?7:4,weight:selected?2:1.3,
        color:'#fff',fillColor:selected?'#ef9f43':commuter?'#338d82':'#367eb7',fillOpacity:.9}).addTo(currentLayer);
      const tooltip=timetableNode('div');
      tooltip.append(timetableNode('strong',currentName(vehicle)),timetableNode('span',` · ${currentRoute(vehicle)}`));
      tooltip.append(timetableNode('small',commuter?' · hora GPS individual no verificada':' · posición con hora individual publicada'));
      marker.bindTooltip(tooltip);marker.on('click',()=>selectCurrent(vehicle.id));
    }
  }
  function updateCurrentStatus(summary=null) {
    const live=state.current,status=timetableElement('timetableCurrentStatus');
    if(!summary && live.payload)summary=summarizeLive(live.payload,Date.now()/1000);
    if(live.status==='paused'){status.textContent='Consulta pausada mientras esta vista o pestaña está oculta.';return;}
    if(live.status==='loading'){status.textContent='Consultando la flota actual de RadarDeTrenes…';return;}
    if(live.status==='rate'){status.textContent='SIN DATOS RECIENTES · el proveedor limita las consultas; se respetará su tiempo de espera.';return;}
    if(live.status!=='ready'){status.textContent='SIN DATOS RECIENTES · la fuente no está disponible o la instantánea está desactualizada.';return;}
    const observed=summary?.cercanias?.feed_time_fallback ?? live.vehicles.filter(v=>v.time_basis==='feed').length;
    const times=[summary?.cercanias?.header_timestamp,summary?.larga?.header_timestamp].filter(Number.isFinite);
    const last=times.length ? timetableLiveClock.format(new Date(Math.min(...times)*1000)) : '—';
    status.textContent=`RadarDeTrenes · Renfe / ADIF · instantánea ${last} Madrid · cobertura parcial · ${observed} sin hora GPS individual verificada${live.filtered.length>800?' · mapa limitado a 800 puntos':''}.`;
  }
  function updateCurrentFromPayload() {
    const live=state.current,summary=live.payload ? summarizeLive(live.payload,Date.now()/1000) : null;
    live.status=summary?.usable?'ready':'stale';
    live.vehicles=summary?.usable ? summary.vehicles : [];
    live.matches=state.index ? matchLiveJourneys(state.index,live.vehicles,Date.now()) : new Map();
    const selectedVehicle=live.vehicles.find(v=>v.id===live.selectedId);
    // A train id can be reused for another run. Never attach that new point to
    // an old selected itinerary if its route or unique service date changes.
    if(selectedVehicle && (currentIdentity(selectedVehicle)!==live.selectedSignature ||
       (live.selectedKey && live.matches.get(live.selectedId)?.key!==live.selectedKey))) {
      live.selectedId=null;live.selectedKey=null;live.selectedSignature='';live.pendingMatch=false;
      if(!state.selected){
        drawUnmatchedCurrent(null);
        timetableElement('timetableJourneyMeta').textContent='Ya no se puede verificar que sea la misma circulación.';
      }
    }
    // If a train was selected before the timetable was available, associate
    // it when both the GTFS and that same fresh identity are present. This
    // also works if the user temporarily left the view during the download.
    if(live.pendingMatch && state.index && live.selectedId && selectedVehicle) {
      const journey=live.matches.get(live.selectedId);live.pendingMatch=false;
      if(journey)selectJourney(journey,{liveId:live.selectedId});
    }
    renderCurrentList();renderCurrentMap();updateCurrentStatus(summary);
    if(state.selected)updateResults({preserveSelection:true});
    else if(live.selectedId)drawUnmatchedCurrent(selectedVehicle || null);
    clearTimeout(live.expiry);live.expiry=null;
    if(live.status==='ready' && currentCanPoll()) {
      const deadlines=[summary.cercanias,summary.larga].filter(f=>['fresh','partial'].includes(f.status)).map(f=>f.header_timestamp*1000+90001);
      deadlines.push(...live.vehicles.map(v=>v.observed_at*1000+90001));
      if(deadlines.length)live.expiry=setTimeout(updateCurrentFromPayload,Math.max(1,Math.min(...deadlines)-Date.now()));
    }
  }
  function stopCurrentPolling() {
    const live=state.current;clearTimeout(live.timer);clearTimeout(live.expiry);live.timer=null;live.expiry=null;
    live.sequence++;live.busy=false;live.payload=null;live.vehicles=[];live.matches=new Map();live.status='paused';
    renderCurrentList();renderCurrentMap();updateCurrentStatus();
    if(state.selected && live.selectedId)updateResults({preserveSelection:true});
    else if(live.selectedId)drawUnmatchedCurrent(null);
  }
  async function refreshCurrentFleet() {
    const live=state.current;if(!currentCanPoll()||live.busy)return;
    live.busy=true;const sequence=++live.sequence;
    if(!live.payload){
      live.status='loading';updateCurrentStatus();
      if(state.selected && live.selectedId)updateResults({preserveSelection:true});
      else if(live.selectedId)drawUnmatchedCurrent(null);
    }
    try {
      const payload=await fetchRadarPositions('espana');
      if(sequence!==live.sequence || !currentCanPoll())return;
      live.payload=payload;updateCurrentFromPayload();
    } catch(error) {
      if(sequence!==live.sequence || !currentCanPoll())return;
      clearTimeout(live.expiry);live.expiry=null;
      live.payload=null;live.vehicles=[];live.matches=new Map();live.status=error?.status===429?'rate':'error';
      renderCurrentList();renderCurrentMap();updateCurrentStatus();
      if(state.selected && live.selectedId)updateResults({preserveSelection:true});
      else if(live.selectedId)drawUnmatchedCurrent(null);
    } finally {
      if(sequence===live.sequence){live.busy=false;clearTimeout(live.timer);if(currentCanPoll())live.timer=setTimeout(refreshCurrentFleet,LIVE_POLL_MS);}
    }
  }
  function selectCurrent(id) {
    const live=state.current,vehicle=live.vehicles.find(v=>v.id===id);if(!vehicle)return;
    live.selectedId=id;live.selectedKey=null;live.selectedSignature=currentIdentity(vehicle);live.pendingMatch=!state.index && state.timetableStatus==='loading';
    const journey=live.matches.get(id);
    state.windowEnd=Date.now();timetableElement('timetableRange').value='1440';
    if(journey) {
      selectJourney(journey,{liveId:id});
    } else {
      state.selectionVersion++;stopAuto();state.selected=null;state.boardValues.clear();state.stationStates.clear();state.lastCycle=null;state.markers.clear();drawing.clearLayers();
      timetableElement('timetableJourneyHeading').textContent=currentName(vehicle);
      timetableElement('timetableBoardRefresh').disabled=true;
      drawUnmatchedCurrent(vehicle,{focus:true});
      updateClock();renderList();renderCurrentList();renderCurrentMap();
      if(window.matchMedia?.('(max-width:650px)').matches)timetableElement('timetableJourneyHeading').scrollIntoView({behavior:'smooth',block:'center'});
    }
  }
  timetableElement('timetableCurrentSearch').addEventListener('input',()=>{state.current.limit=8;renderCurrentList();renderCurrentMap();updateCurrentStatus();});
  timetableElement('timetableCurrentType').addEventListener('change',()=>{state.current.limit=8;renderCurrentList();renderCurrentMap();updateCurrentStatus();});
  timetableElement('timetableCurrentMap').addEventListener('change',renderCurrentMap);
  timetableElement('timetableCurrentMore').addEventListener('click',()=>{state.current.limit+=8;renderCurrentList();});
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
    if(document.hidden){pauseAuto();stopCurrentPolling();}
    else if(state.active){advanceWindow();refreshCurrentFleet();if(state.selected)refreshBoards();}
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
  // Timetable downloads can be slow or fail independently of Radar. Do not
  // block showing the live fleet while the scheduled dataset is loading.
  async function loadTimetable() {
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),45000);
    try {
      let payload=window.RAIL_TIMETABLE_SAMPLE;
      if(!payload){const response=await fetch(TIMETABLE_URL,{signal:controller.signal});if(!response.ok)throw new Error(`HTTP ${response.status}`);payload=await response.json();}
      state.index=indexTimetable(payload);state.timetableStatus='ready';
      const [av,cer]=payload.sources;
      const captured=Date.parse(payload.generated_at);
      const date=Number.isFinite(captured)?formatTimetableTime(captured):'desconocida';
      state.statusBase=`Instantánea ${date} · Días de servicio incluidos: AV/LD/MD ${timetableDateLabel(av.included_from)}–${timetableDateLabel(av.included_until)}; Cercanías ${timetableDateLabel(cer.included_from)}–${timetableDateLabel(cer.included_until)}. Puede haber horarios incompletos o cambios.`;
      timetableElement('timetableRange').disabled=false;timetableElement('timetableSearch').disabled=false;
      updateResults({preserveSelection:true});
      if(state.current.payload)updateCurrentFromPayload();
    } catch(error) {
      state.timetableStatus='error';state.current.pendingMatch=false;
      const reason=controller.signal.aborted?'tiempo de espera agotado':error.message;
      timetableElement('timetableDatasetStatus').textContent=`No se pudieron cargar los horarios: ${reason}.`;
      timetableElement('timetableCount').textContent='—';
      timetableElement('timetableResults').replaceChildren(timetableNode('p','No hay una instantánea de horarios disponible.','timetable-empty'));
      if(state.current.payload) {
        renderCurrentList();renderCurrentMap();
        if(!state.selected && state.current.selectedId)drawUnmatchedCurrent(state.current.vehicles.find(v=>v.id===state.current.selectedId) || null);
      }
      console.error(error);
    } finally {clearTimeout(timeout);}
  }
  loadTimetable();
  return {
    show(){
      state.active=true;
      requestAnimationFrame(()=>map.invalidateSize({animate:false}));
      advanceWindow();
      if(!document.hidden)refreshCurrentFleet();
      if(state.selected && !document.hidden)refreshBoards();else updateBoardStatus();
    },
    hide(){state.active=false;pauseAuto();stopCurrentPolling();},
    map,
  };
}
