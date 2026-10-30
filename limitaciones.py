#!/usr/bin/env python3
"""Consulta limitada y cacheada de las LTV públicas de ADIF.

Las LTV no son avisos de averías ni garantizan el estado actual. El punto es
la geometría publicada por ADIF, no una señal física o el principio de un
tramo. No se usan estas observaciones para controlar la simulación.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import copy
import json
import logging
import math
import re
import threading
import time

LTV_BASE = 'https://services7.arcgis.com/XTupIrLX53AjaJqO/arcgis/rest/services/LTV_2/FeatureServer'
TRACK_BASE = ('https://services7.arcgis.com/XTupIrLX53AjaJqO/arcgis/rest/services/'
              'Tramos_en_servicio_Adif_p%C3%BAblico/FeatureServer')
SOURCES = {
    'mapped': {'url': f'{LTV_BASE}/0', 'id_field': 'OBJECTID', 'where': '1=1', 'geometry': True,
               'fields': ('OBJECTID', 'LTVID', 'CODLINEA', 'DESCLINEA', 'PKINI', 'PKFIN',
                          'RESTRICCIONVELOCIDAD', 'VIAS', 'DESCPSINI', 'DESCPSFIN')},
    'unlocated': {'url': f'{LTV_BASE}/1', 'id_field': 'OBJECTID', 'where': '1=1', 'geometry': False,
                  'fields': ('OBJECTID', 'LTVID', 'CODLINEA', 'DESCLINEA', 'PKINI', 'PKFIN',
                             'RESTRICCIONVELOCIDAD', 'VIAS', 'DESCPSINI', 'DESCPSFIN', 'OBSERVACIONES')},
    'load': {'url': f'{LTV_BASE}/2', 'id_field': 'OBJECTID', 'where': '1=1', 'geometry': False,
             'fields': ('OBJECTID', 'FICHERO_LTV_VIGOR', 'FECHA_LTV_VIGOR', 'HORA_LTV_VIGOR',
                        'FECHA_LTV_CARGA', 'HORA_LTV_CARGA')},
    'tracks': {'url': f'{TRACK_BASE}/0', 'id_field': 'FID', 'where': "COD_TIPO_R='A'", 'geometry': False,
               'fields': ('FID', 'COD_LINEA', 'COD_TIPO_R', 'PKI', 'PKD')},
}
SOURCE_PAGE = 'https://www.arcgis.com/home/item.html?id=5e62ef71f0614bb3b007df238607e8bf'
TRACK_PAGE = 'https://www.arcgis.com/home/item.html?id=4ec7c0fb3cab42b0b488d65e65eeb7aa'
VIEWER_PAGE = 'https://ltv-adif.hub.arcgis.com/'
ATTRIBUTION = '© Administrador de infraestructuras ferroviarias'
CACHE_SECONDS = 300
# This is deliberately conservative, and *not* a claim that LTV are real-time.
STALE_SECONDS = 6 * 3600
FUTURE_TOLERANCE = 60
MAX_BYTES = 8_000_000
MAX_RECORDS = 20_000
# GET URLs stay below common proxy length limits even with long object IDs.
BATCH_SIZE = 150


def finite(value):
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def clean(value, limit=200):
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        return ''
    return str(value).strip()[:limit]


def integer(value):
    n = finite(value)
    if n is None or not n.is_integer() or not 0 <= n < 2**53:
        return None
    return int(n)


def data_timestamp(value):
    """ArcGIS edit dates are epoch milliseconds, not query timestamps."""
    n = finite(value)
    if n is None or not 946684800000 <= n < 253402300800000:
        return None
    return n / 1000


def fetch_json(url):
    """Only internally constructed, fixed ADIF ArcGIS URLs are passed here."""
    request = Request(url, headers={'Accept': 'application/json',
                                   'User-Agent': 'ViaLab/0.7 (educational ADIF LTV viewer)'})
    with urlopen(request, timeout=8) as response:
        body = response.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise ValueError('Respuesta ArcGIS demasiado grande')
    result = json.loads(body)
    if not isinstance(result, dict) or 'error' in result:
        raise ValueError('ArcGIS devolvió un error o formato no válido')
    return result


def arcgis_url(base, suffix='', **params):
    return f'{base}{suffix}?{urlencode(params)}'


def metadata(fetcher, source):
    result = fetcher(arcgis_url(source['url'], f='json'))
    if not isinstance(result, dict) or 'error' in result:
        raise ValueError('Metadatos ArcGIS no disponibles')
    fields = result.get('fields')
    if not isinstance(fields, list):
        raise ValueError('ArcGIS no ofrece el esquema esperado')
    names = {item.get('name') for item in fields if isinstance(item, dict)}
    if not set(source['fields']).issubset(names):
        raise ValueError('El esquema ArcGIS ha cambiado')
    if source['geometry'] and result.get('geometryType') != 'esriGeometryPoint':
        raise ValueError('La capa LTV ya no contiene puntos')
    edits = result.get('editingInfo') if isinstance(result.get('editingInfo'), dict) else {}
    return {'data_edited_at': data_timestamp(edits.get('dataLastEditDate')),
            'schema_edited_at': data_timestamp(edits.get('schemaLastEditDate'))}


def query_all(fetcher, source):
    """IDs primero, luego lotes: detectar truncamientos y cambios de esquema."""
    base, where = source['url'], source['where']
    id_data = fetcher(arcgis_url(base, '/query', f='json', where=where, returnIdsOnly='true'))
    if not isinstance(id_data, dict) or 'error' in id_data:
        raise ValueError('No se pudo consultar los IDs ArcGIS')
    raw_ids = id_data.get('objectIds')
    if id_data.get('objectIdFieldName') != source['id_field'] or not isinstance(raw_ids, list):
        raise ValueError('Lista de IDs ArcGIS no válida')
    ids = [integer(value) for value in raw_ids]
    if any(value is None for value in ids) or len(ids) != len(set(ids)) or len(ids) > MAX_RECORDS:
        raise ValueError('IDs ArcGIS ambiguos o demasiados registros')
    results = []
    for offset in range(0, len(ids), BATCH_SIZE):
        batch = ids[offset:offset + BATCH_SIZE]
        args = {'f': 'json', 'where': where, 'objectIds': ','.join(map(str, batch)),
                'outFields': ','.join(source['fields']),
                'returnGeometry': 'true' if source['geometry'] else 'false'}
        if source['geometry']:
            args['outSR'] = '4326'
        result = fetcher(arcgis_url(base, '/query', **args))
        if not isinstance(result, dict) or 'error' in result or result.get('exceededTransferLimit'):
            raise ValueError('Respuesta ArcGIS truncada o inválida')
        features = result.get('features')
        if not isinstance(features, list):
            raise ValueError('ArcGIS no devolvió una lista de registros')
        if source['geometry'] and features:
            ref = result.get('spatialReference')
            if not isinstance(ref, dict) or 4326 not in (ref.get('wkid'), ref.get('latestWkid')):
                raise ValueError('Las coordenadas LTV no están en WGS84')
        seen = []
        for feature in features:
            attrs = feature.get('attributes') if isinstance(feature, dict) else None
            if not isinstance(attrs, dict) or not set(source['fields']).issubset(attrs):
                raise ValueError('Registro ArcGIS sin atributos esperados')
            seen.append(integer(attrs.get(source['id_field'])))
        if None in seen or len(seen) != len(set(seen)) or set(seen) != set(batch):
            raise ValueError('Registro ArcGIS omitido, duplicado o cambiado durante la consulta')
        results.extend(features)
    return results


def catalog_ranges(features):
    """Adif class A = uso principal de alta velocidad; PK are approximate."""
    ranges = {}
    for feature in features:
        attrs = feature['attributes']
        if attrs.get('COD_TIPO_R') != 'A':
            raise ValueError('El catálogo devolvió un tramo no clasificado A')
        match = re.match(r'^(\d{3})\s*-', clean(attrs.get('COD_LINEA')))
        start, end = finite(attrs.get('PKI')), finite(attrs.get('PKD'))
        if match and start is not None and end is not None:
            ranges.setdefault(match.group(1), []).append((min(start, end), max(start, end)))
    if not ranges:
        raise ValueError('Catálogo AV sin tramos clasificables')
    return ranges


def on_high_speed_line(attrs, ranges):
    """Intersection by exact ADIF code and PK; not an OSM proximity guess.

    A nonzero interval merely touching another at its endpoint does not count.
    The catalog is quarterly and its PK endpoints are approximate.
    """
    code = clean(attrs.get('CODLINEA'))
    if code not in ranges:
        return 'other'
    start, end = finite(attrs.get('PKINI')), finite(attrs.get('PKFIN'))
    if start is None or end is None:
        return 'unknown'
    lo, hi = sorted((start, end))
    for a, b in ranges[code]:
        if lo == hi and a - 1e-4 <= lo <= b + 1e-4:
            return 'av'
        if min(hi, b) - max(lo, a) > 1e-4:
            return 'av'
    return 'other'


def local_source_time(date_value, time_value):
    """ArcGIS date is calendar midnight UTC; time string carries its offset.

    Without an explicit offset, do not invent a timezone. FICHERO is not a
    heartbeat; it is the effective date of the dataset loaded by ADIF.
    """
    milliseconds = finite(date_value)
    clock = clean(time_value, 80)
    if milliseconds is None or not re.fullmatch(r'\d\d:\d\d:\d\d(?:\.\d+)?[+-]\d\d:\d\d', clock):
        return None
    try:
        day = datetime.fromtimestamp(milliseconds / 1000, timezone.utc).date().isoformat()
        return datetime.fromisoformat(f'{day}T{clock}').timestamp()
    except (ValueError, OverflowError, OSError):
        return None


def load_metadata(features, now):
    """Most recent non-future effective file entry; keep effective and load apart."""
    candidates = []
    for feature in features:
        a = feature['attributes']
        effective = local_source_time(a.get('FECHA_LTV_VIGOR'), a.get('HORA_LTV_VIGOR'))
        loaded = local_source_time(a.get('FECHA_LTV_CARGA'), a.get('HORA_LTV_CARGA'))
        if effective is not None and effective <= now + FUTURE_TOLERANCE:
            candidates.append({'file_effective_at': effective, 'file_loaded_at': loaded,
                               'file_name': clean(a.get('FICHERO_LTV_VIGOR'), 80)})
    return max(candidates, key=lambda x: x['file_effective_at']) if candidates else {
        'file_effective_at': None, 'file_loaded_at': None, 'file_name': ''}


def valid_point(geometry):
    if not isinstance(geometry, dict):
        return None
    lon, lat = finite(geometry.get('x')), finite(geometry.get('y'))
    # Rectangles are approximate and include some neighbouring territories.
    if lat is None or lon is None:
        return None
    inside = (35 <= lat <= 44.4 and -9.8 <= lon <= 4.6) or (27.4 <= lat <= 29.8 and -18.5 <= lon <= -13)
    return {'latitude': lat, 'longitude': lon} if inside else None


def normalize_record(feature, table):
    a = feature['attributes']
    speed = finite(a.get('RESTRICCIONVELOCIDAD'))
    if speed is None or not 0 <= speed <= 500:
        speed = None
    pk_start, pk_end = finite(a.get('PKINI')), finite(a.get('PKFIN'))
    object_id = integer(a.get('OBJECTID'))
    return {'id': f'{table}-{object_id}', 'ltv_id': integer(a.get('LTVID')),
            'line_code': clean(a.get('CODLINEA'), 10), 'line_name': clean(a.get('DESCLINEA'), 150),
            'pk_start': pk_start, 'pk_end': pk_end, 'speed_kmh': speed,
            'tracks': clean(a.get('VIAS'), 80), 'from': clean(a.get('DESCPSINI'), 100),
            'to': clean(a.get('DESCPSFIN'), 100),
            # Do not use X/Y from the table explicitly named LTV_NO_LOC.
            'location': valid_point(feature.get('geometry')) if table == 'mapped' else None}


def classify_records(mapped, unlocated, ranges):
    points, without_position, unknown = [], [], 0
    for table, features in [('mapped', mapped), ('unlocated', unlocated)]:
        for feature in features:
            cls = on_high_speed_line(feature['attributes'], ranges)
            if cls == 'unknown':
                unknown += 1
            if cls != 'av':
                continue
            record = normalize_record(feature, table)
            if record['location']:
                points.append(record)
            else:
                without_position.append(record)
    sort_key = lambda x: (x['line_code'], x['pk_start'] if x['pk_start'] is not None else float('inf'), x['id'])
    return sorted(points, key=sort_key), sorted(without_position, key=sort_key), unknown


def snapshot_status(snapshot, now):
    if snapshot.get('error'):
        return 'error'
    edited, effective = snapshot.get('source_edited_at'), snapshot.get('file_effective_at')
    if edited is None or effective is None or edited > now + FUTURE_TOLERANCE or effective > now + FUTURE_TOLERANCE:
        return 'unknown'
    return 'stale' if now - min(edited, effective) > STALE_SECONDS else 'recent'


class LimitationsCache:
    def __init__(self, fetcher=fetch_json, monotonic=time.monotonic, clock=time.time):
        self.fetcher, self.monotonic, self.clock = fetcher, monotonic, clock
        self.last_attempt, self.cached = None, None
        self.lock = threading.Lock()

    def _collect(self):
        with ThreadPoolExecutor(max_workers=len(SOURCES)) as pool:
            before_futures = {name: pool.submit(metadata, self.fetcher, source) for name, source in SOURCES.items()}
            before = {name: future.result() for name, future in before_futures.items()}
            query_futures = {name: pool.submit(query_all, self.fetcher, source) for name, source in SOURCES.items()}
            data = {name: future.result() for name, future in query_futures.items()}
            after_futures = {name: pool.submit(metadata, self.fetcher, source) for name, source in SOURCES.items()}
            after = {name: future.result() for name, future in after_futures.items()}
        if before != after:
            raise ValueError('Las capas ADIF cambiaron durante la consulta')
        now = self.clock()
        ranges = catalog_ranges(data['tracks'])
        points, unlocated, unknown = classify_records(data['mapped'], data['unlocated'], ranges)
        edits = [before[name]['data_edited_at'] for name in ('mapped', 'unlocated', 'load')]
        # Do not treat incomplete metadata as a fresh update.
        edited = min(edits) if all(value is not None for value in edits) else None
        return {'source_edited_at': edited, 'catalog_edited_at': before['tracks']['data_edited_at'],
                **load_metadata(data['load'], now), 'records': points, 'unlocated': unlocated,
                'unknown_classification': unknown, 'fetched_at': int(now)}

    def get(self):
        # One lock coalesces concurrent requests from all browser clients.
        with self.lock:
            if self.last_attempt is None or self.monotonic() - self.last_attempt >= CACHE_SECONDS:
                self.last_attempt = self.monotonic()
                try:
                    self.cached = self._collect()
                except Exception as exc:
                    logging.warning('Fuente de LTV ADIF no disponible: %s', exc)
                    self.cached = {'error': 'No se pudo consultar o validar la fuente ADIF.',
                                   'fetched_at': int(self.clock())}
            result = copy.deepcopy(self.cached)
            now = self.clock()
            result.update({'kind': 'adif-ltv', 'generated_at': int(now), 'cache_seconds': CACHE_SECONDS,
                           'stale_seconds': STALE_SECONDS, 'source_url': SOURCE_PAGE,
                           'catalog_url': TRACK_PAGE, 'viewer_url': VIEWER_PAGE,
                           'attribution': ATTRIBUTION})
            result['status'] = snapshot_status(result, now)
            if result['status'] == 'error':
                result.update({'records': [], 'unlocated': [], 'count': None})
            else:
                result['count'] = len(result['records'])
            return result
