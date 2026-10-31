// Match current, attributed fleet observations to scheduled Renfe journeys.
// A match enriches the live card with planned stops; it does not prove the
// actual path taken, nor turn a scheduled arrival into a real arrival.
import { gtfsServiceStart, madridCalendarDate } from './timetable.js?v=15';

const liveJourneyDayMs=86400000;
const liveJourneyAfterArrivalMs=6*60*60*1000;
const liveJourneyBeforeDepartureMs=2*60*60*1000;
const liveJourneyIndexCache=new WeakMap();
function liveJourneyCode(value) {
  if(typeof value!=='string' || !/^\d{1,12}$/.test(value.trim()))return '';
  return value.trim().replace(/^0+(?=\d)/,'');
}
function liveJourneyKey(feed,train,origin,destination) {
  const parts=[liveJourneyCode(train),liveJourneyCode(origin),liveJourneyCode(destination)];
  return [0,1].includes(feed) && parts.every(Boolean) ? `${feed}|${parts.join('|')}` : '';
}
function liveJourneyPatternIndex(index) {
  let groups=liveJourneyIndexCache.get(index);
  if(groups)return groups;
  groups=new Map();
  for(const pattern of index.patterns || []) {
    const visits=pattern.visits || [];
    if(visits.length<2)continue;
    const key=liveJourneyKey(pattern.feed,pattern.code,visits[0].station.code,visits.at(-1).station.code);
    if(!key)continue;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(pattern);
  }
  liveJourneyIndexCache.set(index,groups);return groups;
}

/** Results are keyed by the source identity; zero or multiple candidates are
 * deliberately left unmatched, even when the train number alone is equal. */
export function matchLiveJourneys(index,vehicles,now=Date.now()) {
  const result=new Map();
  if(!index || !Number.isFinite(index.first) || !Number.isInteger(index.days) || !Array.isArray(vehicles) || !Number.isFinite(now))return result;
  const date=madridCalendarDate(now),civil=date ? Date.parse(`${date}T00:00:00Z`) : NaN;
  if(!Number.isFinite(civil))return result;
  const today=Math.floor((civil-index.first)/liveJourneyDayMs),days=[];
  for(let dayIndex=Math.max(0,today-3);dayIndex<=Math.min(index.days-1,today+1);dayIndex++) {
    const serviceDate=new Date(index.first+dayIndex*liveJourneyDayMs).toISOString().slice(0,10);
    if(!index.serviceStarts.has(dayIndex))index.serviceStarts.set(dayIndex,gtfsServiceStart(serviceDate));
    const serviceStart=index.serviceStarts.get(dayIndex);
    if(Number.isFinite(serviceStart))days.push({dayIndex,serviceDate,serviceStart,bit:1n<<BigInt(dayIndex)});
  }
  const groups=liveJourneyPatternIndex(index);
  for(const vehicle of vehicles) {
    if(!vehicle || typeof vehicle.id!=='string' || !vehicle.id || vehicle.route_ambiguous)continue;
    const feed=vehicle.source==='cercanias' || vehicle.type==='commuter' ? 1 :
      vehicle.source==='larga_distancia' || vehicle.type==='long_distance' ? 0 : -1;
    const key=liveJourneyKey(feed,vehicle.label,vehicle.origin_code,vehicle.destination_code);
    if(!key)continue;
    const matches=[];
    for(const pattern of groups.get(key) || [])for(const day of days) {
      if(!(pattern.mask&day.bit))continue;
      const first=pattern.visits[0],last=pattern.visits.at(-1);
      const departure=day.serviceStart+first.departure*1000,arrival=day.serviceStart+last.arrival*1000;
      if(departure>now+liveJourneyBeforeDepartureMs || arrival<now-liveJourneyAfterArrivalMs)continue;
      matches.push({pattern,dayIndex:day.dayIndex,serviceStart:day.serviceStart,serviceDate:day.serviceDate,
        departure,arrival,key:`${pattern.id}:${day.dayIndex}`});
    }
    if(matches.length===1)result.set(vehicle.id,matches[0]);
  }
  return result;
}
