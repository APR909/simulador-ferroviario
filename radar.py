#!/usr/bin/env python3
"""Posiciones Renfe AV/LD/MD a través de la API pública RadarDeTrenes.

Fuente alternativa independiente, no oficial. Se usa únicamente si el feed
GTFS-RT directo de Renfe falla o caduca. Se verifican fecha de la instantánea,
fecha individual, coordenadas, duplicados y conteo; no se inventan posiciones.
Condiciones: https://radardetrenes.com/docs (atribuir Renfe/ADIF y mediador).
"""
from datetime import datetime
from urllib.request import Request, urlopen
import json
import logging
import math
import re
import threading
import time

URL='https://radardetrenes.com/api/v1/fleet?type=ld'
DATASET='https://radardetrenes.com/docs'
PROVIDER='RadarDeTrenes'
ATTRIBUTION='Datos de Renfe y ADIF, a través de RadarDeTrenes (servicio independiente)'
CACHE_SECONDS=30
FRESH_SECONDS=90
FUTURE_TOLERANCE=30
MAX_BYTES=4_000_000
MAX_TRAINS=20_000


def fetch_json():
    request=Request(URL,headers={'Accept':'application/json',
                   'User-Agent':'ViaLab/0.8 (educational rail map; https://radardetrenes.com/docs)'})
    with urlopen(request,timeout=8) as response:
        body=response.read(MAX_BYTES+1)
    if len(body)>MAX_BYTES: raise ValueError('Respuesta RadarDeTrenes demasiado grande')
    return json.loads(body)


def text(value,limit=150):
    return value.strip()[:limit] if isinstance(value,str) else ''


def finite(value):
    if isinstance(value,bool): return None
    try: n=float(value)
    except (ValueError,TypeError,OverflowError): return None
    return n if math.isfinite(n) else None


def iso_timestamp(value):
    """Accept explicit RFC3339 timezones only; never guess a local offset."""
    if not isinstance(value,str) or len(value)>80: return None
    value=value.strip()
    if not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)',value): return None
    # Keep compatibility with Python 3.9 and nanosecond Go timestamps.
    value=re.sub(r'(\.\d{6})\d+(?=Z|[+-]\d\d:\d\d$)',r'\1',value).replace('Z','+00:00')
    try: n=datetime.fromisoformat(value).timestamp()
    except (ValueError,OverflowError,OSError): return None
    return n if 0<n<253402300800 else None


def is_fresh(value,now):
    return value is not None and -FUTURE_TOLERANCE<=now-value<=FRESH_SECONDS


def in_boxes(lat,lon,boxes):
    return any(box['south']<=lat<=box['north'] and box['west']<=lon<=box['east'] for box in boxes)


def parse_radar(payload):
    if not isinstance(payload,dict): raise ValueError('Respuesta de flota RadarDeTrenes inválida')
    header=iso_timestamp(payload.get('updatedAt'));trains=payload.get('trains');count=payload.get('count')
    if header is None or not isinstance(trains,list) or isinstance(count,bool) or not isinstance(count,int) or count!=len(trains) or len(trains)>MAX_TRAINS:
        raise ValueError('La instantánea RadarDeTrenes carece de fecha o está incompleta')
    by_id={};invalid=0
    for item in trains:
        if not isinstance(item,dict) or item.get('type')!='long_distance': invalid+=1;continue
        identifier=text(item.get('id'),100);code=text(item.get('trainCode'),100)
        lat,lon=finite(item.get('latitude')),finite(item.get('longitude'))
        observed=iso_timestamp(item.get('timestamp'))
        if not identifier or not code or lat is None or lon is None or not (-90<=lat<=90 and -180<=lon<=180) or observed is None:
            invalid+=1;continue
        trip_id=text(item.get('tripId'),100)
        candidate={'id':'radar:'+identifier,'label':code,'trip_id':trip_id,'trip_ids':[trip_id] if trip_id else [],
                   'latitude':lat,'longitude':lon,'observed_at':observed,'time_basis':'vehicle',
                   'speed_mps':None,'bearing':None,'service_name':text(item.get('productName'),100) or None,
                   'product_category':text(item.get('productCategory'),30),
                   'origin':text(item.get('originName')),'destination':text(item.get('destinationName')),
                   'origin_code':text(item.get('originCode'),30),'destination_code':text(item.get('destinationCode'),30),
                   'source_provider':'radar','service_identification':'radar_product', '_positions':[(lat,lon)]}
        previous=by_id.get(identifier)
        if previous is None or candidate['observed_at']>previous['observed_at']:
            by_id[identifier]=candidate
        elif candidate['observed_at']==previous['observed_at']:
            if (lat,lon) not in previous['_positions']: previous['_positions'].append((lat,lon))
            # Conflicting metadata for the same fix cannot safely identify type.
            if candidate['service_name']!=previous['service_name'] or candidate['product_category']!=previous['product_category']:
                previous['service_name']=None;previous['product_category']=''
    valid=[];ambiguous=[]
    for entry in by_id.values():
        if len(entry['_positions'])>1:ambiguous.append(entry)
        else:valid.append({key:value for key,value in entry.items() if key!='_positions'})
    return {'header_timestamp':header,'all_vehicles':valid,'ambiguous_vehicles':ambiguous,'invalid':invalid}


class RadarCache:
    def __init__(self,fetcher=fetch_json,monotonic=time.monotonic,clock=time.time):
        self.fetcher,self.monotonic,self.clock=fetcher,monotonic,clock
        self.last_attempt=None;self.cached=None;self.lock=threading.Lock()

    def get(self,boxes):
        with self.lock:
            if self.last_attempt is None or self.monotonic()-self.last_attempt>=CACHE_SECONDS:
                self.last_attempt=self.monotonic()
                try:self.cached={'parsed':parse_radar(self.fetcher()),'fetched_at':int(self.clock())}
                except Exception as exc:
                    logging.warning('RadarDeTrenes no disponible: %s',exc)
                    self.cached={'error':'No se pudo consultar o validar RadarDeTrenes.','fetched_at':int(self.clock())}
            now=self.clock();cached=self.cached
            meta={'label':'Renfe AV / Larga y Media Distancia · RadarDeTrenes','dataset':DATASET,
                  'fetched_at':cached['fetched_at'],'source_provider':'radar','provider_url':'https://radardetrenes.com',
                  'attribution':ATTRIBUTION}
            if cached.get('error'):
                return {**meta,'status':'error','count':None,'vehicles':[],'message':cached['error']}
            parsed=cached['parsed'];header=parsed['header_timestamp']
            if not is_fresh(header,now):
                return {**meta,'status':'stale','count':None,'vehicles':[],'header_timestamp':header,
                        'message':'La instantánea RadarDeTrenes está atrasada o es futura.'}
            in_area=[v for v in parsed['all_vehicles'] if in_boxes(v['latitude'],v['longitude'],boxes)]
            recent=[dict(v) for v in in_area if is_fresh(v['observed_at'],now)]
            stale=len(in_area)-len(recent)
            ambiguous=sum(1 for v in parsed['ambiguous_vehicles'] if any(in_boxes(lat,lon,boxes) for lat,lon in v['_positions']))
            invalid=parsed['invalid']
            return {**meta,'status':'partial' if stale or ambiguous or invalid else 'fresh','count':len(recent),
                    'vehicles':recent,'header_timestamp':header,'excluded_stale':stale,
                    'excluded_ambiguous':ambiguous,'excluded_invalid':invalid,'feed_time_fallback':0}
