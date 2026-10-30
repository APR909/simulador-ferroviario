// GTFS-RT reported trip cancellations, located at the scheduled ORIGIN only.
// These are not incident causes or coordinates of an infrastructure failure.
export const CANCELLATION_POLL_MS=30000;
const CANCELLATION_WINDOW=24*60*60;
const CANCELLATION_CLOCK=new Intl.DateTimeFormat('es-ES',{
  timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',
});
const cancellationEl=id=>document.getElementById(id);
function cancellationTime(value) {
  if (!Number.isFinite(value) || value<=0) return 'fecha no indicada';
  const date=new Date(value*1000);
  return Number.isFinite(date.getTime()) ? `${CANCELLATION_CLOCK.format(date)} (Madrid)` : 'fecha no indicada';
}
function cancellationNode(tag,text,className='') {
  const node=document.createElement(tag);if(className)node.className=className;node.textContent=text;return node;
}
function cancellationRow(parent,label,text) {
  const row=document.createElement('p');row.append(cancellationNode('b',`${label}: `),document.createTextNode(String(text)));parent.append(row);
}
function cancellationExternal(label,url) {
  const a=cancellationNode('a',label,'infra-osm-link');a.href=url;a.target='_blank';a.rel='noopener noreferrer';return a;
}
function cancellationRecordValid(record) {
  if (!record || typeof record.id!=='string' || !record.id || typeof record.trip_id!=='string' || !record.trip_id ||
      typeof record.origin!=='string' || typeof record.destination!=='string' ||
      !['AVE','AVE INT','AVLO','AVANT','AVANT EXP'].includes(record.service_name) ||
      !Number.isFinite(record.planned_departure) || record.planned_departure<=0 ||
      !(record.individual_timestamp===null || (Number.isFinite(record.individual_timestamp) && record.individual_timestamp>0))) return false;
  if (record.location===null) return true;
  const p=record.location;
  return p && Number.isFinite(p.latitude) && p.latitude>=-90 && p.latitude<=90 &&
    Number.isFinite(p.longitude) && p.longitude>=-180 && p.longitude<=180;
}
export function validCancellationPayload(payload) {
  if (!payload || payload.kind!=='renfe-av-cancellations' || !['fresh','partial','stale','error'].includes(payload.status) ||
      !Number.isFinite(payload.generated_at) || !Array.isArray(payload.records)) return false;
  if (['stale','error'].includes(payload.status)) return payload.count===null && payload.records.length===0;
  if (!Number.isFinite(payload.header_timestamp) || payload.header_timestamp<=0 ||
      payload.count!==payload.records.length || payload.records.length>20000 || !payload.records.every(cancellationRecordValid)) return false;
  return new Set(payload.records.map(r=>r.id)).size===payload.records.length;
}
/** Re-age the feed itself, never the HTTP response; hide old cancellation pins. */
export function cancellationFreshness(payload,now) {
  if (!payload || payload.status==='error') return 'error';
  if (payload.status==='stale') return 'stale';
  const age=now-payload.header_timestamp;
  if (!Number.isFinite(age) || age < -30 || age>90) return 'stale';
  return payload.status;
}
export function cancellationRecordRecent(record,now) {
  if (record.individual_timestamp===null) return true; // retain with unknown-age warning
  const age=now-record.individual_timestamp;
  return Number.isFinite(age) && age>=-30 && age<=90;
}
export function cancellationPopup(record,payload) {
  const popup=cancellationNode('div','','national-popup infra-popup cancel-popup');
  popup.append(cancellationNode('small','RENFE · CANCELACIÓN DE UN VIAJE'));
  popup.append(cancellationNode('strong',`${record.service_name} · salida cancelada`));
  cancellationRow(popup,'Trayecto previsto',`${record.origin} → ${record.destination}`);
  cancellationRow(popup,'Salida prevista',cancellationTime(record.planned_departure));
  cancellationRow(popup,'ID del viaje',record.trip_id);
  cancellationRow(popup,'Hora del feed Renfe',cancellationTime(payload.header_timestamp));
  cancellationRow(popup,'Fecha individual del aviso',cancellationTime(record.individual_timestamp));
  popup.append(cancellationNode('p','El marcador corresponde a la estación de salida del horario, no al punto de una avería o corte. La causa no se proporciona. Un feed reciente no garantiza la fecha de cada aviso.', 'infra-caution'));
  popup.append(cancellationExternal('Datos de Renfe · GTFS-RT ↗','https://data.renfe.com/dataset/horarios-viaje-alta-velocidad-larga-media-distancia'));
  return popup;
}

export function initializeCancellations(map) {
  const el=cancellationEl, layer=L.layerGroup().addTo(map);
  let payload=null, mode='loading', receivedAt=0, lastAttemptAt=0, busy=false, markerById=new Map(),lastKey='';
  const enabled=()=>Boolean(el('cancelToggle').checked);
  const now=()=>payload ? payload.generated_at+Math.max(0,(performance.now()-receivedAt)/1000) : Date.now()/1000;
  const networkCapable=()=>/^https?:$/.test(window.location.protocol);
  function render() {
    const current=now();let freshness=payload ? cancellationFreshness(payload,current) : mode;
    const within=['fresh','partial'].includes(freshness) ? payload.records.filter(r=>r.planned_departure>=current && r.planned_departure<=current+CANCELLATION_WINDOW) : [];
    const active=within.filter(r=>cancellationRecordRecent(r,current));
    const newlyOld=within.length-active.length,missingDates=active.filter(r=>r.individual_timestamp===null).length;
    if(freshness==='fresh' && (newlyOld || missingDates))freshness='partial';
    const key=JSON.stringify([mode,freshness,enabled(),payload?.header_timestamp,payload?.generated_at,active.map(r=>r.id),newlyOld,missingDates]);
    if(key===lastKey)return;
    lastKey=key;layer.clearLayers();markerById=new Map();
    const list=el('cancelList');list.replaceChildren();
    if (!payload || !['fresh','partial'].includes(freshness)) {
      const status=mode==='loading' ? 'CARGANDO' : mode==='offline' ? 'SIN SERVIDOR' : freshness==='stale' ? 'FEED ANTIGUO' : 'SIN DATOS';
      el('cancelBadge').textContent=status;el('cancelBadge').className='live-badge offline';el('cancelCount').textContent='—';
      el('cancelSourceDate').textContent=payload?.header_timestamp ? `Feed Renfe: ${cancellationTime(payload.header_timestamp)}` : 'No hay fecha de feed disponible.';
      el('cancelCoverage').textContent=mode==='offline' ? 'Abre la aplicación con servidor.py para consultar Renfe.' :
        freshness==='stale' ? 'El feed está atrasado; no se muestran marcadores.' : 'Fuente no disponible: no se puede conocer el número de cancelaciones.';
      el('cancelListSummary').textContent='Sin datos disponibles';
      list.append(cancellationNode('p','No se puede concluir que no haya cancelaciones. Consulta la información oficial de los operadores.','cancel-list-empty'));
      return;
    }
    el('cancelBadge').textContent=freshness==='partial' ? 'DATOS PARCIALES' : 'FEED RECIENTE';
    el('cancelBadge').className=`live-badge ${freshness==='partial'?'partial':'fresh'}`;
    el('cancelCount').textContent=active.length.toLocaleString('es-ES');
    el('cancelSourceDate').textContent=`Feed Renfe: ${cancellationTime(payload.header_timestamp)} · fecha individual puede no estar disponible`;
    const unmatched=Math.max(0,Number(payload.unmatched_trips)||0),ambiguous=Math.max(0,Number(payload.ambiguous_trips)||0);
    const old=Math.max(0,Number(payload.stale_individual_updates)||0)+newlyOld;
    el('cancelCoverage').textContent=freshCoverage(unmatched,ambiguous,freshness,old,missingDates);
    el('cancelListSummary').textContent=`Ver ${active.length} cancelaciones identificadas`;
    if(!active.length) list.append(cancellationNode('p','Ninguna cancelación identificable en las próximas 24 h. Esto no significa que no haya incidencias o cancelaciones.','cancel-list-empty'));
    for(const record of active) {
      if(record.location) {
        const icon=L.divIcon({className:'cancel-marker',html:'<span class="cancel-pin">×</span>',iconSize:[28,28],iconAnchor:[14,14]});
        const marker=L.marker([record.location.latitude,record.location.longitude],{
          icon,zIndexOffset:1500,title:`Cancelación Renfe · salida prevista en ${record.origin}`,
          alt:`Cancelación Renfe en la estación de salida prevista ${record.origin}`,
        }).bindPopup(cancellationPopup(record,payload));
        markerById.set(record.id,marker);if(enabled())marker.addTo(layer);
        const button=cancellationNode('button',`${record.service_name} · ${record.origin} → ${record.destination} · ${cancellationTime(record.planned_departure)}`,'ltv-list-button');button.type='button';
        button.addEventListener('click',()=>{
          el('cancelToggle').checked=true;if(!layer.hasLayer(marker))render();
          map.setView([record.location.latitude,record.location.longitude],Math.max(map.getZoom(),11),{animate:false});
          markerById.get(record.id)?.openPopup();
          if(window.matchMedia('(max-width:650px)').matches)el('nationalMap').scrollIntoView({behavior:'smooth',block:'center'});
        });list.append(button);
      } else {
        list.append(cancellationNode('p',`${record.service_name} · ${record.origin} → ${record.destination} · ${cancellationTime(record.planned_departure)} · sin coordenadas válidas de origen.`,'cancel-list-empty'));
      }
    }
  }
  async function refresh() {
    if(busy)return;lastAttemptAt=performance.now();
    if(!networkCapable()){payload=null;mode='offline';render();return;}
    busy=true;el('cancelRefresh').disabled=true;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
    try {
      const response=await fetch('./api/cancelaciones-av',{cache:'no-store',signal:controller.signal});
      if(!response.ok)throw new Error(`HTTP ${response.status}`);
      const data=await response.json();if(!validCancellationPayload(data))throw new Error('Feed no válido');
      // Count the entire request duration against freshness; never extend it
      // by assuming a delayed response was generated at arrival time.
      payload=data;receivedAt=lastAttemptAt;mode='server';
    } catch (_) {payload=null;mode='error';}
    finally {clearTimeout(timer);busy=false;el('cancelRefresh').disabled=false;render();}
  }
  el('cancelToggle').addEventListener('change',render);el('cancelRefresh').addEventListener('click',refresh);
  setInterval(()=>{if(!document.hidden&&!el('nationalView').hidden)refresh();},CANCELLATION_POLL_MS);
  setInterval(()=>{if(!document.hidden&&!el('nationalView').hidden)render();},5000);
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden&&!el('nationalView').hidden&&performance.now()-lastAttemptAt>=CANCELLATION_POLL_MS)refresh();
  });
  refresh();
  return {show(){if(!lastAttemptAt||performance.now()-lastAttemptAt>=CANCELLATION_POLL_MS)refresh();else render();}};
}
function freshCoverage(unmatched,ambiguous,status,old,missingDates) {
  const excluded=[];
  if(ambiguous)excluded.push(`${ambiguous} aviso(s) con fecha o viaje ambiguo`);
  if(unmatched)excluded.push(`${unmatched} viaje(s) sin identificar en GTFS`);
  if(old)excluded.push(`${old} aviso(s) con fecha individual antigua o futura`);
  const omitted=excluded.length ? `${excluded.join(' · ')} no situados. ` : '';
  const unknown=missingDates ? `${missingDates} mostrado(s) sin fecha individual. ` : '';
  return omitted+unknown+(!omitted&&!unknown&&status==='partial'?'El feed es parcial. ':'')+
    'Solo cancelaciones Renfe identificadas; no es un diagnóstico completo de la red.';
}
