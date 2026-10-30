"""Synthetic fixtures. They are never presented to users as real ADIF data."""
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import urlopen
from unittest.mock import patch
import importlib.util
import json
import threading
import unittest

import limitaciones as ltv

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('via_servidor_ltv', ROOT / 'servidor.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
NOW = 1793394000  # fixed test clock
DAY = int(datetime(2026, 10, 26, tzinfo=timezone.utc).timestamp() * 1000)


def feature(table, oid, **attrs):
    source = ltv.SOURCES[table]
    defaults = {field: None for field in source['fields']}
    defaults[source['id_field']] = oid
    defaults.update(attrs)
    return {'attributes': defaults}


def fixture_rows():
    a = feature('mapped', 1, LTVID=100, CODLINEA='010', DESCLINEA='Fixture AV', PKINI=10.1, PKFIN=10.5,
                RESTRICCIONVELOCIDAD=80, VIAS='I', DESCPSINI='A', DESCPSFIN='B')
    a['geometry'] = {'x': -3.8, 'y': 40.1}
    no_geo = feature('mapped', 2, LTVID=101, CODLINEA='010', DESCLINEA='Fixture AV', PKINI=12, PKFIN=12.3,
                     RESTRICCIONVELOCIDAD=100, VIAS='II')
    no_geo['geometry'] = {'x': 0, 'y': 0}  # Never silently turned into a Spanish point.
    b = feature('mapped', 3, LTVID=102, CODLINEA='100', DESCLINEA='Fixture convencional', PKINI=10, PKFIN=11,
                RESTRICCIONVELOCIDAD=90)
    b['geometry'] = {'x': -3.7, 'y': 40.2}
    unknown = feature('mapped', 4, LTVID=103, CODLINEA='010', PKINI=None, PKFIN=11)
    unknown['geometry'] = {'x': -3.9, 'y': 40.2}
    table_no_loc = feature('unlocated', 1, LTVID=105, CODLINEA='010', PKINI=14, PKFIN=14.1,
                           RESTRICCIONVELOCIDAD=60, OBSERVACIONES='Sin geometría fiable')
    load = feature('load', 1, FICHERO_LTV_VIGOR='2026-10-26', FECHA_LTV_VIGOR=DAY,
                   HORA_LTV_VIGOR='09:00:00.152+01:00', FECHA_LTV_CARGA=DAY,
                   HORA_LTV_CARGA='07:46:03.945+01:00')
    track = feature('tracks', 44, COD_LINEA='010 - LINEA DE PRUEBA', COD_TIPO_R='A', PKI=0, PKD=50)
    return {'mapped': [a, no_geo, b, unknown], 'unlocated': [table_no_loc], 'load': [load], 'tracks': [track]}


class FakeArcGIS:
    def __init__(self, rows=None, edited=NOW-10, omit_edit=False):
        self.rows = rows if rows is not None else fixture_rows()
        self.edited = edited
        self.omit_edit = omit_edit
        self.urls = []
        self.lock = threading.Lock()
        self.mutate_meta = False
        self.meta_count = {key:0 for key in ltv.SOURCES}
        self.truncate = False
        self.bad_crs = False

    def __call__(self, url):
        with self.lock:
            self.urls.append(url)
        parsed = urlsplit(url)
        args = parse_qs(parsed.query)
        name = next((name for name, source in ltv.SOURCES.items() if url.startswith(source['url']+'?') or url.startswith(source['url']+'/query?')), None)
        if name is None: raise AssertionError(f'unexpected URL {url}')
        source = ltv.SOURCES[name]
        rows = self.rows[name]
        if not parsed.path.endswith('/query'):
            with self.lock:
                self.meta_count[name] += 1
                index = self.meta_count[name]
            edit = (self.edited + (1 if self.mutate_meta and index > 1 else 0)) * 1000
            info = {} if self.omit_edit else {'dataLastEditDate': edit, 'schemaLastEditDate': edit}
            return {'fields':[{'name': name} for name in source['fields']],
                    'geometryType':'esriGeometryPoint' if source['geometry'] else None, 'editingInfo':info}
        if args.get('returnIdsOnly') == ['true']:
            return {'objectIdFieldName': source['id_field'], 'objectIds':[r['attributes'][source['id_field']] for r in rows]}
        wanted = {int(i) for i in args.get('objectIds',[''])[0].split(',') if i}
        selected = [r for r in rows if r['attributes'][source['id_field']] in wanted]
        if self.truncate and selected: selected=selected[:-1]
        response={'features':selected}
        if source['geometry']:
            response['spatialReference']={'wkid':3857 if self.bad_crs else 4326}
        return response


class LtvParsingTests(unittest.TestCase):
    def test_catalog_requires_official_a_type_and_exact_code_pk_overlap(self):
        ranges = ltv.catalog_ranges(fixture_rows()['tracks'])
        self.assertEqual(ltv.on_high_speed_line({'CODLINEA':'010','PKINI':9,'PKFIN':11},ranges),'av')
        self.assertEqual(ltv.on_high_speed_line({'CODLINEA':'010','PKINI':11,'PKFIN':9},ranges),'av')
        self.assertEqual(ltv.on_high_speed_line({'CODLINEA':'100','PKINI':9,'PKFIN':11},ranges),'other')
        self.assertEqual(ltv.on_high_speed_line({'CODLINEA':'010','PKINI':51,'PKFIN':55},ranges),'other')
        self.assertEqual(ltv.on_high_speed_line({'CODLINEA':'010','PKINI':50,'PKFIN':51},ranges),'other')
        self.assertEqual(ltv.on_high_speed_line({'CODLINEA':'010','PKINI':None,'PKFIN':1},ranges),'unknown')
        with self.assertRaises(ValueError):
            ltv.catalog_ranges([feature('tracks',1,COD_LINEA='010 - X',COD_TIPO_R='B1',PKI=0,PKD=5)])
        with self.assertRaises(ValueError): ltv.catalog_ranges([])

    def test_coordinate_absence_is_kept_in_list_not_fabricated(self):
        rows=fixture_rows();ranges=ltv.catalog_ranges(rows['tracks'])
        points, unlocated, unknown=ltv.classify_records(rows['mapped'],rows['unlocated'],ranges)
        self.assertEqual([x['ltv_id'] for x in points],[100])
        self.assertEqual({x['ltv_id'] for x in unlocated},{101,105})
        self.assertTrue(all(x['location'] is None for x in unlocated))
        self.assertEqual(unknown,1)
        self.assertEqual(points[0]['location'],{'latitude':40.1,'longitude':-3.8})

    def test_calendar_and_offset_are_not_replaced_by_query_time(self):
        time=ltv.local_source_time(DAY,'09:00:00.152+01:00')
        self.assertAlmostEqual(time,datetime(2026,10,26,8,0,0,152000,tzinfo=timezone.utc).timestamp())
        self.assertIsNone(ltv.local_source_time(DAY,'09:00:00'))
        self.assertIsNone(ltv.local_source_time(True,'09:00:00+01:00'))
        source=ltv.load_metadata(fixture_rows()['load'],NOW)
        self.assertEqual(source['file_name'],'2026-10-26')
        self.assertAlmostEqual(source['file_effective_at'],time)
        self.assertLess(source['file_loaded_at'],source['file_effective_at'])
        # A future "effective" row must not promote a snapshot to current.
        future=feature('load',2, FECHA_LTV_VIGOR=(NOW+86400)*1000, HORA_LTV_VIGOR='12:00:00+00:00')
        self.assertEqual(ltv.load_metadata([future],NOW)['file_effective_at'],None)

    def test_fresh_http_query_cannot_refresh_stale_or_unknown_source(self):
        snapshot={'source_edited_at':NOW-5,'file_effective_at':NOW-ltv.STALE_SECONDS-1,'fetched_at':NOW}
        self.assertEqual(ltv.snapshot_status(snapshot,NOW),'stale')
        snapshot['file_effective_at']=NOW-2
        self.assertEqual(ltv.snapshot_status(snapshot,NOW),'recent')
        self.assertEqual(ltv.snapshot_status(snapshot,NOW+ltv.STALE_SECONDS+1),'stale')
        snapshot['source_edited_at']=NOW+61
        self.assertEqual(ltv.snapshot_status(snapshot,NOW),'unknown')
        snapshot['source_edited_at']=None
        self.assertEqual(ltv.snapshot_status(snapshot,NOW),'unknown')
        self.assertEqual(ltv.snapshot_status({'error':'fallo'},NOW),'error')

    def test_query_rejects_truncation_and_wrong_coordinate_system(self):
        fake=FakeArcGIS(); fake.truncate=True
        with self.assertRaises(ValueError): ltv.query_all(fake,ltv.SOURCES['mapped'])
        fake=FakeArcGIS();fake.bad_crs=True
        with self.assertRaises(ValueError): ltv.query_all(fake,ltv.SOURCES['mapped'])

    def test_pagination_and_exact_id_verification(self):
        rows=fixture_rows()
        original=rows['mapped'][0]
        rows['mapped']=[{'attributes':{**original['attributes'],'OBJECTID':i},'geometry':original['geometry']}
                        for i in range(1,ltv.BATCH_SIZE+3)]
        fake=FakeArcGIS(rows)
        self.assertEqual(len(ltv.query_all(fake,ltv.SOURCES['mapped'])),ltv.BATCH_SIZE+2)
        # ID request + two actual batches, not the first 150 only.
        self.assertEqual(len(fake.urls),3)
        rows['mapped'].append(rows['mapped'][0])
        with self.assertRaises(ValueError): ltv.query_all(FakeArcGIS(rows),ltv.SOURCES['mapped'])


class LtvCacheTests(unittest.TestCase):
    def test_collects_official_sources_and_ages_snapshot_in_cache(self):
        fake=FakeArcGIS(); now=[NOW]; mono=[0]
        cache=ltv.LimitationsCache(fetcher=fake,clock=lambda:now[0],monotonic=lambda:mono[0])
        result=cache.get();calls=len(fake.urls)
        self.assertEqual(result['status'],'stale')  # File is Oct 26 even if queried Oct 30.
        self.assertEqual(result['count'],1); self.assertEqual(len(result['unlocated']),2)
        self.assertEqual(result['attribution'],'© Administrador de infraestructuras ferroviarias')
        self.assertEqual(result['unknown_classification'],1)
        self.assertTrue(all(url.startswith('https://services7.arcgis.com/') for url in fake.urls))
        mono[0]=299; now[0]+=299;cache.get(); self.assertEqual(len(fake.urls),calls)
        mono[0]=300;now[0]+=1;cache.get();self.assertEqual(len(fake.urls),calls*2)

    def test_missing_source_dates_and_future_dates_are_unknown(self):
        result=ltv.LimitationsCache(fetcher=FakeArcGIS(omit_edit=True),clock=lambda:NOW,monotonic=lambda:0).get()
        self.assertEqual(result['status'],'unknown'); self.assertIsNone(result['source_edited_at'])
        result=ltv.LimitationsCache(fetcher=FakeArcGIS(edited=NOW+200),clock=lambda:NOW,monotonic=lambda:0).get()
        self.assertEqual(result['status'],'unknown')

    def test_failure_or_source_change_is_not_a_fake_zero(self):
        fake=FakeArcGIS();fake.mutate_meta=True
        result=ltv.LimitationsCache(fetcher=fake,clock=lambda:NOW,monotonic=lambda:0).get()
        self.assertEqual(result['status'],'error');self.assertIsNone(result['count'])
        self.assertEqual(result['records'],[])
        error=ltv.LimitationsCache(fetcher=lambda _:(_ for _ in ()).throw(OSError('offline')),
                                    clock=lambda:NOW,monotonic=lambda:0).get()
        self.assertEqual(error['status'],'error');self.assertIsNone(error['count'])

    def test_concurrent_clients_share_one_refresh(self):
        fake=FakeArcGIS()
        cache=ltv.LimitationsCache(fetcher=fake,clock=lambda:NOW,monotonic=lambda:0)
        results=[]
        threads=[threading.Thread(target=lambda:results.append(cache.get())) for _ in range(10)]
        for thread in threads:thread.start()
        for thread in threads:thread.join()
        self.assertEqual(len(results),10)
        self.assertTrue(all(result['count']==1 for result in results))
        self.assertTrue(all(n==2 for n in fake.meta_count.values()))

    def test_api_fixed_sources_not_client_supplied_and_nostore(self):
        fake=FakeArcGIS(); cache=ltv.LimitationsCache(fetcher=fake,clock=lambda:NOW,monotonic=lambda:0)
        httpd=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        thread=threading.Thread(target=httpd.serve_forever,daemon=True)
        with patch.object(server,'LIMITATIONS_CACHE',cache):
            thread.start()
            try:
                with urlopen(f'http://127.0.0.1:{httpd.server_port}/api/limitaciones?url=https://evil.example/') as response:
                    body=json.load(response)
                    self.assertEqual(response.headers['Cache-Control'],'no-store')
                    self.assertEqual(body['count'],1);self.assertEqual(body['status'],'stale')
                    self.assertTrue(all('evil.example' not in url for url in fake.urls))
            finally:
                httpd.shutdown();thread.join();httpd.server_close()


if __name__=='__main__':unittest.main()
