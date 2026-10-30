#!/usr/bin/env python3
"""Cancelaciones GTFS-RT Renfe con parada y horario GTFS estático exactos.

Son cancelaciones de viajes, no incidencias de infraestructura. La geometría
corresponde a la estación programada de salida, nunca al lugar de una avería.
No se inventan fecha individual, causa, operador ni coordenadas.
"""
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from pathlib import Path
import csv
import io
import logging
import math
import re
import threading
import time
import zipfile

TRIP_UPDATES_URL = 'https://gtfsrt.renfe.com/trip_updates_LD.json'
TRIP_UPDATES_DATASET = 'https://data.renfe.com/dataset/horarios-viaje-alta-velocidad-larga-media-distancia'
STATIC_DATASET = 'https://data.renfe.com/dataset/horarios-de-alta-velocidad-larga-distancia-y-media-distancia'
EXPRESS = {'AVE', 'AVE INT', 'AVLO', 'AVANT', 'AVANT EXP'}
CACHE_SECONDS = 30
FRESH_SECONDS = 90
FUTURE_TOLERANCE = 30
HORIZON_SECONDS = 24 * 3600
MAX_ENTITIES = 20_000
MAX_MEMBER_BYTES = 60_000_000
try:
    MADRID = ZoneInfo('Europe/Madrid')
except ZoneInfoNotFoundError:
    # Windows often has no system IANA database. Prefer system updates, but
    # bundle this public-domain 2026c TZif so the rest is stdlib-only.
    try:
        with (Path(__file__).resolve().parent/'data/europe-madrid-tzdb-2026c.tzif').open('rb') as zone_file:
            MADRID = ZoneInfo.from_file(zone_file,key='Europe/Madrid')
    except (OSError,ValueError):
        MADRID = None  # service reports an error; never guess a timezone


def finite(value):
    if isinstance(value, bool): return None
    try: n = float(value)
    except (ValueError, TypeError, OverflowError): return None
    return n if math.isfinite(n) else None


def stamp(value):
    n = finite(value)
    return int(n) if n is not None and 0 < n < 253402300800 else None


def clean(value, limit=150):
    return str(value).strip()[:limit] if isinstance(value, (str, int)) and not isinstance(value, bool) else ''


def is_recent(value, now):
    return value is not None and -FUTURE_TOLERANCE <= now-value <= FRESH_SECONDS


def parse_cancellations(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get('header'), dict):
        raise ValueError('Cabecera GTFS-RT no válida')
    header = stamp(payload['header'].get('timestamp'))
    if header is None: raise ValueError('Feed de cancelaciones sin fecha válida')
    entities = payload.get('entity', [])
    if not isinstance(entities, list) or len(entities)>MAX_ENTITIES:
        raise ValueError('Entidades GTFS-RT no válidas')
    trips = {}
    missing_id = 0
    for entity in entities:
        if not isinstance(entity, dict): raise ValueError('Entidad GTFS-RT inválida')
        if 'tripUpdate' not in entity and 'trip_update' not in entity: continue
        update=entity.get('tripUpdate') if 'tripUpdate' in entity else entity.get('trip_update')
        if not isinstance(update, dict): raise ValueError('TripUpdate GTFS-RT inválida')
        trip=update.get('trip')
        if not isinstance(trip, dict): raise ValueError('TripDescriptor GTFS-RT inválido')
        trip_id=clean(trip.get('tripId') or trip.get('trip_id'))
        raw_relationship=trip.get('scheduleRelationship')
        if raw_relationship is None: raw_relationship=trip.get('schedule_relationship')
        relationship=clean(raw_relationship).upper()
        relationship={'0':'SCHEDULED','3':'CANCELED'}.get(relationship,relationship)
        if not trip_id:
            if relationship=='CANCELED': missing_id+=1
            continue
        start=clean(trip.get('startDate') or trip.get('start_date'),20)
        key=(trip_id,start)
        group=trips.setdefault(key,{'relationships':set(),'timestamps':[]})
        group['relationships'].add(relationship or 'SCHEDULED')
        individual=stamp(update.get('timestamp'))
        if individual is not None: group['timestamps'].append(individual)
    candidates=[];conflicting=0
    # A trip with several competing dates or descriptors and an omitted date
    # is not unambiguously assignable to one service day.
    id_dates={}
    for trip_id,start in trips: id_dates.setdefault(trip_id,set()).add(start)
    for (trip_id,start),group in trips.items():
        if 'CANCELED' not in group['relationships']: continue
        if len(group['relationships'])>1 or ('' in id_dates[trip_id] and len(id_dates[trip_id])>1):
            conflicting+=1;continue
        candidates.append({'trip_id':trip_id,'start_date':start,
                           'individual_timestamp':max(group['timestamps']) if group['timestamps'] else None})
    incrementality=clean(payload['header'].get('incrementality')).upper()
    if incrementality not in ('','0','1','FULL_DATASET','DIFFERENTIAL'):
        raise ValueError('Incrementalidad GTFS-RT desconocida')
    return {'header_timestamp':header,'candidates':candidates,'conflicting':conflicting,'missing_id':missing_id,
            'differential':incrementality in ('DIFFERENTIAL','1')}


def _records(archive,name,required,optional=False):
    try: info=archive.getinfo(name)
    except KeyError:
        if optional: return
        raise ValueError(f'Falta {name} en el GTFS estático')
    if info.file_size>MAX_MEMBER_BYTES: raise ValueError(f'{name} excede el tamaño permitido')
    with archive.open(info) as raw, io.TextIOWrapper(raw,encoding='utf-8-sig',newline='') as stream:
        reader=csv.DictReader(stream)
        if not reader.fieldnames: raise ValueError(f'{name} no tiene cabecera')
        # Renfe pads some GTFS field names with whitespace.
        reader.fieldnames=[str(value).strip() for value in reader.fieldnames]
        if not set(required).issubset(reader.fieldnames): raise ValueError(f'Esquema inválido en {name}')
        for row in reader:
            yield {key: (value.strip() if isinstance(value,str) else value) for key,value in row.items() if key is not None}


def _set_unique(mapping,key,value):
    if not key: return
    if key not in mapping: mapping[key]=value
    elif mapping[key]!=value: mapping[key]=None


def _day(value):
    if not re.fullmatch(r'\d{8}',clean(value)): return None
    try: return datetime.strptime(value,'%Y%m%d').date()
    except ValueError: return None


def _gtfs_seconds(value):
    match=re.fullmatch(r'(\d{1,2}):(\d{2}):(\d{2})',clean(value))
    if not match: return None
    hour,minute,second=map(int,match.groups())
    return hour*3600+minute*60+second if hour<48 and minute<60 and second<60 else None


def _local_instant(day,seconds):
    """Reject DST transition days instead of guessing feed clock semantics.

    GTFS measures time from noon-minus-12h, which differs from local wall
    midnight on clock-change days; some producers instead encode wall time.
    Suppress both the service day and the departure day if either changes.
    """
    if not isinstance(day,date) or seconds is None or MADRID is None: return None
    naive=datetime.combine(day,datetime.min.time())+timedelta(seconds=seconds)
    for d in (day,naive.date()):
        offsets={datetime(d.year,d.month,d.day,h,tzinfo=MADRID).utcoffset() for h in (0,12,23)}
        if len(offsets)>1: return None
    first=naive.replace(tzinfo=MADRID,fold=0);second=naive.replace(tzinfo=MADRID,fold=1)
    if first.utcoffset()!=second.utcoffset(): return None
    if first.astimezone(timezone.utc).astimezone(MADRID).replace(tzinfo=None)!=naive: return None
    return first.timestamp()


def _service_active(day,calendar,exceptions):
    key=day.strftime('%Y%m%d')
    exception=exceptions.get(key)
    if exception == '1': return True
    if exception == '2': return False
    if exception == 'ambiguous': return None
    if not calendar: return False
    if calendar.get('start') is None or calendar.get('end') is None: return None
    return calendar['start']<=day<=calendar['end'] and calendar['weekdays'][day.weekday()]=='1'


def _unambiguous_service_day(calendar, exceptions):
    """Without RT startDate, accept only a trip active on exactly one day.

    Renfe trip IDs may end in a date but still run on several days. Assigning
    yesterday's cancellation to the one future departure would be a false
    incident. Scan the full calendar plus added exceptions instead.
    """
    candidates=set()
    if calendar:
        start,end=calendar.get('start'),calendar.get('end')
        if start is None or end is None or end<start or (end-start).days>730:
            return None
        day=start
        while day<=end:
            candidates.add(day);day+=timedelta(days=1)
    for raw,value in exceptions.items():
        if value in ('1','ambiguous'):
            day=_day(raw)
            if day is None: return None
            candidates.add(day)
    if not calendar and not exceptions: return None
    active=[]
    for day in sorted(candidates):
        value=_service_active(day,calendar,exceptions)
        if value is None: return None
        if value: active.append(day)
        if len(active)>1: return None
    return active[0] if len(active)==1 else None


def _station(row):
    if not row: return {'name':'Estación no identificada','location':None}
    lat,lon=finite(row.get('stop_lat')),finite(row.get('stop_lon'))
    if lat is None or lon is None or not ((35<=lat<=44.4 and -9.8<=lon<=4.6) or (27.4<=lat<=29.8 and -18.5<=lon<=-13)):
        point=None
    else: point={'latitude':lat,'longitude':lon}
    return {'name':clean(row.get('stop_name')) or 'Estación sin nombre','location':point}


def resolve_trips(body, candidates, now):
    """Join trip IDs exactly, apply service calendars and next-24h departure.

    If a trip repeats on several eligible service days without startDate, it is
    ambiguous and suppressed. No synthetic positions or incident causes.
    """
    desired={item['trip_id'] for item in candidates}
    if MADRID is None: raise ValueError('Zona horaria Europe/Madrid no disponible')
    if not isinstance(body,bytes): raise ValueError('GTFS estático no disponible')
    with zipfile.ZipFile(io.BytesIO(body)) as archive:
        if not ({'calendar.txt','calendar_dates.txt'} & set(archive.namelist())):
            raise ValueError('GTFS estático sin calendario de servicios')
        routes={}
        for row in _records(archive,'routes.txt',('route_id','route_short_name')):
            _set_unique(routes,clean(row.get('route_id')),clean(row.get('route_short_name')).upper())
        trips={}
        for row in _records(archive,'trips.txt',('trip_id','route_id','service_id')):
            trip_id=clean(row.get('trip_id'))
            if trip_id in desired:
                _set_unique(trips,trip_id,(clean(row.get('route_id')),clean(row.get('service_id'))))
        selected={}
        for item in candidates:
            value=trips.get(item['trip_id'])
            if value and routes.get(value[0]) in EXPRESS:
                selected[item['trip_id']]=(routes[value[0]],value[1])
        service_ids={value[1] for value in selected.values()}
        calendars={}
        weekdays=('monday','tuesday','wednesday','thursday','friday','saturday','sunday')
        for row in _records(archive,'calendar.txt',('service_id','start_date','end_date',*weekdays),optional=True):
            service=clean(row.get('service_id'))
            if service in service_ids:
                days=tuple(row.get(k) for k in weekdays)
                cal={'start':_day(row.get('start_date')),'end':_day(row.get('end_date')),'weekdays':days}
                if any(value not in ('0','1') for value in days): cal=None
                _set_unique(calendars,service,cal)
        exceptions={}
        for row in _records(archive,'calendar_dates.txt',('service_id','date','exception_type'),optional=True):
            service=clean(row.get('service_id')); day=clean(row.get('date'))
            if service in service_ids and _day(day) is not None:
                value=row.get('exception_type');value=value if value in ('1','2') else 'ambiguous'
                current=exceptions.setdefault(service,{})
                if day in current and current[day]!=value: current[day]='ambiguous'
                else: current[day]=value
        times={};ambiguous_times=set()
        for row in _records(archive,'stop_times.txt',('trip_id','stop_id','stop_sequence','departure_time','arrival_time')):
            trip_id=clean(row.get('trip_id'))
            if trip_id not in selected: continue
            try: sequence=int(row.get('stop_sequence',''))
            except ValueError: ambiguous_times.add(trip_id);continue
            entry=(sequence,clean(row.get('stop_id')),clean(row.get('departure_time')),clean(row.get('arrival_time')))
            info=times.get(trip_id)
            if info is None: times[trip_id]={'first':entry,'last':entry}
            else:
                if sequence==info['first'][0] and entry!=info['first']: ambiguous_times.add(trip_id)
                if sequence==info['last'][0] and entry!=info['last']: ambiguous_times.add(trip_id)
                if sequence<info['first'][0]: info['first']=entry
                if sequence>info['last'][0]: info['last']=entry
        wanted_stops={entry[i][1] for entry in times.values() for i in ('first','last')}
        stops={}
        for row in _records(archive,'stops.txt',('stop_id','stop_name','stop_lat','stop_lon')):
            stop_id=clean(row.get('stop_id'))
            if stop_id in wanted_stops:
                # Keep identical duplicate stop IDs; reject conflicting ones.
                _set_unique(stops,stop_id,(clean(row.get('stop_name')),clean(row.get('stop_lat')),clean(row.get('stop_lon'))))
        def stop_for(stop_id):
            value=stops.get(stop_id)
            return _station({'stop_name':value[0],'stop_lat':value[1],'stop_lon':value[2]}) if value else _station(None)
        records=[];missing=0;ambiguous=0
        for item in candidates:
            trip_id=item['trip_id'];selected_trip=selected.get(trip_id)
            if selected_trip is None:
                matched=trips.get(trip_id)
                if not matched or not routes.get(matched[0]): missing+=1
                continue
            if trip_id not in times or trip_id in ambiguous_times:
                ambiguous+=1;continue
            service,service_id=selected_trip
            if (service_id in calendars and calendars[service_id] is None) or (service_id not in calendars and service_id not in exceptions):
                ambiguous+=1;continue
            departure_seconds=_gtfs_seconds(times[trip_id]['first'][2])
            if departure_seconds is None: ambiguous+=1;continue
            supplied=item['start_date']
            if supplied:
                candidate_day=_day(supplied)
                if candidate_day is None: ambiguous+=1;continue
                possible=[candidate_day]
            else:
                # A repeated trip without startDate cannot be assigned to the
                # next day merely because earlier departures have passed.
                unique=_unambiguous_service_day(calendars.get(service_id),exceptions.get(service_id,{}))
                if unique is None: ambiguous+=1;continue
                possible=[unique]
            eligible=[];uncertain=False
            for day in possible:
                active=_service_active(day,calendars.get(service_id),exceptions.get(service_id,{}))
                departure=_local_instant(day,departure_seconds)
                if active is None or (active and departure is None): uncertain=True;continue
                if active and now <= departure <= now+HORIZON_SECONDS: eligible.append((day,departure))
            if len(eligible)>1 or uncertain: ambiguous+=1;continue
            if not eligible: continue
            day,departure=eligible[0]
            origin=stop_for(times[trip_id]['first'][1]);destination=stop_for(times[trip_id]['last'][1])
            records.append({'id':f'{trip_id}:{day.isoformat()}', 'trip_id':trip_id, 'service_name':service,
                            'service_date':day.isoformat(),'planned_departure':departure,
                            'origin':origin['name'],'destination':destination['name'],
                            'location':origin['location'],
                            'individual_timestamp':item['individual_timestamp'] if item['individual_timestamp'] is not None and item['individual_timestamp']<=now+FUTURE_TOLERANCE else None})
    records.sort(key=lambda x:(x['planned_departure'],x['trip_id']))
    return records,missing,ambiguous


class CancellationCache:
    def __init__(self,fetcher,catalog_provider,monotonic=time.monotonic,clock=time.time):
        self.fetcher,self.catalog_provider,self.monotonic,self.clock=fetcher,catalog_provider,monotonic,clock
        self.last_attempt=None;self.cached=None;self.lock=threading.Lock()

    def _collect(self):
        parsed=parse_cancellations(self.fetcher(TRIP_UPDATES_URL));now=self.clock()
        if not is_recent(parsed['header_timestamp'],now):
            return {'status':'stale','header_timestamp':parsed['header_timestamp'],'fetched_at':int(now)}
        catalog=self.catalog_provider()
        if catalog.get('status')!='available' or not isinstance(catalog.get('body'),bytes):
            raise ValueError('GTFS estático Renfe no disponible')
        # A regenerated header must not promote an explicitly old individual
        # TripUpdate into a live cancellation. Missing timestamps are retained
        # only with a partial-coverage warning and an explicit unknown date.
        current_time=self.clock();candidates=[];old_individual=0
        for item in parsed['candidates']:
            if item['individual_timestamp'] is not None and not is_recent(item['individual_timestamp'],current_time):
                old_individual+=1
            else:candidates.append(item)
        records,missing,ambiguous=resolve_trips(catalog['body'],candidates,self.clock())
        no_individual=sum(record['individual_timestamp'] is None for record in records)
        partial=missing or ambiguous or parsed['conflicting'] or parsed['missing_id'] or parsed['differential'] or old_individual or no_individual
        return {'status':'partial' if partial else 'fresh',
                'header_timestamp':parsed['header_timestamp'],'fetched_at':int(now),'records':records,
                'unmatched_trips':missing,'ambiguous_trips':ambiguous+parsed['conflicting']+parsed['missing_id'],
                'stale_individual_updates':old_individual,'missing_individual_timestamps':no_individual,
                'catalog_fetched_at':catalog.get('fetched_at')}

    def get(self):
        with self.lock:
            if self.last_attempt is None or self.monotonic()-self.last_attempt>=CACHE_SECONDS:
                self.last_attempt=self.monotonic()
                try:self.cached=self._collect()
                except Exception as exc:
                    logging.warning('Cancelaciones Renfe no disponibles: %s',exc)
                    self.cached={'status':'error','fetched_at':int(self.clock())}
            now=int(self.clock());result=dict(self.cached)
            if result['status'] in ('fresh','partial') and not is_recent(result.get('header_timestamp'),now):
                result['status']='stale'
            if result['status'] in ('fresh','partial'):
                within=[r for r in result['records'] if now<=r['planned_departure']<=now+HORIZON_SECONDS]
                valid=[r for r in within if r['individual_timestamp'] is None or is_recent(r['individual_timestamp'],now)]
                newly_old=len(within)-len(valid)
                result['records']=[dict(r) for r in valid]
                result['stale_individual_updates']+=newly_old
                result['missing_individual_timestamps']=sum(r['individual_timestamp'] is None for r in valid)
                if newly_old or result['missing_individual_timestamps']: result['status']='partial'
                result['count']=len(result['records'])
            else:result.update({'records':[],'count':None})
            result.update({'kind':'renfe-av-cancellations','generated_at':now,'fresh_seconds':FRESH_SECONDS,
                           'horizon_seconds':HORIZON_SECONDS,'source_url':TRIP_UPDATES_DATASET,
                           'static_url':STATIC_DATASET,'attribution':'Origen de los datos: Renfe Operadora · CC BY 4.0'})
            return result
