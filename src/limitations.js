// ADIF LTV: a published snapshot of temporary speed restrictions, NOT live
// disruption alerts, physical railway signals, or simulator instructions.
export const LTV_POLL_MS = 300000;
const LTV_PAGE = 'https://www.arcgis.com/home/item.html?id=5e62ef71f0614bb3b007df238607e8bf';
const LTV_VIEWER = 'https://ltv-adif.hub.arcgis.com/';
const LTV_ATTRIBUTION = '© Administrador de infraestructuras ferroviarias';
const LTV_CLOCK = new Intl.DateTimeFormat('es-ES', {
  timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',
});
const LTV_DAY = new Intl.DateTimeFormat('es-ES', {timeZone:'Europe/Madrid',day:'2-digit',month:'2-digit'});

export function ltvDisplayTime(value) {
  if (!Number.isFinite(value) || value<=0) return 'fecha desconocida';
  const date=new Date(value*1000);
  return Number.isFinite(date.getTime()) ? `${LTV_CLOCK.format(date)} (Madrid)` : 'fecha desconocida';
}
function ltvDay(value) {
  if (!Number.isFinite(value) || value<=0) return 'fecha desconocida';
  const date=new Date(value*1000);
  return Number.isFinite(date.getTime()) ? LTV_DAY.format(date) : 'fecha desconocida';
}
function ltvNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString('es-ES',{minimumFractionDigits:3,maximumFractionDigits:3}) : 'no indicado';
}
function ltvSpeed(value) {
  return Number.isFinite(value) ? `${value.toLocaleString('es-ES')} km/h` : 'velocidad no indicada';
}
function ltvValidRecord(record, needsPoint) {
  if (!record || typeof record.id!=='string' || !record.id || typeof record.line_code!=='string') return false;
  if (!needsPoint) return record.location===null;
  const point=record.location;
  return point && Number.isFinite(point.latitude) && point.latitude>=-90 && point.latitude<=90 &&
    Number.isFinite(point.longitude) && point.longitude>=-180 && point.longitude<=180;
}

/** Validate API or bundled snapshot. An unavailable source is not an empty list. */
export function validLtvSnapshot(payload) {
  if (!payload || payload.kind!=='adif-ltv' || !['recent','stale','unknown'].includes(payload.status) ||
      !Array.isArray(payload.records) || !Array.isArray(payload.unlocated) || payload.count!==payload.records.length ||
      !Number.isFinite(payload.generated_at) || !Number.isFinite(payload.fetched_at)) return false;
  if (!payload.records.every(record=>ltvValidRecord(record,true)) ||
      !payload.unlocated.every(record=>ltvValidRecord(record,false))) return false;
  const ids=[...payload.records,...payload.unlocated].map(record=>record.id);
  return new Set(ids).size===ids.length;
}

/** Age the *source* data, not the HTTP response or the browser query time. */
export function ltvFreshness(payload, now) {
  const edited=payload?.source_edited_at, effective=payload?.file_effective_at;
  const limit=Number.isFinite(payload?.stale_seconds) && payload.stale_seconds>0 ? payload.stale_seconds : 21600;
  if (!Number.isFinite(now) || !Number.isFinite(edited) || !Number.isFinite(effective) ||
      edited<=0 || effective<=0 || edited>now+60 || effective>now+60) return 'unknown';
  return now-Math.min(edited,effective)>limit ? 'stale' : 'recent';
}

function ltvElement(tag,text,className='') {
  const node=document.createElement(tag); if (className) node.className=className;
  node.textContent=text; return node;
}
function ltvRow(parent,label,value) {
  const row=document.createElement('p'); row.append(ltvElement('b',`${label}: `),document.createTextNode(String(value))); parent.append(row);
}
function ltvExternalLink(label,url) {
  const link=ltvElement('a',label,'infra-osm-link');
  link.href=url; link.target='_blank'; link.rel='noopener noreferrer'; return link;
}

export function ltvPopup(record,payload,mode,freshness) {
  const popup=document.createElement('div'); popup.className='national-popup infra-popup ltv-popup';
  popup.append(ltvElement('small','LTV · REFERENCIA PUBLICADA POR ADIF'));
  popup.append(ltvElement('strong',`Línea ${record.line_code || 'sin código'} · ${ltvSpeed(record.speed_kmh)}`));
  if (record.line_name) ltvRow(popup,'Línea',record.line_name);
  ltvRow(popup,'PK inicial → final',`${ltvNumber(record.pk_start)} → ${ltvNumber(record.pk_end)}`);
  if (record.tracks) ltvRow(popup,'Vías según Adif',record.tracks);
  if (record.from || record.to) ltvRow(popup,'Dependencias',`${record.from || '—'} → ${record.to || '—'}`);
  if (Number.isFinite(record.ltv_id)) ltvRow(popup,'ID LTV',record.ltv_id);
  ltvRow(popup,'Última edición de datos Adif',ltvDisplayTime(payload.source_edited_at));
  ltvRow(popup,'Fecha del archivo de Adif',ltvDisplayTime(payload.file_effective_at));
  const ageText=mode!=='server' ? 'Instantánea guardada o última consulta fallida. No confirma el estado actual.'
    : freshness==='stale' ? 'Datos antiguos. La situación actual puede haber cambiado.'
    : freshness==='unknown' ? 'No se puede comprobar la fecha de la fuente. Vigencia desconocida.'
    : 'Dato de publicación reciente; no confirma el estado operativo al minuto.';
  popup.append(ltvElement('p',`${ageText} El punto es una referencia geográfica de Adif, no una señal física ni necesariamente el inicio o fin del tramo. Una LTV no es por sí sola una avería o un corte.`, 'infra-caution'));
  popup.append(ltvExternalLink('Abrir el visor oficial de Adif ↗',LTV_VIEWER));
  popup.append(ltvElement('p',LTV_ATTRIBUTION));
  return popup;
}

/** Add a separately styled, optional ADIF snapshot layer to the national map. */
export function initializeLimitations(map) {
  const el=id=>document.getElementById(id);
  const layer=L.layerGroup().addTo(map);
  map.attributionControl.addAttribution(`&copy; <a href="${LTV_PAGE}" target="_blank" rel="noopener noreferrer">Administrador de infraestructuras ferroviarias</a>`);
  let snapshot=null, mode='loading', receivedAt=0, lastAttemptAt=0, busy=false, markerById=new Map(), lastRenderKey='';
  const enabled=()=>Boolean(el('ltvToggle').checked);
  const clockNow=()=>mode==='server' && snapshot ? snapshot.generated_at+Math.max(0,(performance.now()-receivedAt)/1000) : Date.now()/1000;
  const networkCapable=()=>/^https?:$/.test(window.location.protocol);
  const badge=(freshness)=>{
    if (!snapshot) return ['SIN DATOS','offline'];
    if (mode!=='server') return ['INSTANTÁNEA','offline'];
    if (freshness==='stale') return ['DATO ANTIGUO','offline'];
    if (freshness==='unknown') return ['FECHA DESCONOCIDA','offline'];
    return ['PUBLICACIÓN RECIENTE','partial'];
  };

  function render() {
    const stateKey=JSON.stringify([mode,enabled(),snapshot?.generated_at,snapshot?.fetched_at,snapshot?.count,
      snapshot ? ltvFreshness(snapshot,clockNow()) : 'none']);
    if (stateKey===lastRenderKey) return;
    lastRenderKey=stateKey;
    layer.clearLayers(); markerById=new Map();
    const list=el('ltvList'),unlocatedList=el('ltvUnlocatedList');
    list.replaceChildren();unlocatedList.replaceChildren();
    if (!snapshot) {
      el('ltvBadge').textContent=mode==='loading' ? 'CARGANDO' : 'SIN DATOS';
      el('ltvBadge').className='live-badge offline';
      el('ltvCount').textContent='—';
      el('ltvSourceDate').textContent='No se ha podido consultar la fuente.';
      el('ltvFileDate').textContent='No hay fecha de archivo disponible.';
      el('ltvQueryDate').textContent=mode==='loading' ? 'Cargando…' : 'Sin instantánea; consulta el visor oficial.';
      el('ltvMapStatus').textContent='LTV ADIF · SIN DATOS';
      el('ltvMapStatus').className='ltv-map-status warning';
      el('ltvListSummary').textContent='Sin registros disponibles';
      el('ltvUnlocatedSummary').textContent='Sin registros disponibles';
      el('ltvCoverage').textContent='No se puede conocer el número de limitaciones.';
      return;
    }
    const freshness=ltvFreshness(snapshot,clockNow());
    const [text,style]=badge(freshness);
    el('ltvBadge').textContent=text;el('ltvBadge').className=`live-badge ${style}`;
    el('ltvCount').textContent=snapshot.records.length.toLocaleString('es-ES');
    el('ltvSourceDate').textContent=`Última edición Adif: ${ltvDisplayTime(snapshot.source_edited_at)}`;
    el('ltvFileDate').textContent=`Archivo Adif: ${ltvDisplayTime(snapshot.file_effective_at)}`;
    const sourceLabel=mode==='server' ? 'Consulta al servidor' : mode==='bundled' ? 'Instantánea incluida' : 'Última consulta fallida; se conserva la instantánea';
    el('ltvQueryDate').textContent=`${sourceLabel}: ${ltvDisplayTime(snapshot.fetched_at)}`;
    el('ltvMapStatus').textContent=enabled()
      ? `LTV ADIF · ${ltvDay(snapshot.source_edited_at)} · ${mode!=='server' ? 'INSTANTÁNEA' : freshness==='stale' ? 'DATO ANTIGUO' : freshness==='unknown' ? 'FECHA DESCONOCIDA' : 'NO ES AVISO EN DIRECTO'}`
      : 'LTV ADIF · CAPA OCULTA';
    el('ltvMapStatus').className='ltv-map-status warning';
    const unknown=Math.max(0,Number(snapshot.unknown_classification)||0);
    el('ltvCoverage').textContent=`${snapshot.unlocated.length} sin geometría AV identificada${unknown ? ` · ${unknown} sin PK clasificable` : ''}. Clasificación por código y PK en catálogo Adif (${ltvDisplayTime(snapshot.catalog_edited_at)}).`;
    el('ltvListSummary').textContent=`Ver ${snapshot.records.length} referencias localizadas`;
    el('ltvUnlocatedSummary').textContent=`Ver ${snapshot.unlocated.length} sin geometría`;
    for (const record of snapshot.records) {
      // The icon markup contains only a validated number, never remote text.
      const speed=Number.isFinite(record.speed_kmh) && record.speed_kmh>=0 && record.speed_kmh<=500 ? String(Math.round(record.speed_kmh)) : '?';
      const icon=L.divIcon({className:'ltv-marker',html:`<span class="ltv-pin">${speed}</span>`,iconSize:[28,28],iconAnchor:[14,14]});
      const marker=L.marker([record.location.latitude,record.location.longitude],{
        icon,zIndexOffset:1000,title:`LTV Adif ${record.line_code} · ${ltvSpeed(record.speed_kmh)} · vigencia no confirmada`,
        alt:`Referencia LTV Adif en línea ${record.line_code}, vigencia no confirmada`,
      }).bindPopup(ltvPopup(record,snapshot,mode,freshness));
      markerById.set(record.id,marker);
      if (enabled()) marker.addTo(layer);
      const button=ltvElement('button',`Línea ${record.line_code} · PK ${ltvNumber(record.pk_start)} · ${ltvSpeed(record.speed_kmh)}`,'ltv-list-button');
      button.type='button'; button.addEventListener('click',()=>{
        el('ltvToggle').checked=true;
        // Recreate only if the layer was hidden; preserve correct popup content.
        if (!layer.hasLayer(marker)) render();
        const target=markerById.get(record.id);
        map.setView([record.location.latitude,record.location.longitude],Math.max(map.getZoom(),11),{animate:false});
        target?.openPopup();
        if (window.matchMedia('(max-width:650px)').matches) el('nationalMap').scrollIntoView({behavior:'smooth',block:'center'});
      });
      list.append(button);
    }
    for (const record of snapshot.unlocated) {
      const item=ltvElement('li',`Línea ${record.line_code || '—'} · PK ${ltvNumber(record.pk_start)} → ${ltvNumber(record.pk_end)} · ${ltvSpeed(record.speed_kmh)}. Sin geometría.`);
      unlocatedList.append(item);
    }
    if (!snapshot.unlocated.length) unlocatedList.append(ltvElement('li','No hay registros AV sin geometría en esta consulta; no significa que la red esté libre de incidencias.'));
  }

  async function refresh() {
    if (busy) return;
    lastAttemptAt=performance.now();
    if (!networkCapable()) {mode=snapshot ? 'bundled' : 'offline';render();return;}
    busy=true;el('ltvRefresh').disabled=true;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),45000);
    try {
      const response=await fetch('./api/limitaciones',{cache:'no-store',signal:controller.signal});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload=await response.json();
      if (!validLtvSnapshot(payload)) throw new Error('Fuente no disponible o respuesta no válida');
      snapshot=payload;mode='server';receivedAt=lastAttemptAt;
    } catch (_) { mode=snapshot ? 'offline' : 'error'; }
    finally {clearTimeout(timeout);busy=false;el('ltvRefresh').disabled=false;render();}
  }
  el('ltvToggle').addEventListener('change',render);
  el('ltvRefresh').addEventListener('click',refresh);
  setInterval(()=>{if (!document.hidden && !el('nationalView').hidden) refresh();},LTV_POLL_MS);
  setInterval(()=>{if (snapshot && !document.hidden && !el('nationalView').hidden) render();},60000);
  document.addEventListener('visibilitychange',()=>{
    if (!document.hidden && !el('nationalView').hidden && performance.now()-lastAttemptAt>=LTV_POLL_MS) refresh();
  });
  (async()=>{
    try {
      const embedded=window.RAIL_LTV_SAMPLE;
      const response=embedded ? null : await fetch('./data/limitaciones-adif.json');
      if (response && !response.ok) throw new Error('Instantánea no disponible');
      const data=embedded || await response.json();
      if (!validLtvSnapshot(data)) throw new Error('Instantánea no válida');
      snapshot=data;mode='bundled';render();
    } catch (_) {mode='error';render();}
    await refresh();
  })();
  return {show(){ if (mode==='loading') return; if (!lastAttemptAt || performance.now()-lastAttemptAt>=LTV_POLL_MS) refresh(); else render(); }};
}
