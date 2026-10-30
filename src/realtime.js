/**
 * Evaluate the server's Renfe observations without inventing positions. A
 * snapshot keeps aging in the browser even if refreshes stop or a tab sleeps.
 * Vehicle timestamps take precedence; the feed timestamp is a documented
 * fallback when the source omits individual measurement times.
 */
export const LIVE_POLL_MS = 30000;
export const LIVE_FUTURE_TOLERANCE_SECONDS = 30;
const LIVE_EXPRESS_NAMES = new Set(['AVE','AVE INT','AVLO','AVANT','AVANT EXP','ALTA VELOCIDAD']);
/** Recognized labels, not an inference of rolling-stock model or actual speed. */
export function isExpressService(value) {
  return typeof value==='string' && LIVE_EXPRESS_NAMES.has(value.trim().toUpperCase());
}

export function recentTimestamp(value, now, maxAge) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 &&
    typeof now === 'number' && Number.isFinite(now) &&
    now - value <= maxAge && now - value >= -LIVE_FUTURE_TOLERANCE_SECONDS;
}

export function evaluateLiveFeed(feed, now, maxAge = 90) {
  if (!feed || !['fresh', 'partial'].includes(feed.status)) {
    return { ...(feed || {}), status: feed?.status === 'stale' ? 'stale' : 'error', count: null, vehicles: [] };
  }
  if (!recentTimestamp(feed.header_timestamp, now, maxAge)) {
    return { ...feed, status: 'stale', count: null, vehicles: [] };
  }
  if (!Array.isArray(feed.vehicles)) {
    return { ...feed, status: 'error', count: null, vehicles: [] };
  }
  const valid = feed.vehicles.filter(vehicle =>
    vehicle && Number.isFinite(vehicle.latitude) && vehicle.latitude >= -90 && vehicle.latitude <= 90 &&
    Number.isFinite(vehicle.longitude) && vehicle.longitude >= -180 && vehicle.longitude <= 180 &&
    recentTimestamp(vehicle.observed_at, now, maxAge));
  const excluded = Math.max(0, Number(feed.excluded_stale) || 0) + feed.vehicles.length - valid.length;
  const ambiguous = Math.max(0, Number(feed.excluded_ambiguous) || 0);
  return { ...feed, status: excluded || ambiguous || feed.status === 'partial' ? 'partial' : 'fresh', count: valid.length, vehicles: valid,
    excluded_stale: excluded, excluded_ambiguous: ambiguous,
    feed_time_fallback: valid.filter(vehicle => vehicle.time_basis === 'feed').length };
}

/** Numeric total is explicitly the sum of positions in usable Renfe feeds,
 * never all trains in the city. Return null, not zero, when none is usable. */
export function summarizeLive(payload, now = payload?.generated_at) {
  const age = Number.isFinite(payload?.fresh_seconds) ? payload.fresh_seconds : 90;
  const cercanias = evaluateLiveFeed(payload?.feeds?.cercanias, now, age);
  const larga = evaluateLiveFeed(payload?.feeds?.larga_distancia, now, age);
  const valid = [cercanias, larga].filter(feed => ['fresh', 'partial'].includes(feed.status));
  return {
    cercanias, larga,
    usable: valid.length,
    total: valid.length ? valid.reduce((sum, feed) => sum + feed.count, 0) : null,
    vehicles: [
      ...cercanias.vehicles.map(vehicle => ({ ...vehicle, source: 'cercanias' })),
      ...larga.vehicles.map(vehicle => ({ ...vehicle, source: 'larga_distancia' })),
    ],
  };
}
