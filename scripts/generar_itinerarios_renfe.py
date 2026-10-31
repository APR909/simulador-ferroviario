#!/usr/bin/env python3
"""Genera una instantánea compacta de los horarios GTFS públicos de Renfe.

NO registra posiciones, ni determina si una circulación ocurrió realmente.
Las fechas activas se resuelven con calendar y calendar_dates, y los tiempos
GTFS mayores de 24 h se conservan. Ejecutar con los ZIP descargados o, si no se
especifican, descargar las fuentes oficiales (CC BY 4.0). El fichero generado
es estático: hay que regenerarlo y volver a publicar antes de que caduque.
"""
from __future__ import annotations

import argparse
import copy
import csv
from datetime import date, datetime, timedelta, timezone
import io
import json
import re
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from zoneinfo import ZoneInfo

SOURCES = {
    'av': {
        'label': 'Alta velocidad, larga y media distancia',
        'url': 'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip',
        'dataset': 'https://data.renfe.com/dataset/horarios-de-alta-velocidad-larga-distancia-y-media-distancia',
    },
    'cer': {
        'label': 'Cercanías y Rodalies',
        'url': 'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
        'dataset': 'https://data.renfe.com/dataset/horarios-cercanias',
    },
}
LICENSE = 'https://creativecommons.org/licenses/by/4.0/'
WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']


def csv_rows(archive, name):
    """Renfe pads the final GTFS column name/value with spaces."""
    try:
        raw = archive.open(name)
    except KeyError:
        return
    with raw, io.TextIOWrapper(raw, encoding='utf-8-sig', newline='') as text:
        reader = csv.reader(text)
        try:
            headers = [value.strip() for value in next(reader)]
        except StopIteration:
            return
        for values in reader:
            if len(values) != len(headers):
                continue
            yield dict(zip(headers, (value.strip() for value in values)))


def parse_gtfs_date(value):
    try:
        return datetime.strptime(value, '%Y%m%d').date()
    except (ValueError, TypeError):
        return None


def parse_gtfs_time(value):
    if not re.fullmatch(r'\d{1,3}:\d{2}:\d{2}', value or ''):
        return None
    hour, minute, second = map(int, value.split(':'))
    if hour > 71 or minute > 59 or second > 59:
        return None
    return hour * 3600 + minute * 60 + second


def download(url, destination):
    request = urllib.request.Request(url, headers={'User-Agent': 'ViaLab-Horarios/1.0 (Renfe GTFS; CC BY 4.0)'})
    with urllib.request.urlopen(request, timeout=60) as response, open(destination, 'wb') as output:
        if response.status != 200:
            raise ValueError(f'No se pudo descargar {url}: HTTP {response.status}')
        total = 0
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > 40_000_000:
                raise ValueError('El ZIP supera el límite de tamaño esperado.')
            output.write(chunk)
        return response.headers.get('Last-Modified', '')


def build_calendar(archive, first_day, days):
    masks = {}
    all_dates = []
    for row in csv_rows(archive, 'calendar.txt'):
        service = row.get('service_id', '')
        start, end = parse_gtfs_date(row.get('start_date')), parse_gtfs_date(row.get('end_date'))
        if not service or start is None or end is None or end < start:
            continue
        all_dates.extend((start, end))
        mask = 0
        for offset in range(days):
            day = first_day + timedelta(days=offset)
            if start <= day <= end and row.get(WEEKDAYS[day.weekday()]) == '1':
                mask |= 1 << offset
        masks[service] = masks.get(service, 0) | mask
    for row in csv_rows(archive, 'calendar_dates.txt'):
        service = row.get('service_id', '')
        day = parse_gtfs_date(row.get('date'))
        if not service or day is None:
            continue
        all_dates.append(day)
        offset = (day - first_day).days
        if not 0 <= offset < days:
            continue
        bit = 1 << offset
        if row.get('exception_type') == '1':
            masks[service] = masks.get(service, 0) | bit
        elif row.get('exception_type') == '2':
            masks[service] = masks.get(service, 0) & ~bit
    return masks, all_dates


def generate(feeds, first_day, days, generated_at=None):
    if not 1 <= days <= 93:
        raise ValueError('El número de días debe estar entre 1 y 93.')
    generated_at = generated_at or datetime.now(timezone.utc).isoformat()
    stops, combined, metadata = [], {}, []
    omitted = {'invalid_trips': 0, 'invalid_stops': 0, 'duplicate_groups': 0}
    for feed_index, feed in enumerate(('av', 'cer')):
        path, modified = feeds[feed]
        with zipfile.ZipFile(path) as archive:
            masks, dates = build_calendar(archive, first_day, days)
            if not dates or not any(masks.values()):
                raise ValueError(f'{feed}: el calendario GTFS no cubre el periodo solicitado.')
            route_names = {}
            for row in csv_rows(archive, 'routes.txt'):
                if row.get('route_id'):
                    route_names[row['route_id']] = row.get('route_short_name') or row.get('route_long_name') or ('Renfe' if feed == 'av' else 'Cercanías')
            local_stops = {}
            for row in csv_rows(archive, 'stops.txt'):
                code, name = row.get('stop_id', ''), row.get('stop_name', '')
                try:
                    lat, lon = float(row['stop_lat']), float(row['stop_lon'])
                except (KeyError, TypeError, ValueError):
                    continue
                if not code or not name or not (-90 <= lat <= 90 and -180 <= lon <= 180):
                    continue
                local_stops[code] = len(stops)
                stops.append([code, name, round(lat, 6), round(lon, 6)])
            trips = {}
            for row in csv_rows(archive, 'trips.txt'):
                trip_id, service_id = row.get('trip_id', ''), row.get('service_id', '')
                mask = masks.get(service_id, 0)
                if not trip_id or not mask:
                    continue
                route = route_names.get(row.get('route_id', ''), 'Renfe' if feed == 'av' else 'Cercanías')
                code = row.get('trip_short_name', '')
                if not code:
                    block = row.get('block_id', '')
                    # In this Renfe GTFS block_id begins with its service_id;
                    # only use the remainder when it is an actual numeric code.
                    rest = block[len(service_id):] if block.startswith(service_id) else ''
                    code = rest if re.fullmatch(r'\d{1,12}', rest) else trip_id
                trips[trip_id] = (code[:80], route[:100], mask)
            if not trips or not local_stops:
                raise ValueError(f'{feed}: faltan circulaciones o estaciones válidas.')

            seen, last_id, rows = set(), None, []
            def consume(trip_id, points):
                if trip_id is None:
                    return
                if trip_id in seen:
                    # GTFS does not require an order; fail safely rather than
                    # silently joining unrelated partial journeys.
                    raise ValueError(f'{feed}: stop_times.txt no está agrupado por trip_id ({trip_id}).')
                seen.add(trip_id)
                meta = trips.get(trip_id)
                if meta is None:
                    return
                points.sort(key=lambda item: item[0])
                if len(points) < 2 or any(points[i][0] == points[i - 1][0] for i in range(1, len(points))):
                    omitted['invalid_trips'] += 1
                    return
                packed = tuple((point[1], point[2], point[3]) for point in points)
                # A timetable which goes backwards is ambiguous; never fix it by guessing a date.
                previous = -1
                for _, arr, dep in packed:
                    if arr < previous or dep < arr:
                        omitted['invalid_trips'] += 1
                        return
                    previous = dep
                code, route, mask = meta
                key = (feed_index, code, route, packed)
                prior = combined.get(key, 0)
                if prior & mask:
                    omitted['duplicate_groups'] += 1
                combined[key] = prior | mask

            for row in csv_rows(archive, 'stop_times.txt'):
                trip_id = row.get('trip_id', '')
                if trip_id != last_id:
                    consume(last_id, rows)
                    last_id, rows = trip_id, []
                if trip_id not in trips:
                    continue
                station = local_stops.get(row.get('stop_id', ''))
                arr = parse_gtfs_time(row.get('arrival_time', ''))
                dep = parse_gtfs_time(row.get('departure_time', ''))
                try:
                    sequence = int(row.get('stop_sequence', ''))
                except ValueError:
                    sequence = -1
                if station is None or arr is None or dep is None or sequence < 0:
                    # Dropping a stop could fabricate a route; reject the entire trip.
                    rows.append((-1, -1, -1, -1))
                    omitted['invalid_stops'] += 1
                else:
                    rows.append((sequence, station, arr, dep))
            consume(last_id, rows)
            # One invalid sentinel marks the whole trip. Remove it rather than
            # emitting invalid indexes/times; this also covers single sentinels.
            bad_keys = [key for key in combined if key[0] == feed_index and any(s < 0 or a < 0 or d < 0 for s, a, d in key[3])]
            for key in bad_keys:
                del combined[key]
                omitted['invalid_trips'] += 1
            valid_offsets = [i for i in range(days) if any(mask & (1 << i) for mask in masks.values())]
            metadata.append({
                'id': feed, 'label': SOURCES[feed]['label'], 'dataset': SOURCES[feed]['dataset'],
                'file_url': SOURCES[feed]['url'], 'last_modified': modified or None,
                'calendar_start': min(dates).isoformat(), 'calendar_end': max(dates).isoformat(),
                'included_from': (first_day + timedelta(days=min(valid_offsets))).isoformat(),
                'included_until': (first_day + timedelta(days=max(valid_offsets))).isoformat(),
                'included_dates': [(first_day + timedelta(days=i)).isoformat() for i in valid_offsets],
            })
    packed_trips = []
    for (feed_index, code, route, points), mask in combined.items():
        flat = [value for point in points for value in point]
        packed_trips.append([feed_index, code, route, format(mask, 'x'), flat])
    packed_trips.sort(key=lambda row: (row[0], row[1], row[2], row[4][1]))
    return {
        'schema': 1, 'generated_at': generated_at, 'start_date': first_day.isoformat(), 'days': days,
        'timezone': 'Europe/Madrid', 'license': LICENSE, 'attribution': 'Horarios GTFS de Renfe Datos Abiertos (CC BY 4.0).',
        'sources': metadata, 'stops': stops, 'trips': packed_trips, 'omitted': omitted,
    }


def merge_previous_snapshot(current, previous, today):
    """Reuse previously published *schedules*, never GPS or actual timings.

    A new Renfe feed may drop yesterday's service day overnight. For each
    feed/day, use the new snapshot when it has any trips; only if the entire
    service day is missing, preserve the previously published one. Retain at
    most the three preceding service days, to cover GTFS times above 24:00.
    """
    if (not isinstance(previous, dict) or previous.get('schema') != 1 or previous.get('timezone') != 'Europe/Madrid'
            or not isinstance(previous.get('days'), int) or not 1 <= previous['days'] <= 93
            or not isinstance(previous.get('sources'), list) or len(previous['sources']) != 2
            or [s.get('id') for s in previous['sources'] if isinstance(s, dict)] != ['av', 'cer']
            or not isinstance(previous.get('stops'), list) or len(previous['stops']) > 100000
            or not isinstance(previous.get('trips'), list) or len(previous['trips']) > 250000):
        raise ValueError('La instantánea anterior no tiene un formato válido.')
    try:
        current_start = date.fromisoformat(current['start_date'])
        previous_start = date.fromisoformat(previous['start_date'])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError('Las fechas de la instantánea anterior no son válidas.') from exc
    current_masks = [0, 0]
    for feed, _, _, mask, _ in current['trips']:
        current_masks[feed] |= int(mask, 16)
    targets = []
    for offset in range(current['days']):
        day = current_start + timedelta(days=offset)
        if today - timedelta(days=3) <= day < today and 0 <= (day - previous_start).days < previous['days']:
            targets.append((day, offset, (day - previous_start).days))
    if not targets:
        return current
    # Station identity includes name and coordinates. Do not silently move an
    # older station onto changed coordinates in a newer feed.
    stations = current['stops']
    station_index = {tuple(row): idx for idx, row in enumerate(stations)}
    lookup, archived = {}, [set(), set()]
    grouped = {(row[0], row[1], row[2], tuple(row[4])): int(row[3], 16) for row in current['trips']}
    for row in previous['trips']:
        if (not isinstance(row, list) or len(row) != 5 or row[0] not in (0, 1)
                or not isinstance(row[1], str) or not row[1] or len(row[1]) > 80
                or not isinstance(row[2], str) or len(row[2]) > 100
                or not isinstance(row[3], str) or not re.fullmatch(r'[0-9a-fA-F]{1,24}', row[3])
                or not isinstance(row[4], list) or len(row[4]) < 6 or len(row[4]) > 900 or len(row[4]) % 3):
            continue
        feed, code, route, mask_text, flat = row
        prior_mask, target_mask = int(mask_text, 16), 0
        for day, new_offset, old_offset in targets:
            if prior_mask & (1 << old_offset) and not current_masks[feed] & (1 << new_offset):
                target_mask |= 1 << new_offset
        if not target_mask:
            continue
        converted, last, valid = [], -1, True
        for pos in range(0, len(flat), 3):
            old_index, arr, dep = flat[pos:pos + 3]
            if (not isinstance(old_index, int) or not 0 <= old_index < len(previous['stops'])
                    or not isinstance(arr, int) or not isinstance(dep, int) or arr < last or dep < arr or dep >= 72 * 3600):
                valid = False; break
            if old_index not in lookup:
                old_stop = previous['stops'][old_index]
                if (not isinstance(old_stop, list) or len(old_stop) != 4 or not isinstance(old_stop[0], str)
                        or not isinstance(old_stop[1], str) or not old_stop[1] or len(old_stop[0]) > 100 or len(old_stop[1]) > 200
                        or not isinstance(old_stop[2], (int, float)) or not -90 <= old_stop[2] <= 90
                        or not isinstance(old_stop[3], (int, float)) or not -180 <= old_stop[3] <= 180):
                    valid = False; break
                key = tuple(old_stop)
                if key not in station_index:
                    station_index[key] = len(stations); stations.append(old_stop)
                lookup[old_index] = station_index[key]
            converted.extend((lookup[old_index], arr, dep));last = dep
        if not valid:
            continue
        key = (feed, code, route, tuple(converted))
        grouped[key] = grouped.get(key, 0) | target_mask
        for day, new_offset, _ in targets:
            if target_mask & (1 << new_offset):
                archived[feed].add(day)
    current['trips'] = [[feed, code, route, format(mask, 'x'), list(flat)] for (feed, code, route, flat), mask in grouped.items()]
    current['trips'].sort(key=lambda row: (row[0], row[1], row[2], row[4][1]))
    for feed, days in enumerate(archived):
        if not days:
            continue
        previous_meta = previous['sources'][feed]
        existing = {entry.get('date'):entry.get('captured_at') for entry in previous_meta.get('archived_dates', []) if isinstance(entry, dict)}
        current['sources'][feed]['archived_dates'] = [
            {'date': day.isoformat(), 'captured_at': existing.get(day.isoformat()) or previous.get('generated_at')}
            for day in sorted(days)
        ]
        old_first = date.fromisoformat(current['sources'][feed]['included_from'])
        current['sources'][feed]['included_from'] = min(old_first, min(days)).isoformat()
        current['sources'][feed]['included_dates'] = sorted(set(current['sources'][feed].get('included_dates', [])) | {d.isoformat() for d in days})
    return current


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--av', help='ZIP GTFS AV/LD/MD local; por defecto descarga Renfe')
    parser.add_argument('--cer', help='ZIP GTFS Cercanías local; por defecto descarga Renfe')
    parser.add_argument('--av-modified', default='', help='Last-Modified HTTP original del ZIP AV local, si se conoce')
    parser.add_argument('--cer-modified', default='', help='Last-Modified HTTP original del ZIP Cercanías local, si se conoce')
    parser.add_argument('--previous', help='Instantánea JSON previa; conserva días de servicio pasados ausentes del nuevo GTFS')
    parser.add_argument('--start-date', help='Primer día de servicio AAAA-MM-DD; por defecto hace tres días en Madrid')
    parser.add_argument('--days', type=int, default=34, help='Número de días de servicio (1–93; por defecto 34)')
    parser.add_argument('--output', default='data/itinerarios-renfe.json')
    args = parser.parse_args()
    today = datetime.now(ZoneInfo('Europe/Madrid')).date()
    first_day = date.fromisoformat(args.start_date) if args.start_date else today - timedelta(days=3)
    with tempfile.TemporaryDirectory(prefix='vialab-gtfs-') as directory:
        feeds = {}
        for feed in ('av', 'cer'):
            local = getattr(args, feed)
            if local:
                feeds[feed] = (local, getattr(args, f'{feed}_modified'))
            else:
                path = str(Path(directory) / f'{feed}.zip')
                feeds[feed] = (path, download(SOURCES[feed]['url'], path))
        result = generate(feeds, first_day, args.days)
    if args.previous:
        try:
            previous_path = Path(args.previous)
            if previous_path.stat().st_size > 10_000_000:
                raise ValueError('La instantánea anterior es demasiado grande.')
            previous = json.loads(previous_path.read_text(encoding='utf-8'))
            result = merge_previous_snapshot(copy.deepcopy(result), previous, today)
        except (OSError, ValueError, TypeError, KeyError) as exc:
            print(f'Aviso: no se pudo reutilizar la instantánea anterior: {exc}', file=sys.stderr)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + '.tmp')
    temporary.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temporary.replace(output)
    print(f"Guardado {output}: {len(result['trips'])} patrones, {len(result['stops'])} paradas, {output.stat().st_size:,} bytes.")
    for source in result['sources']:
        print(f"{source['label']}: {source['included_from']} → {source['included_until']} (fecha de calendario, no circulación real)")
    print('Omisiones:', result['omitted'])


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        print(f'No se generó la instantánea: {exc}', file=sys.stderr)
        sys.exit(1)
