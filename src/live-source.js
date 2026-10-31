// A static host such as GitHub Pages cannot run servidor.py. Prefer our
// same-origin API when present, otherwise consume the attributed public
// RadarDeTrenes API directly in the browser (never a generic CORS proxy).
import { LIVE_POLL_MS, recentTimestamp } from './realtime.js?v=12';

export const RADAR_BROWSER_URL='https://radardetrenes.com/api/v1/fleet?type=all';
const RADAR_BROWSER_MAX_TRAINS=20000;
const RADAR_BROWSER_MAX_BYTES=4_000_000;
const RADAR_BROWSER_FRESH_SECONDS=90;
const RADAR_BROWSER_BOXES={
  sevilla:[{south:37.14,north:37.60,west:-6.28,east:-5.68}],
  espana:[{south:35.0,north:44.4,west:-9.8,east:4.6}, {south:27.4,north:29.8,west:-18.5,east:-13.0}],
};

/** Parse an explicit RFC3339 timezone; never guess local time. */
export function parseRadarBrowserTime(value) {
  if(typeof value!=='string' || value.length>80)return null;
  const m=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/);
  if(!m)return null;
  const [,year,month,day,hour,minute,second,zone]=m;
  const y=Number(year),mo=Number(month),d=Number(day),hh=Number(hour),mm=Number(minute),ss=Number(second);
  if(y<1970 || y>9999 || mo<1 || mo>12 || d<1 || d>new Date(Date.UTC(y,mo,0)).getUTCDate() || hh>23 || mm>59 || ss>59)return null;
  if(zone!=='Z' && (Number(zone.slice(1,3))>23 || Number(zone.slice(4,6))>59))return null;
  // Radar can send nanoseconds; normalize to milliseconds for browsers whose
  // RFC3339 parser accepts only the three digits required by ECMAScript.
  const normalized=value.replace(/\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/,(_,fraction)=>'.'+fraction.slice(0,3).padEnd(3,'0'));
  const valueSeconds=Date.parse(normalized)/1000;
  return Number.isFinite(valueSeconds) && valueSeconds>0 && valueSeconds<253402300800 ? valueSeconds : null;
}
function radarBrowserText(value,max=150) {return typeof value==='string' ? value.trim().slice(0,max) : '';}
function radarBrowserInBoxes(lat,lon,boxes) {return boxes.some(b=>lat>=b.south&&lat<=b.north&&lon>=b.west&&lon<=b.east);}

/** Validate the snapshot, preserve real identity and suppress contradictory fixes. */
export function parseRadarBrowserFleet(payload) {
  const header=parseRadarBrowserTime(payload?.updatedAt);
  if(!header || !Array.isArray(payload?.trains) || !Number.isInteger(payload.count) || payload.count!==payload.trains.length || payload.count>RADAR_BROWSER_MAX_TRAINS)
    throw new Error('La respuesta RadarDeTrenes no contiene una instantánea válida.');
  const byId=new Map(),invalid={long_distance:0,commuter:0,unknown:0};
  for(const row of payload.trains) {
    const type=row?.type;
    if(type!=='long_distance'&&type!=='commuter'){invalid.unknown++;continue;}
    const identifier=radarBrowserText(row.id,100),label=radarBrowserText(row.trainCode,100),timestamp=parseRadarBrowserTime(row.timestamp);
    const latitude=row.latitude,longitude=row.longitude;
    if(!identifier || !label || !timestamp || !Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude< -90 || latitude>90 || longitude< -180 || longitude>180) {invalid[type]++;continue;}
    const trip=radarBrowserText(row.tripId,100);
    const entry={id:`radar:${identifier}`,label,trip_id:trip,trip_ids:trip?[trip]:[],latitude,longitude,observed_at:timestamp,
      // The independent commuter feed currently appears to stamp positions at
      // aggregation time. Until an individual GPS time can be verified, do not
      // animate its points or present that time as an exact GPS measurement.
      time_basis:type==='commuter'?'feed':'vehicle',speed_mps:null,bearing:null,
      service_name:radarBrowserText(row.productName,100)||null,product_category:radarBrowserText(row.productCategory,30),
      origin:radarBrowserText(row.originName),destination:radarBrowserText(row.destinationName),
      origin_code:radarBrowserText(row.originCode,30),destination_code:radarBrowserText(row.destinationCode,30),
      line:radarBrowserText(row.line,40),next_station:radarBrowserText(row.nextStationName,150),
      delay_minutes:Number.isInteger(row.delayMinutes) && Math.abs(row.delayMinutes)<=720 ? row.delayMinutes : null,
      source_provider:'radar',service_identification:'radar_product',reported_stale:row.stale===true,type,
      _positions:[[latitude,longitude]]};
    const key=`${type}:${identifier}`,previous=byId.get(key);
    if(!previous || entry.observed_at>previous.observed_at)byId.set(key,entry);
    else if(entry.observed_at===previous.observed_at){
      if(!previous._positions.some(([a,b])=>a===latitude&&b===longitude))previous._positions.push([latitude,longitude]);
      if(entry.service_name!==previous.service_name || entry.product_category!==previous.product_category){previous.service_name=null;previous.product_category='';}
      if(entry.trip_id!==previous.trip_id){previous.trip_id='';previous.trip_ids=[];}
      // Contradictory route identifiers must never be joined to a scheduled trip.
      if(entry.label!==previous.label || entry.origin_code!==previous.origin_code || entry.destination_code!==previous.destination_code) {
        previous.origin_code='';previous.destination_code='';previous.route_ambiguous=true;
      }
      if(entry.line!==previous.line)previous.line='';
      if(entry.next_station!==previous.next_station)previous.next_station='';
      if(entry.delay_minutes!==previous.delay_minutes)previous.delay_minutes=null;
      previous.reported_stale ||= entry.reported_stale;
    }
  }
  const valid=[],ambiguous=[];
  for(const value of byId.values()) {
    if(value._positions.length>1)ambiguous.push(value);
    else {const {_positions,...vehicle}=value;valid.push(vehicle);}
  }
  return {header,valid,ambiguous,invalid};
}

/** Scope and age the cached snapshot at the time it is displayed. */
export function radarBrowserSnapshot(parsed,scope,now,fetchedAt=now) {
  const boxes=RADAR_BROWSER_BOXES[scope];if(!boxes || !Number.isFinite(now))throw new Error('Ámbito u hora no válidos.');
  const fresh=recentTimestamp(parsed.header,now,RADAR_BROWSER_FRESH_SECONDS);
  function makeFeed(type) {
    const base={label:type==='commuter'?'Cercanías · RadarDeTrenes':'Renfe AV / Larga y Media Distancia · RadarDeTrenes',
      dataset:'https://radardetrenes.com/docs',source_provider:'radar',access_mode:'browser',fetched_at:fetchedAt,
      header_timestamp:parsed.header,attribution:'Datos de Renfe y ADIF, a través de RadarDeTrenes (servicio independiente)'};
    if(!fresh)return {...base,status:'stale',count:null,vehicles:[],message:'La instantánea RadarDeTrenes está atrasada o es futura.'};
    const area=parsed.valid.filter(v=>v.type===type&&radarBrowserInBoxes(v.latitude,v.longitude,boxes));
    const recent=area.filter(v=>!v.reported_stale && recentTimestamp(v.observed_at,now,RADAR_BROWSER_FRESH_SECONDS));
    const excludedStale=area.filter(v=>!v.reported_stale && !recentTimestamp(v.observed_at,now,RADAR_BROWSER_FRESH_SECONDS)).length;
    const excludedReported=area.filter(v=>v.reported_stale).length;
    const ambiguous=parsed.ambiguous.filter(v=>v.type===type&&v._positions.some(([lat,lon])=>radarBrowserInBoxes(lat,lon,boxes))).length;
    // RadarDeTrenes does not report independent upstream availability per type;
    // even a current empty snapshot is only partial coverage, not all trains.
    return {...base,status:'partial',count:recent.length,vehicles:recent,excluded_stale:excludedStale,
      excluded_reported_stale:excludedReported,excluded_ambiguous:ambiguous,
      excluded_invalid:parsed.invalid[type]+parsed.invalid.unknown,feed_time_fallback:recent.filter(v=>v.time_basis==='feed').length};
  }
  const cercanias=makeFeed('commuter'),larga=makeFeed('long_distance');
  return {scope,generated_at:now,fresh_seconds:RADAR_BROWSER_FRESH_SECONDS,cache_seconds:LIVE_POLL_MS/1000,
    service_catalog:{status:'radar_product',matched:larga.vehicles.filter(v=>v.service_name).length,fetched_at:fetchedAt,dataset:'https://radardetrenes.com/docs'},
    feeds:{cercanias,larga_distancia:larga},coverage:'Consulta directa a RadarDeTrenes; cobertura parcial de Renfe, no total de trenes.'};
}

/** One shared upstream fetch per browser per 30 s, including failed attempts. */
export function createLiveSource({fetchImpl=(...args)=>globalThis.fetch(...args),clock=()=>Date.now()/1000,
  monotonic=()=>performance.now(),protocol=()=>globalThis.location?.protocol||'https:'}={}) {
  let cached=null,lastAttempt=null,pending=null,lastError=null;
  async function directSnapshot(scope) {
    const elapsed=lastAttempt===null ? Infinity : monotonic()-lastAttempt;
    if(!pending && (lastAttempt===null || elapsed<0 || elapsed>=LIVE_POLL_MS)) {
      lastAttempt=monotonic();
      pending=(async()=>{
        const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
        try {
          const response=await fetchImpl(RADAR_BROWSER_URL,{method:'GET',credentials:'omit',cache:'default',signal:controller.signal});
          if(!response.ok)throw new Error(`RadarDeTrenes HTTP ${response.status}`);
          const length=Number(response.headers?.get?.('content-length'));
          if(Number.isFinite(length) && length>RADAR_BROWSER_MAX_BYTES)throw new Error('Respuesta RadarDeTrenes demasiado grande.');
          const text=await response.text();
          if(text.length>RADAR_BROWSER_MAX_BYTES)throw new Error('Respuesta RadarDeTrenes demasiado grande.');
          cached={parsed:parseRadarBrowserFleet(JSON.parse(text)),fetchedAt:clock()};lastError=null;
        } catch(error) {cached=null;lastError=error;}
        finally {clearTimeout(timeout);}
      })();
      pending.finally(()=>{pending=null;});
    }
    if(pending)await pending;
    if(!cached)throw lastError || new Error('RadarDeTrenes no disponible.');
    return radarBrowserSnapshot(cached.parsed,scope,clock(),cached.fetchedAt);
  }
  async function get(scope,{signal,forceRadar=false}={}) {
    if(!RADAR_BROWSER_BOXES[scope])throw new Error('Ámbito no válido.');
    if(signal?.aborted)throw new DOMException('Consulta cancelada.','AbortError');
    if(!forceRadar && /^https?:$/.test(protocol())) {
      const url=scope==='espana'?'./api/trenes?ambito=espana':'./api/trenes';
      try {
        const response=await fetchImpl(url,{cache:'no-store',signal});
        if(!response.ok)throw new Error(`API local HTTP ${response.status}`);
        const payload=await response.json();
        const validFeed=feed=>feed && ['fresh','partial','stale','error'].includes(feed.status);
        if(payload?.scope!==scope || !Number.isFinite(payload.generated_at) || !validFeed(payload.feeds?.cercanias) || !validFeed(payload.feeds?.larga_distancia))throw new Error('API local no válida.');
        return payload;
      } catch(error) {if(signal?.aborted)throw error;}
    }
    const payload=await directSnapshot(scope);
    if(signal?.aborted)throw new DOMException('Consulta cancelada.','AbortError');
    return payload;
  }
  return {get};
}
const sharedLiveSource=createLiveSource();
export function fetchLivePositions(scope,options) {return sharedLiveSource.get(scope,options);}
/** Consistent attributed fleet for itinerary matching, even with a local API. */
export function fetchRadarPositions(scope,options={}) {return sharedLiveSource.get(scope,{...options,forceRadar:true});}
