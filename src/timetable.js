// Static, attributed GTFS schedules. These are plans, not a history of GPS
// observations and not evidence that a train actually ran.
export const TIMETABLE_URL = './data/itinerarios-renfe.json';
export const TIMETABLE_ZONE = 'Europe/Madrid';
export const TIMETABLE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TIMETABLE_BOARD_REFRESH_MS = 45 * 1000;
export const TIMETABLE_BOARD_MAX_AGE_MS = 120 * 1000;
const timetableBoardFutureToleranceMs = 30 * 1000;
const timetableDayMs = 86400000;
const timetableMadridParts = new Intl.DateTimeFormat('en-CA', {
  timeZone:TIMETABLE_ZONE, year:'numeric', month:'2-digit', day:'2-digit',
});
const timetableMadridOffset = new Intl.DateTimeFormat('en-US', {
  timeZone:TIMETABLE_ZONE, timeZoneName:'shortOffset', hour:'numeric', hourCycle:'h23',
});
const timetableDisplay = new Intl.DateTimeFormat('es-ES', {
  timeZone:TIMETABLE_ZONE, day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23',
});

function timetableParseDate(value) {
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))return null;
  const [year,month,day]=value.split('-').map(Number);
  const utc=Date.UTC(year,month-1,day);
  const d=new Date(utc);
  if(year<1970 || year>9998 || d.getUTCFullYear()!==year || d.getUTCMonth()!==month-1 || d.getUTCDate()!==day)return null;
  return utc;
}
function timetableCivilFromUtc(utc) {
  const date=new Date(utc);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
}
export function madridCalendarDate(timestamp) {
  if(!Number.isFinite(timestamp))return null;
  const values=Object.fromEntries(timetableMadridParts.formatToParts(new Date(timestamp)).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return values.year&&values.month&&values.day ? `${values.year}-${values.month}-${values.day}` : null;
}
export function formatTimetableTime(timestamp) {
  if(!Number.isFinite(timestamp))return '—';
  return timetableDisplay.format(new Date(timestamp)).replace(',', ' ·');
}
/** GTFS service time is measured from local noon minus twelve elapsed hours.
 * This matters on daylight-saving changeovers and for times beyond 24:00. */
export function gtfsServiceStart(date) {
  const civil=timetableParseDate(date);
  if(civil===null)return null;
  const noonAsUtc=civil+12*3600000;
  const label=timetableMadridOffset.formatToParts(new Date(noonAsUtc)).find(p=>p.type==='timeZoneName')?.value;
  const match=typeof label==='string' && label.match(/^GMT(?:(\+|-)(\d{1,2})(?::(\d{2}))?)?$/);
  if(!match)return null;
  const minutes=match[1] ? (match[1]==='+' ? 1 : -1)*(Number(match[2])*60+Number(match[3]||0)) : 0;
  if(Math.abs(minutes)>14*60)return null;
  return noonAsUtc-minutes*60000-12*3600000;
}
export function timetableSearchText(value) {
  return String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es-ES').trim();
}

/** Validate data at the trust boundary; reject bad rows instead of guessing. */
export function indexTimetable(data) {
  const first=timetableParseDate(data?.start_date);
  if(data?.schema!==1 || data.timezone!==TIMETABLE_ZONE || first===null || !Number.isInteger(data.days) || data.days<1 || data.days>93 ||
     !Array.isArray(data.stops) || data.stops.length>100000 || !Array.isArray(data.trips) || data.trips.length>250000 ||
     !Array.isArray(data.sources) || data.sources.length!==2 || data.sources[0]?.id!=='av' || data.sources[1]?.id!=='cer')
    throw new Error('La instantánea de horarios no tiene el formato esperado.');
  const stations=data.stops.map(row=>Array.isArray(row) && row.length>=4 && typeof row[0]==='string' && row[0].length<=100 &&
    typeof row[1]==='string' && row[1].length>0 && row[1].length<=200 && Number.isFinite(row[2]) && row[2]>=-90 && row[2]<=90 &&
    Number.isFinite(row[3]) && row[3]>=-180 && row[3]<=180 ? {code:row[0],name:row[1],latitude:row[2],longitude:row[3]} : null);
  const validMask=(1n<<BigInt(data.days))-1n;
  let discarded=0;
  const patterns=[];
  for(const row of data.trips) {
    if(!Array.isArray(row) || row.length!==5 || ![0,1].includes(row[0]) || typeof row[1]!=='string' || !row[1] || row[1].length>80 ||
       typeof row[2]!=='string' || row[2].length>100 || typeof row[3]!=='string' || !/^[0-9a-f]{1,24}$/i.test(row[3]) ||
       !Array.isArray(row[4]) || row[4].length<6 || row[4].length>900 || row[4].length%3) {discarded++;continue;}
    let mask;try{mask=BigInt('0x'+row[3]);}catch(_){discarded++;continue;}
    if(mask===0n || (mask&~validMask)!==0n){discarded++;continue;}
    const visits=[];let last=-1,okay=true;
    for(let i=0;i<row[4].length;i+=3) {
      const [stationIndex,arrival,departure]=row[4].slice(i,i+3);
      if(!Number.isInteger(stationIndex) || !stations[stationIndex] || !Number.isInteger(arrival) || !Number.isInteger(departure) ||
         arrival<last || departure<arrival || departure>72*3600-1){okay=false;break;}
      visits.push({station:stations[stationIndex],arrival,departure});last=departure;
    }
    if(!okay){discarded++;continue;}
    const search=timetableSearchText([row[1],row[2],...visits.map(v=>v.station.name)].join(' '));
    patterns.push({id:patterns.length,feed:row[0],code:row[1],route:row[2],mask,visits,search});
  }
  return {first,days:data.days,patterns,discarded,metadata:data,serviceStarts:new Map()};
}

/** Scheduled services covering the selected instant, never an inferred GPS position. */
export function findTimetableJourneys(index, instant, {query='',av=true,commuter=true}={}) {
  if(!index || !Number.isFinite(instant))return [];
  const selectedDate=madridCalendarDate(instant),civil=timetableParseDate(selectedDate);
  if(civil===null)return [];
  const day=Math.floor((civil-index.first)/timetableDayMs), candidates=[];
  // A GTFS time can be 71:59:59; include the next service date for the
  // exceptional spring DST start where GTFS noon-minus-12h is before midnight.
  for(let dayIndex=Math.max(0,day-3);dayIndex<=Math.min(index.days-1,day+1);dayIndex++) {
    if(!index.serviceStarts.has(dayIndex))index.serviceStarts.set(dayIndex,gtfsServiceStart(timetableCivilFromUtc(index.first+dayIndex*timetableDayMs)));
    const start=index.serviceStarts.get(dayIndex);
    if(start!==null)candidates.push({dayIndex,start,bit:1n<<BigInt(dayIndex)});
  }
  const needle=timetableSearchText(query),found=[];
  for(const pattern of index.patterns) {
    if((pattern.feed===0&&!av)||(pattern.feed===1&&!commuter)||(needle&&!pattern.search.includes(needle)))continue;
    for(const candidate of candidates) {
      if(!(pattern.mask&candidate.bit))continue;
      const first=pattern.visits[0],last=pattern.visits[pattern.visits.length-1];
      const departure=candidate.start+first.departure*1000,arrival=candidate.start+last.arrival*1000;
      if(departure<=instant && instant<=arrival)found.push({pattern,dayIndex:candidate.dayIndex,serviceStart:candidate.start,
        serviceDate:timetableCivilFromUtc(index.first+candidate.dayIndex*timetableDayMs),departure,arrival,
        key:`${pattern.id}:${candidate.dayIndex}`});
    }
  }
  return found.sort((a,b)=>a.departure-b.departure || a.pattern.code.localeCompare(b.pattern.code,'es',{numeric:true}));
}

function timetableCanonicalCode(value) {
  if(typeof value!=='string')return '';
  const raw=value.trim();
  return /^\d+$/.test(raw) ? raw.replace(/^0+(?=\d)/,'') : raw;
}
/** A recent fetch alone is not enough: check the source's own timestamp. */
export function isTimetableBoardFresh(board,now=Date.now()) {
  return Number.isFinite(now) && Number.isFinite(board?.updatedAt) &&
    now-board.updatedAt<=TIMETABLE_BOARD_MAX_AGE_MS && now-board.updatedAt>=-timetableBoardFutureToleranceMs;
}
export function isTimetableBoardValueFresh(value,now=Date.now()) {
  return Number.isFinite(now) && Number.isFinite(value?.updatedAt) && Number.isFinite(value?.validUntil) &&
    now>=value.updatedAt-timetableBoardFutureToleranceMs && now<=value.validUntil;
}
/** Match a board row only with the same train, station, route endpoints and
 * planned event time. `plannedTime` is scheduled; the displayed estimate/real
 * time is explicitly calculated as plannedTime + the published delay. */
export function matchBoardEvent(board, journey, stopIndex, kind, now=Date.now()) {
  if(!journey || !['arrivals','departures'].includes(kind) || !isTimetableBoardFresh(board,now) || !Array.isArray(board[kind]))return null;
  const visits=journey.pattern.visits, stop=visits[stopIndex];
  if(!stop)return null;
  const expected=journey.serviceStart+(kind==='arrivals'?stop.arrival:stop.departure)*1000;
  const stationCode=timetableCanonicalCode(stop.station.code),firstCode=timetableCanonicalCode(visits[0].station.code),
    lastCode=timetableCanonicalCode(visits[visits.length-1].station.code),train=timetableCanonicalCode(journey.pattern.code);
  // Non-numeric IDs are not guaranteed to be a Renfe/ADIF station or train code.
  if(!/^\d+$/.test(stationCode) || !/^\d+$/.test(train))return null;
  const matches=[];
  for(const row of board[kind].slice(0,500)) {
    if(!row || timetableCanonicalCode(row.trainCode)!==train || timetableCanonicalCode(row.stationCode)!==stationCode ||
       !Number.isFinite(row.plannedTime) || Math.abs(row.plannedTime-expected)>60000 ||
       !['ESTIMATED','REAL'].includes(row.timeType) || !Number.isInteger(row.delayMinutes) || Math.abs(row.delayMinutes)>720)continue;
    if(!row.originCode || !row.destinationCode || timetableCanonicalCode(row.originCode)!==firstCode || timetableCanonicalCode(row.destinationCode)!==lastCode)continue;
    if((journey.pattern.feed===0 && row.trafficType==='CERCANIAS') || (journey.pattern.feed===1 && row.trafficType==='AVLDMD'))continue;
    if(/CANCEL|SUPRIM|ANUL/i.test(String(row.circulationState||'')+' '+String(row.announceState||'')))continue;
    if(row.timestamp!=null && !Number.isFinite(row.timestamp))continue;
    if(Number.isFinite(row.timestamp) && (now-row.timestamp>TIMETABLE_BOARD_MAX_AGE_MS || now-row.timestamp< -timetableBoardFutureToleranceMs))continue;
    const time=row.plannedTime+row.delayMinutes*60000;
    if(row.timeType==='REAL' && time>now+timetableBoardFutureToleranceMs)continue;
    const validUntil=Math.min(board.updatedAt,Number.isFinite(row.timestamp)?row.timestamp:board.updatedAt)+TIMETABLE_BOARD_MAX_AGE_MS;
    matches.push({kind:row.timeType==='REAL'?'real':'estimada',time,delayMinutes:row.delayMinutes,updatedAt:board.updatedAt,validUntil});
  }
  // Conflicting matching rows are ambiguous and must not be reported as facts.
  if(!matches.length || matches.some(m=>m.time!==matches[0].time || m.kind!==matches[0].kind))return null;
  return {...matches[0],validUntil:Math.min(...matches.map(match=>match.validUntil))};
}

export function createBoardSource({fetchImpl=(...args)=>globalThis.fetch(...args),clock=()=>Date.now()}={}) {
  const cache=new Map();
  async function get(code,{signal}={}) {
    if(typeof code!=='string' || !/^\d{1,8}$/.test(code))throw new Error('Código de estación no válido.');
    if(signal?.aborted)throw new DOMException('Consulta cancelada.','AbortError');
    const key=timetableCanonicalCode(code),now=clock();
    for(const [cachedKey,item] of cache)if(!item.pending && (now-item.at<0 || now-item.at>=30000))cache.delete(cachedKey);
    const old=cache.get(key);
    // Never attach a new selection to a request canceled by an older selection.
    if(old && now-old.at>=0 && now-old.at<30000 && !(old.pending && old.signal?.aborted))return old.promise;
    // Keep long browsing sessions bounded without evicting requests in flight.
    for(const [cachedKey,item] of cache)if(cache.size>=48 && !item.pending)cache.delete(cachedKey);
    const entry={at:now,signal,pending:true,promise:null};
    entry.promise=(async()=>{
      const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
      const cancel=()=>controller.abort();
      signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted)controller.abort();
      try {
        const response=await fetchImpl(`https://radardetrenes.com/api/v1/stations/${encodeURIComponent(key)}/board-renfe`,
          {method:'GET',credentials:'omit',signal:controller.signal});
        if(!response.ok) {
          const error=new Error(`Tablón HTTP ${response.status}`);error.status=response.status;
          if(response.status===429) {
            const raw=response.headers?.get?.('retry-after'),seconds=raw && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
            const delay=Number.isFinite(seconds) ? seconds*1000 : raw ? Date.parse(raw)-clock() : NaN;
            error.retryAfterMs=Number.isFinite(delay)&&delay>0 ? delay : 120000;
          }
          throw error;
        }
        const length=Number(response.headers?.get?.('content-length'));
        if(Number.isFinite(length)&&length>1000000)throw new Error('Tablón demasiado grande.');
        const text=await response.text();if(text.length>1000000)throw new Error('Tablón demasiado grande.');
        const board=JSON.parse(text);
        if(!Number.isFinite(board?.updatedAt)||!Array.isArray(board.arrivals)||!Array.isArray(board.departures))throw new Error('Tablón no válido.');
        return board;
      } finally {clearTimeout(timeout);signal?.removeEventListener('abort',cancel);}
    })();
    cache.set(key,entry);
    try {return await entry.promise;}
    catch(error){if(cache.get(key)===entry)cache.delete(key);throw error;}
    finally{entry.pending=false;}
  }
  return {get};
}
