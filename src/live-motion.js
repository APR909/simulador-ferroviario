// Animate only BETWEEN two already received, individual GPS observations.
// The straight interpolation is a visual estimate, not a railway route or
// an extrapolation. When a source expires the caller removes its markers.
import { isExpressService } from './realtime.js?v=11';

/** Static SVG markup; no text from the data source is inserted as HTML. */
export function liveIconKind(vehicle) {
  return vehicle.source==='cercanias' ? 'C' : isExpressService(vehicle.service_name) ? 'AV' : 'R';
}
export function createLiveTrainIcon(vehicle,area) {
  const kind=liveIconKind(vehicle),classes=kind==='C'?' commuter':kind==='AV'?' express':'';
  const pin=area==='national'?'national-marker-dot':'real-train-pin';
  const wrapper=area==='national'?'national-marker':'real-train-marker';
  const svg='<svg aria-hidden="true" viewBox="0 0 20 20" width="16" height="16"><rect x="4" y="2" width="12" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6.5 5.3h7v4.2h-7zM6 17l1.6-2m6.4 2-1.6-2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="12.5" r=".8" fill="currentColor"/><circle cx="13" cy="12.5" r=".8" fill="currentColor"/></svg>';
  return L.divIcon({className:wrapper,html:`<span class="${pin} live-observed-pin${classes}">${svg}<b>${kind}</b></span>`,
                    iconSize:[32,32],iconAnchor:[16,16]});
}

export const MOTION_MAX_DURATION_MS=30000;
export const MOTION_MAX_GAP_SECONDS=90;
const MOTION_MAX_SPEED_MPS=120; // 432 km/h, plus GPS-jitter allowance
const MOTION_NOISE_METERS=120;

export function liveMotionKey(vehicle) {
  return JSON.stringify([vehicle.source,vehicle.source_provider || 'renfe-gtfs',vehicle.id]);
}
function samePosition(a,b) {return a.latitude===b.latitude && a.longitude===b.longitude;}
function sameTrip(a,b) {
  if (a.trip_id && b.trip_id && a.trip_id!==b.trip_id) return false;
  if (a.origin_code && b.origin_code && a.origin_code!==b.origin_code) return false;
  if (a.destination_code && b.destination_code && a.destination_code!==b.destination_code) return false;
  return true;
}
export function motionDistanceMeters(a,b) {
  const rad=Math.PI/180, p1=a.latitude*rad,p2=b.latitude*rad;
  const dp=(b.latitude-a.latitude)*rad, dl=(b.longitude-a.longitude)*rad;
  const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 6371000*2*Math.asin(Math.min(1,Math.sqrt(h)));
}
/** Returns a segment only when both fixes and a plausible interval are known. */
export function makeMotionSegment(previous,next,start,monotonicNow) {
  if (!previous || !next || previous.time_basis!=='vehicle' || next.time_basis!=='vehicle' || !sameTrip(previous,next)) return null;
  const seconds=next.observed_at-previous.observed_at;
  if (!Number.isFinite(seconds) || seconds<=0 || seconds>MOTION_MAX_GAP_SECONDS || samePosition(previous,next)) return null;
  if (!Number.isFinite(start?.latitude) || !Number.isFinite(start?.longitude) || !Number.isFinite(monotonicNow)) return null;
  const distance=motionDistanceMeters(previous,next), visibleDistance=motionDistanceMeters(start,next);
  const limit=MOTION_NOISE_METERS+MOTION_MAX_SPEED_MPS*seconds;
  if (!Number.isFinite(distance) || !Number.isFinite(visibleDistance) || distance>limit || visibleDistance>limit) return null;
  return {from:{latitude:start.latitude,longitude:start.longitude},to:{latitude:next.latitude,longitude:next.longitude},
          startedAt:monotonicNow,duration:Math.max(1000,Math.min(MOTION_MAX_DURATION_MS,seconds*1000))};
}
/** Linear geographic estimate, clamped to already received endpoints. */
export function sampleMotion(segment,monotonicNow) {
  const fraction=Math.min(1,Math.max(0,(monotonicNow-segment.startedAt)/segment.duration));
  return {latitude:segment.from.latitude+(segment.to.latitude-segment.from.latitude)*fraction,
          longitude:segment.from.longitude+(segment.to.longitude-segment.from.longitude)*fraction,
          fraction,estimated:fraction<1};
}

/** Stable Leaflet markers; no new/fake trains and no extrapolation past a fix. */
export function createLiveMotionLayer({layer,createMarker,updateMarker,isVisible,isEnabled}) {
  const entries=new Map();let request=null;
  const enabled=()=>Boolean(isEnabled());
  const visible=()=>!document.hidden && Boolean(isVisible());
  function setState(entry,estimated) {
    const element=entry.marker.getElement?.();
    if (element) {
      element.classList.toggle('is-interpolating',estimated);
      element.dataset.motion=estimated ? 'interpolada' : 'observada';
    }
  }
  function put(entry,point,estimated=false) {
    entry.marker.setLatLng([point.latitude,point.longitude]);setState(entry,estimated);
  }
  function tick(now) {
    request=null;
    if (!visible() || !enabled()) return;
    let active=false;
    for (const entry of entries.values()) {
      if (!entry.segment || entry.conflicted) continue;
      const p=sampleMotion(entry.segment,now);put(entry,p,p.estimated);
      if (p.fraction>=1)entry.segment=null;else active=true;
    }
    if(active)request=requestAnimationFrame(tick);
  }
  function resume() {
    if (request===null && visible() && enabled() && [...entries.values()].some(e=>e.segment&&!e.conflicted)) request=requestAnimationFrame(tick);
  }
  function clear() {
    if(request!==null){cancelAnimationFrame(request);request=null;}
    layer.clearLayers();entries.clear();
  }
  function setEnabled(value) {
    if (!value) {
      if(request!==null){cancelAnimationFrame(request);request=null;}
      for(const entry of entries.values()) {entry.segment=null;if(!entry.conflicted)put(entry,entry.last,false);}
    } else resume();
  }
  function update(vehicles) {
    const now=performance.now(),seen=new Set();let suppressed=0;
    for (const vehicle of vehicles) {
      const key=liveMotionKey(vehicle);
      if (seen.has(key)) continue;
      seen.add(key);let entry=entries.get(key);
      if (!entry) {
        const marker=createMarker(vehicle);entry={marker,last:vehicle,segment:null,conflicted:false};entries.set(key,entry);
        marker.addTo(layer);setState(entry,false);continue;
      }
      const prior=entry.last;
      const previousTime=Number(prior.observed_at),nextTime=Number(vehicle.observed_at);
      if (nextTime<previousTime || (nextTime===previousTime && !samePosition(prior,vehicle))) {
        // Conflicting or backwards observations do not define a safe path.
        entry.conflicted=true;entry.segment=null;if(layer.hasLayer(entry.marker))layer.removeLayer(entry.marker);
        suppressed++;continue;
      }
      if (entry.conflicted && nextTime<=previousTime) {suppressed++;continue;}
      if (nextTime>previousTime) {
        const p=entry.segment ? sampleMotion(entry.segment,now) : entry.marker.getLatLng();
        const start={latitude:p.latitude ?? p.lat,longitude:p.longitude ?? p.lng};
        const segment=enabled() && !entry.conflicted ? makeMotionSegment(prior,vehicle,start,now) : null;
        entry.last=vehicle;entry.conflicted=false;entry.segment=segment;
        if (!layer.hasLayer(entry.marker))entry.marker.addTo(layer);
        if(segment)put(entry,start,true);else put(entry,vehicle,false);
      } else if (!entry.conflicted) {
        // Same fix; retain the segment (and do not restart the animation).
        entry.last=vehicle;
      }
      if(!entry.conflicted && updateMarker)updateMarker(entry.marker,vehicle);
    }
    for (const [key,entry] of entries) if(!seen.has(key)) {if(layer.hasLayer(entry.marker))layer.removeLayer(entry.marker);entries.delete(key);}
    resume();return {suppressed};
  }
  return {update,clear,resume,setEnabled};
}
