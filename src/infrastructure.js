// Static OpenStreetMap infrastructure. These objects do not describe the
// present signal aspect, a movement authority, or a validated route.
const INFRA_TYPES = ['signal','switch','crossing','milestone'];
const INFRA_LIMIT = 600;
const INFRA_ZOOM = 12;
const INFRA_LABELS = {signal:'Señal ferroviaria',switch:'Aguja',crossing:'Cruce o paso a nivel',milestone:'Hito kilométrico'};
const INFRA_COLORS = {signal:'#ad8dff',switch:'#58b8ce',crossing:'#f1b567',milestone:'#93a9a1'};
const INFRA_TAG_FIELDS = [
  ['ref','Referencia'], ['operator','Operador'], ['railway:position:exact','PK exacto'], ['railway:position','PK'],
  ['railway:signal:main','Señal principal'], ['railway:signal:main:function','Función OSM'],
  ['railway:signal:main:form','Forma OSM'], ['railway:signal:direction','Sentido relativo a la vía OSM'],
  ['railway:signal:position','Posición relativa a la vía OSM'],
  ['railway:signal:main:states','Aspectos posibles, no actuales'],
  ['railway:signal:speed_limit:speed','Velocidad indicada en OSM'],
  ['railway:signal:electricity','Señal de electrificación'],
  ['railway:switch','Tipo de aguja'], ['railway:turnout_side','Lado de la aguja'],
  ['railway:switch:electric','Accionamiento eléctrico'], ['railway:local_operated','Accionamiento local'],
  ['crossing:barrier','Barrera'], ['crossing:light','Luces de cruce'], ['crossing:bell','Aviso sonoro'],
  ['crossing:supervision','Supervisión'], ['supervised','Supervisado'],
];
const INFRA_TRACK_FIELDS = [
  ['ref','Referencia'], ['railway','Tipo de vía'], ['maxspeed','Velocidad máxima etiquetada'],
  ['maxspeed:forward','Velocidad en sentido OSM directo'], ['maxspeed:backward','Velocidad en sentido OSM inverso'],
  ['gauge','Ancho (mm)'], ['electrified','Electrificación'], ['voltage','Tensión (V)'], ['frequency','Frecuencia (Hz)'],
  ['operator','Operador'], ['owner','Titular'], ['usage','Uso OSM'], ['service','Vía de servicio'],
  ['railway:track_ref','Referencia de vía'], ['tracks','Número de vías etiquetadas'],
  ['railway:traffic_mode','Tráfico OSM'], ['passenger_lines','Líneas de viajeros etiquetadas'],
  ['highspeed','Alta velocidad etiquetada'], ['railway:asfa','ASFA'], ['railway:asfa_200','ASFA 200'],
  ['railway:etcs','ETCS'], ['construction:railway:etcs','ETCS en construcción'],
  ['railway:lzb','LZB'], ['railway:pzb','PZB'], ['railway:ato','ATO'], ['railway:atc','ATC'], ['railway:atp','ATP'],
  ['railway:bidirectional','Circulación bidireccional'], ['railway:preferred_direction','Sentido preferente OSM'],
  ['bridge','Puente'], ['tunnel','Túnel'], ['layer','Nivel OSM'], ['location','Ubicación'], ['start_date','Fecha OSM'],
];

export function infrastructureCategory(kind) {
  return kind==='level_crossing' || kind==='crossing' ? 'crossing' : INFRA_TYPES.includes(kind) ? kind : null;
}
export function infrastructureTrackFields(tags) {
  const source=tags && typeof tags==='object' ? tags : {};
  return INFRA_TRACK_FIELDS.filter(([key])=>source[key]!==undefined && source[key]!==null && String(source[key]).trim()!=='')
    .map(([key,label])=>({key,label,value:String(source[key])}));
}
function infrastructureElement(tag,text,className='') {
  const el=document.createElement(tag); if (className) el.className=className; el.textContent=text; return el;
}
function infrastructureRow(container,label,value) {
  const row=document.createElement('p'); row.className='infra-popup-row';
  const title=infrastructureElement('b',label+': '); row.append(title,document.createTextNode(String(value))); container.append(row);
}
function infrastructureRawTags(container,tags) {
  const entries=Object.entries(tags || {}).filter(([,value])=>value!==null && value!==undefined).sort(([a],[b])=>a.localeCompare(b));
  if (!entries.length) return;
  const details=document.createElement('details'), summary=infrastructureElement('summary',`Ver ${entries.length} etiquetas OSM`);
  details.className='infra-raw-tags'; details.append(summary);
  for (const [key,value] of entries) infrastructureRow(details,key,value);
  container.append(details);
}
function infrastructureOsmLink(container,kind,id) {
  if (!/^\d+$/.test(String(id))) return;
  const link=infrastructureElement('a',`Ver ${kind} ${id} en OpenStreetMap`);
  link.href=`https://www.openstreetmap.org/${kind}/${id}`;link.target='_blank';link.rel='noopener noreferrer';link.className='infra-osm-link';container.append(link);
}

/** Build a safe DOM popup for either the national feature or a local way. */
export function infrastructureTrackPopup({id,tags={},name='',groupLabel='VÍA FERROVIARIA OSM'}) {
  const popup=document.createElement('div'); popup.className='national-popup infra-popup';
  popup.append(infrastructureElement('small',groupLabel+' · DATOS OSM'));
  popup.append(infrastructureElement('strong',name || tags.name || 'Tramo ferroviario'));
  const fields=infrastructureTrackFields(tags);
  if (!fields.length) popup.append(infrastructureElement('p','Este tramo no tiene más atributos disponibles en el extracto.'));
  for (const field of fields) infrastructureRow(popup,field.label,field.value);
  infrastructureRawTags(popup,tags);
  popup.append(infrastructureElement('p',`Way OSM ${id} · etiquetas colaborativas, no verificadas para explotación. No son límites ni autorizaciones operativas.`, 'infra-caution'));
  infrastructureOsmLink(popup,'way',id);
  return popup;
}

export function infrastructureNodePopup(feature) {
  const [id,, ,kind,tags]=feature, category=infrastructureCategory(kind);
  const popup=document.createElement('div'); popup.className='national-popup infra-popup';
  popup.append(infrastructureElement('small',`${INFRA_LABELS[category] || 'ELEMENTO FERROVIARIO'} · DATOS OSM`));
  popup.append(infrastructureElement('strong',tags?.name || (tags?.ref ? `${INFRA_LABELS[category]} ${tags.ref}` : INFRA_LABELS[category])));
  for (const [key,label] of INFRA_TAG_FIELDS) if (tags?.[key]!==undefined && String(tags[key]).trim()) infrastructureRow(popup,label,tags[key]);
  infrastructureRawTags(popup,tags);
  popup.append(infrastructureElement('p',category==='signal'
    ? 'Ubicación y atributos estáticos de OSM. El estado o aspecto actual de la señal no está disponible.'
    : 'Ubicación y atributos estáticos de OSM; no indican el estado actual ni una autorización de paso.','infra-caution'));
  infrastructureOsmLink(popup,'node',id);
  return popup;
}

let infrastructureDataPromise=null;
export function loadInfrastructureData() {
  if (!infrastructureDataPromise) {
    infrastructureDataPromise=(async()=>{
      const embedded=window.RAIL_INFRASTRUCTURE;
      const response=embedded ? null : await fetch('./data/infraestructura-osm.json');
      if (response && !response.ok) throw new Error(`HTTP ${response.status}`);
      const data=embedded || await response.json();
      if (!Array.isArray(data.features) || !data.counts) throw new Error('Formato de infraestructura no válido');
      return data;
    })().catch(error=>{infrastructureDataPromise=null;throw error;});
  }
  return infrastructureDataPromise;
}

/** A single canvas per map; only visible nodes are turned into markers. */
export async function initializeInfrastructure(map, prefix, {canOpen=()=>true}={}) {
  const status=document.getElementById(`${prefix}InfraStatus`);
  const visible=kind=>Boolean(document.getElementById(`${prefix}Infra-${kind}`)?.checked);
  const layer=L.layerGroup().addTo(map);
  map.createPane('infra-osm'); map.getPane('infra-osm').style.zIndex='445';
  // A full-size Canvas must not intercept clicks intended for underlying ways.
  // Hit-test only the visible OSM points from the map's click event instead.
  map.getPane('infra-osm').style.pointerEvents='none';
  const renderer=L.canvas({pane:'infra-osm',padding:.2});
  let data, renderedNodes=[];
  try { data=await loadInfrastructureData(); }
  catch (_) { status.textContent='No se pudieron cargar los elementos OSM.'; return {render:()=>{}}; }
  const groups=Object.fromEntries(INFRA_TYPES.map(type=>[type,[]]));
  for (const item of data.features) {
    if (!Array.isArray(item) || item.length<5 || !Number.isFinite(item[1]) || !Number.isFinite(item[2])) continue;
    const type=infrastructureCategory(item[3]); if (type) groups[type].push(item);
  }
  for (const type of INFRA_TYPES) {
    const total=document.getElementById(`${prefix}InfraCount-${type}`);
    if (total) total.textContent=groups[type].length.toLocaleString('es-ES');
  }
  function render() {
    layer.clearLayers(); renderedNodes=[];
    if (map.getZoom()<INFRA_ZOOM) {status.textContent=`Acerca el mapa (zoom ${INFRA_ZOOM}+) para ver elementos OSM.`;return;}
    const enabled=INFRA_TYPES.filter(visible);
    if (!enabled.length) {status.textContent='Todas las capas de elementos están ocultas.';return;}
    const bounds=map.getBounds(), counts=Object.fromEntries(INFRA_TYPES.map(type=>[type,0]));
    let count=0, limited=false;
    for (const type of enabled) {
      for (const item of groups[type]) {
        if (!bounds.contains([item[1],item[2]])) continue;
        if (count>=INFRA_LIMIT) {limited=true;break;}
        L.circleMarker([item[1],item[2]],{
          pane:'infra-osm',renderer,radius:type==='signal' ? 5 : 4,weight:1.6,
          color:'#ffffff',fillColor:INFRA_COLORS[type],fillOpacity:.96,interactive:false,
        }).addTo(layer);
        renderedNodes.push(item); count++;counts[type]++;
      }
      if (limited) break;
    }
    const names={signal:'señales',switch:'agujas',crossing:'cruces',milestone:'hitos'};
    const parts=enabled.map(type=>`${counts[type]} ${names[type]}`);
    status.textContent=`${parts.join(' · ')}${limited ? ` · máximo ${INFRA_LIMIT}, amplía el mapa` : ''}.`;
    if (!count) status.textContent+=' OSM puede estar incompleto.';
  }
  for (const type of INFRA_TYPES) document.getElementById(`${prefix}Infra-${type}`)?.addEventListener('change',render);
  map.on('moveend',render);
  const exampleButton=document.getElementById(`${prefix}InfraExample`);
  const example=groups.signal.find(item=>item[4]?.['railway:signal:main:states']) || groups.signal[0];
  if (exampleButton && example) {
    exampleButton.disabled=false;
    exampleButton.addEventListener('click',()=>{
      const checkbox=document.getElementById(`${prefix}Infra-signal`);
      if (checkbox) checkbox.checked=true;
      map.setView([example[1],example[2]],16,{animate:false});
      render();
      L.popup().setLatLng([example[1],example[2]]).setContent(infrastructureNodePopup(example)).openOn(map);
    });
  }
  map.on('click',event=>{
    if (!canOpen() || !renderedNodes.length) return;
    const target=map.latLngToContainerPoint(event.latlng);
    let best=null, distance=9;
    for (const item of renderedNodes) {
      const candidate=map.latLngToContainerPoint([item[1],item[2]]).distanceTo(target);
      if (candidate<distance) {best=item;distance=candidate;}
    }
    if (best) {
      event.infrastructureHandled=true;
      L.popup().setLatLng([best[1],best[2]]).setContent(infrastructureNodePopup(best)).openOn(map);
    }
  });
  render();
  return {render};
}
