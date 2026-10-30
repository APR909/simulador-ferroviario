#!/usr/bin/env python3
"""Static development server plus fixed-origin, cached Renfe and Adif proxies.

Run: python3 servidor.py --host 0.0.0.0 --port 8000
Only standard-library modules are needed. This is an educational development
server, not a production or railway control system.
"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import Request, urlopen
from limitaciones import LimitationsCache
from cancelaciones import CancellationCache
from radar import RadarCache
import argparse
import csv
import io
import json
import logging
import math
import threading
import time
import zipfile

ROOT = Path(__file__).resolve().parent
# Same documented rectangle as data/sevilla-osm.json (west, south, east, north).
BBOX = {'west': -6.28, 'south': 37.14, 'east': -5.68, 'north': 37.60}
# Approximate rectangles, NOT the Spanish national border. The first also
# includes parts of Portugal, France and Morocco; the second covers Canarias.
NATIONAL_BOXES = (
    {'west': -9.8, 'south': 35.0, 'east': 4.6, 'north': 44.4},
    {'west': -18.5, 'south': 27.4, 'east': -13.0, 'north': 29.8},
)
STATIC_GTFS_URL = 'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip'
STATIC_GTFS_DATASET = 'https://data.renfe.com/dataset/horarios-de-alta-velocidad-larga-distancia-y-media-distancia'
STATIC_CACHE_SECONDS = 6 * 3600
STATIC_MAX_RESPONSE_BYTES = 5_000_000
STATIC_MAX_MEMBER_BYTES = 10_000_000
FEEDS = {
    'cercanias': {
        'label': 'Cercanías',
        'url': 'https://gtfsrt.renfe.com/vehicle_positions.json',
        'dataset': 'https://data.renfe.com/dataset/ubicacion-vehiculos',
    },
    'larga_distancia': {
        'label': 'AV / Larga y Media Distancia',
        'url': 'https://gtfsrt.renfe.com/vehicle_positions_LD.json',
        'dataset': 'https://data.renfe.com/dataset/posicion-vehiculos-av-ld-md',
    },
}
CACHE_SECONDS = 30       # Shared across clients, not once per browser.
FRESH_SECONDS = 90       # GTFS-RT best-practice threshold for vehicle positions.
FUTURE_TOLERANCE = 30    # Small clock skew; do not reinterpret source timestamps.
MAX_RESPONSE_BYTES = 8_000_000


def number(value):
    """Reject booleans, non-finite and malformed numbers."""
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return value if math.isfinite(value) else None


def timestamp(value):
    value = number(value)
    # Limit to valid Gregorian dates representable by both Python and JS.
    return int(value) if value is not None and 0 < value < 253402300800 else None


def text(value, fallback='', limit=100):
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        return fallback
    # Renderers also use textContent, never this value as executable markup.
    return str(value).strip()[:limit] or fallback


def age_is_fresh(observed_at, now):
    return observed_at is not None and -FUTURE_TOLERANCE <= now - observed_at <= FRESH_SECONDS


def in_boxes(latitude, longitude, boxes):
    return any(box['south'] <= latitude <= box['north'] and box['west'] <= longitude <= box['east'] for box in boxes)


def boxes_for_scope(scope):
    if scope == 'sevilla':
        return (BBOX,)
    if scope == 'espana':
        return NATIONAL_BOXES
    raise ValueError('Ámbito no válido')


def get_json(url):
    """Fetch only URLs selected by FEEDS, never a URL supplied by the client."""
    request = Request(url, headers={'Accept': 'application/json', 'User-Agent': 'ViaLab-Sevilla/0.2 (educational GTFS-RT viewer)'})
    with urlopen(request, timeout=8) as response:
        body = response.read(MAX_RESPONSE_BYTES + 1)
    if len(body) > MAX_RESPONSE_BYTES:
        raise ValueError('Respuesta demasiado grande')
    return json.loads(body)


def parse_feed(payload):
    """Normalize GTFS-RT JSON; do not fabricate coordinates or timestamps.

    GTFS permits omitting empty repeated fields, hence a missing 'entity' is
    equivalent to an empty list; an invalid/missing header is an error.
    Deduplicate identified vehicles over the entire feed before bbox filtering.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get('header'), dict):
        raise ValueError('Cabecera GTFS-RT no válida')
    header_time = timestamp(payload['header'].get('timestamp'))
    if header_time is None:
        raise ValueError('Cabecera GTFS-RT sin fecha válida')
    entities = payload.get('entity', [])
    if not isinstance(entities, list):
        raise ValueError('Lista de entidades GTFS-RT no válida')
    by_vehicle = {}
    for entity in entities:
        if not isinstance(entity, dict):
            continue
        vehicle = entity.get('vehicle')
        if not isinstance(vehicle, dict):
            continue
        position = vehicle.get('position')
        if not isinstance(position, dict):
            continue
        lat, lon = number(position.get('latitude')), number(position.get('longitude'))
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        descriptor = vehicle.get('vehicle') if isinstance(vehicle.get('vehicle'), dict) else {}
        vehicle_id = text(descriptor.get('id'))
        entity_id = text(entity.get('id'))
        identity = vehicle_id or entity_id
        if not identity:
            continue  # Required GTFS identifiers missing; cannot count reliably.
        supplied_time = vehicle.get('timestamp')
        # If absent GTFS recommends falling back to the feed time. A malformed
        # explicit timestamp is not silently promoted to a current position.
        observed_at = header_time if supplied_time is None else timestamp(supplied_time)
        if observed_at is None:
            continue
        speed, bearing = number(position.get('speed')), number(position.get('bearing'))
        trip = vehicle.get('trip') if isinstance(vehicle.get('trip'), dict) else {}
        candidate = {
            'id': identity,
            'label': text(descriptor.get('label'), identity),
            'trip_id': text(trip.get('tripId')),
            'latitude': lat,
            'longitude': lon,
            'observed_at': observed_at,
            'time_basis': 'feed' if supplied_time is None else 'vehicle',
            'speed_mps': speed if speed is not None and speed >= 0 else None,
            'bearing': bearing if bearing is not None and 0 <= bearing < 360 else None,
        }
        # Later measurements win even if they have moved outside a rectangle.
        # Simultaneous conflicting coordinates for one vehicle cannot be
        # resolved honestly: do not guess which one is current.
        candidate['trip_ids'] = [candidate['trip_id']] if candidate['trip_id'] else []
        candidate['_positions'] = [(lat, lon)]
        previous = by_vehicle.get(identity)
        if previous is None or candidate['observed_at'] > previous['observed_at']:
            by_vehicle[identity] = candidate
        elif candidate['observed_at'] == previous['observed_at']:
            if (lat, lon) not in previous['_positions']:
                previous['_positions'].append((lat, lon))
            if candidate['trip_id'] and candidate['trip_id'] not in previous['trip_ids']:
                previous['trip_ids'].append(candidate['trip_id'])
    ambiguous = [v for v in by_vehicle.values() if len(v['_positions']) > 1]
    valid = []
    for value in by_vehicle.values():
        if len(value['_positions']) != 1:
            continue
        candidate = {k: v for k, v in value.items() if k != '_positions'}
        valid.append(candidate)
    inside = [v for v in valid if in_boxes(v['latitude'], v['longitude'], (BBOX,))]
    return {'header_timestamp': header_time, 'vehicles_in_area': inside,
            'all_vehicles': valid, 'ambiguous_vehicles': ambiguous}


def feed_snapshot(cached, now, scope='sevilla'):
    """Filter and age the shared cache independently for each fixed scope."""
    boxes = boxes_for_scope(scope)
    result = {'label': cached['label'], 'dataset': cached['dataset'], 'fetched_at': cached['fetched_at']}
    if cached.get('error'):
        return {**result, 'status': 'error', 'count': None, 'vehicles': [], 'message': cached['error']}
    parsed = cached['parsed']
    header_time = parsed['header_timestamp']
    result['header_timestamp'] = header_time
    if not age_is_fresh(header_time, now):
        return {**result, 'status': 'stale', 'count': None, 'vehicles': [],
                'message': 'La marca temporal del feed está atrasada o es futura.'}
    in_area = [v for v in parsed['all_vehicles'] if in_boxes(v['latitude'], v['longitude'], boxes)]
    recent = [dict(v) for v in in_area if age_is_fresh(v['observed_at'], now)]
    stale_count = len(in_area) - len(recent)
    ambiguous_count = sum(1 for v in parsed['ambiguous_vehicles']
                          if any(in_boxes(lat, lon, boxes) for lat, lon in v['_positions']))
    return {**result, 'status': 'partial' if stale_count or ambiguous_count else 'fresh', 'count': len(recent),
            'vehicles': recent, 'excluded_stale': stale_count, 'excluded_ambiguous': ambiguous_count,
            'feed_time_fallback': sum(1 for v in recent if v['time_basis'] == 'feed')}


class RenfeCache:
    def __init__(self, fetcher=get_json, monotonic=time.monotonic, clock=time.time):
        self.fetcher = fetcher
        self.monotonic = monotonic
        self.clock = clock
        self.last_attempt = None
        self.cached = {}
        self.lock = threading.Lock()

    def _fetch_one(self, feed):
        try:
            data = self.fetcher(feed['url'])
            return {'parsed': parse_feed(data), 'fetched_at': int(self.clock())}
        except Exception as exc:
            # Isolate even unexpected network/decoder errors to this source;
            # never turn an error into 0 or promote stale cache as live.
            logging.warning('Fuente Renfe %s no disponible: %s', feed['label'], exc)
            return {'error': 'No se pudo consultar o interpretar la fuente.', 'fetched_at': int(self.clock())}

    def get(self, scope='sevilla'):
        # Fixed scopes share one cache; clients cannot request arbitrary URLs.
        boxes = boxes_for_scope(scope)
        # The lock also coalesces simultaneous browser requests. External calls
        # happen concurrently; no client can trigger more than one refresh/30s.
        with self.lock:
            if self.last_attempt is None or self.monotonic() - self.last_attempt >= CACHE_SECONDS:
                self.last_attempt = self.monotonic()
                with ThreadPoolExecutor(max_workers=len(FEEDS)) as pool:
                    futures = {key: pool.submit(self._fetch_one, feed) for key, feed in FEEDS.items()}
                    self.cached = {key: {**FEEDS[key], **future.result()} for key, future in futures.items()}
            now = int(self.clock())
            feeds = {key: feed_snapshot(cached, now, scope) for key, cached in self.cached.items()}
            return {
                'generated_at': now,
                'scope': scope,
                'bbox': deepcopy(BBOX) if scope == 'sevilla' else None,
                'boxes': deepcopy(boxes),
                'cache_seconds': CACHE_SECONDS,
                'fresh_seconds': FRESH_SECONDS,
                'feeds': feeds,
                'coverage': ('Solo posiciones Renfe. Sin otros operadores ni metro/tranvía; '
                             'los rectángulos nacionales incluyen zonas fuera de España.'),
            }


def get_static_gtfs():
    """Only the fixed official URL is fetched, with a strict compressed limit."""
    request = Request(STATIC_GTFS_URL, headers={'User-Agent': 'ViaLab-Espana/0.5 (educational GTFS viewer)'})
    with urlopen(request, timeout=8) as response:
        body = response.read(STATIC_MAX_RESPONSE_BYTES + 1)
    if len(body) > STATIC_MAX_RESPONSE_BYTES:
        raise ValueError('GTFS estático demasiado grande')
    return body


def parse_service_types(body):
    """Exact GTFS trip_id -> route_short_name join; no inference from speed."""
    routes = {}
    trips = {}
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        def records(name):
            info = archive.getinfo(name)
            if info.file_size > STATIC_MAX_MEMBER_BYTES:
                raise ValueError('Archivo GTFS demasiado grande')
            with archive.open(info) as raw:
                with io.TextIOWrapper(raw, encoding='utf-8-sig', newline='') as stream:
                    yield from csv.DictReader(stream)
        for row in records('routes.txt'):
            route_id, name = text(row.get('route_id')), text(row.get('route_short_name'))
            if route_id and name:
                routes[route_id] = name
        for row in records('trips.txt'):
            trip_id, route_id = text(row.get('trip_id')), text(row.get('route_id'))
            if trip_id and route_id in routes:
                name = routes[route_id]
                if trip_id not in trips:
                    trips[trip_id] = name
                elif trips[trip_id] != name:
                    trips[trip_id] = None  # Conflicting labels: do not choose one.
    if not routes or not trips:
        raise ValueError('GTFS estático sin tipos de servicio')
    return trips


class StaticServiceCache:
    def __init__(self, fetcher=get_static_gtfs, monotonic=time.monotonic, clock=time.time):
        self.fetcher, self.monotonic, self.clock = fetcher, monotonic, clock
        self.last_attempt = None
        self.result = {'status': 'unavailable', 'lookup': {}, 'fetched_at': None}
        self.lock = threading.Lock()

    def get(self):
        with self.lock:
            if self.last_attempt is None or self.monotonic() - self.last_attempt >= STATIC_CACHE_SECONDS:
                self.last_attempt = self.monotonic()
                try:
                    body = self.fetcher()
                    self.result = {'status': 'available', 'lookup': parse_service_types(body), 'body': body,
                                   'fetched_at': int(self.clock())}
                except Exception as exc:
                    logging.warning('Catálogo GTFS Renfe no disponible: %s', exc)
                    self.result = {'status': 'unavailable', 'lookup': {}, 'fetched_at': int(self.clock())}
            return self.result


def annotate_service_types(snapshot, catalog):
    """Label a position only when every equal-time trip ID agrees exactly."""
    lookup = catalog.get('lookup', {})
    vehicles = snapshot['feeds']['larga_distancia']['vehicles']
    matched = 0
    for vehicle in vehicles:
        ids = vehicle.get('trip_ids') or ([vehicle['trip_id']] if vehicle.get('trip_id') else [])
        names = {lookup.get(trip_id) for trip_id in ids}
        service = next(iter(names)) if ids and None not in names and len(names) == 1 else None
        vehicle['service_name'] = service
        matched += bool(service)
    snapshot['service_catalog'] = {'status': catalog.get('status', 'unavailable'),
                                   'fetched_at': catalog.get('fetched_at'), 'matched': matched,
                                   'dataset': STATIC_GTFS_DATASET}
    return snapshot


CACHE = RenfeCache()
STATIC_CACHE = StaticServiceCache()
LIMITATIONS_CACHE = LimitationsCache()
CANCELLATIONS_CACHE = CancellationCache(fetcher=get_json, catalog_provider=STATIC_CACHE.get)
RADAR_CACHE = RadarCache()


def needs_radar(feed):
    """A partial direct snapshot with no usable observations is not a clean zero."""
    return feed.get('status') not in ('fresh', 'partial') or (feed.get('status') == 'partial' and feed.get('count') == 0)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed_url = urlsplit(self.path)
        if parsed_url.path == '/api/cancelaciones-av':
            try:
                snapshot = CANCELLATIONS_CACHE.get()
                body = json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif parsed_url.path == '/api/limitaciones':
            try:
                # Fixed public ADIF sources only; query parameters cannot alter URLs.
                snapshot = LIMITATIONS_CACHE.get()
                body = json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif parsed_url.path == '/api/trenes':
            try:
                scope = parse_qs(parsed_url.query).get('ambito', ['sevilla'])[-1]
                if scope not in ('sevilla', 'espana'):
                    self.send_error(400, 'Ámbito no válido')
                    return
                snapshot = CACHE.get(scope)
                long_distance = snapshot['feeds']['larga_distancia']
                # Use the independent mediator only if the direct source fails,
                # expires, or contains only excluded/ambiguous positions.
                # Never merge both lists, which would double-count trains.
                if needs_radar(long_distance):
                    alternate = RADAR_CACHE.get(boxes_for_scope(scope))
                    # Requests may take seconds: re-age BOTH sources afterward.
                    snapshot = CACHE.get(scope)
                    long_distance = snapshot['feeds']['larga_distancia']
                    alternate = RADAR_CACHE.get(boxes_for_scope(scope))
                    if needs_radar(long_distance) and alternate['status'] in ('fresh', 'partial'):
                        alternate['direct_status'] = long_distance['status']
                        alternate['direct_header_timestamp'] = long_distance.get('header_timestamp')
                        snapshot['feeds']['larga_distancia'] = alternate
                        long_distance = alternate
                    elif needs_radar(long_distance):
                        long_distance['alternate_status'] = alternate['status']
                if long_distance.get('source_provider') == 'radar':
                    snapshot['service_catalog'] = {'status': 'radar_product',
                        'matched': sum(bool(v.get('service_name')) for v in long_distance['vehicles']),
                        'fetched_at': long_distance['fetched_at'], 'dataset': 'https://radardetrenes.com/docs'}
                elif long_distance['status'] in ('fresh', 'partial') and long_distance['vehicles']:
                    # Classify observed services consistently in Sevilla and Spain.
                    catalog = STATIC_CACHE.get()
                    # Downloading a GTFS catalog can take seconds. Re-age both
                    # feeds after that wait, before presenting any positions.
                    snapshot = CACHE.get(scope)
                    annotate_service_types(snapshot, catalog)
                else:
                    snapshot['service_catalog'] = {'status': 'not_needed', 'matched': 0,
                                                   'fetched_at': None, 'dataset': STATIC_GTFS_DATASET}
                body = json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('X-Content-Type-Options', 'nosniff')
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass
        else:
            super().do_GET()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', default='0.0.0.0')
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    with ThreadingHTTPServer((args.host, args.port), Handler) as server:
        print(f'Vía Lab: http://{args.host}:{args.port} (Ctrl+C para detener)', flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print('\nServidor detenido.')


if __name__ == '__main__':
    main()
