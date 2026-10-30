"""Datos sintéticos: jamás se presentan como posiciones reales en la aplicación."""
import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import urlopen
import zipfile

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('via_servidor_espana', ROOT / 'servidor.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
NOW = 1_793_316_000


def entity(identifier, lat, lon, when=NOW, trip='viaje-1'):
    return {'id': identifier, 'vehicle': {
        'position': {'latitude': lat, 'longitude': lon}, 'timestamp': str(when),
        'vehicle': {'id': identifier}, 'trip': {'tripId': trip},
    }}


def feed(*entities, header=NOW):
    return {'header': {'timestamp': str(header)}, 'entity': list(entities)}


def catalog_zip():
    result = io.BytesIO()
    with zipfile.ZipFile(result, 'w') as archive:
        archive.writestr('routes.txt', 'route_id,route_short_name\nr1,AVE\nr2,MD\n')
        archive.writestr('trips.txt', 'trip_id,route_id\nviaje-1,r1\nviaje-2,r2\nviaje-3,r1\n')
    return result.getvalue()


class NationalScopeTests(unittest.TestCase):
    def test_spain_and_sevilla_share_fetches_but_filter_by_scope(self):
        calls = []
        fixtures = feed(entity('s',37.39,-5.98), entity('m',40.42,-3.70),
                        entity('b',41.39,2.17), entity('i',39.57,2.65),
                        entity('c',28.47,-16.25), entity('outside',52.3,4.9))
        cache = server.RenfeCache(fetcher=lambda u: calls.append(u) or fixtures,
                                  monotonic=lambda: 5, clock=lambda: NOW)
        local, national = cache.get(), cache.get('espana')
        self.assertEqual(len(calls),2, 'ambos ámbitos deben compartir las dos consultas')
        self.assertEqual(local['feeds']['cercanias']['count'],1)
        self.assertEqual(national['feeds']['cercanias']['count'],5)
        self.assertEqual({v['id'] for v in national['feeds']['cercanias']['vehicles']}, {'s','m','b','i','c'})
        self.assertEqual(national['scope'],'espana')
        self.assertEqual(len(national['boxes']),2)
        self.assertIn('fuera de España', national['coverage'])
        with self.assertRaises(ValueError): cache.get('arbitrario')

    def test_equal_time_conflicting_coordinates_are_excluded_not_guessed(self):
        payload = feed(entity('1',40.4,-3.7), entity('1',40.5,-3.8), entity('2',41.39,2.17))
        parsed = server.parse_feed(payload)
        cached = {'label':'Fixture','dataset':'https://example.test','fetched_at':NOW,'parsed':parsed}
        result = server.feed_snapshot(cached,NOW,'espana')
        self.assertEqual(result['status'],'partial')
        self.assertEqual(result['excluded_ambiguous'],1)
        self.assertEqual([v['id'] for v in result['vehicles']], ['2'])

    def test_duplicate_coordinates_preserve_trip_ids_and_stale_is_not_live(self):
        payload = feed(entity('1',40.4,-3.7,trip='viaje-1'), entity('1',40.4,-3.7,trip='viaje-3'))
        parsed = server.parse_feed(payload)
        cached = {'label':'Fixture','dataset':'https://example.test','fetched_at':NOW,'parsed':parsed}
        fresh = server.feed_snapshot(cached,NOW,'espana')
        self.assertEqual(fresh['count'],1)
        self.assertEqual(set(fresh['vehicles'][0]['trip_ids']), {'viaje-1','viaje-3'})
        expired = server.feed_snapshot(cached,NOW+91,'espana')
        self.assertEqual(expired['status'],'stale')
        self.assertEqual(expired['vehicles'],[])
        self.assertIsNone(expired['count'])

    def test_official_gtfs_exact_join_and_ambiguous_service_names(self):
        types = server.parse_service_types(catalog_zip())
        self.assertEqual(types,{'viaje-1':'AVE','viaje-2':'MD','viaje-3':'AVE'})
        cached = server.RenfeCache(fetcher=lambda _:feed(
            entity('1',40.4,-3.7,trip='viaje-1'), entity('2',41.4,2.1,trip='sin-identificar'),
            entity('3',42,-4,trip='viaje-1'), entity('3',42,-4,trip='viaje-2')),
            monotonic=lambda:0,clock=lambda:NOW)
        snap = cached.get('espana')
        result = server.annotate_service_types(snap,{'status':'available','lookup':types,'fetched_at':NOW})
        by_id={v['id']:v for v in result['feeds']['larga_distancia']['vehicles']}
        self.assertEqual(by_id['1']['service_name'],'AVE')
        self.assertIsNone(by_id['2']['service_name'])
        self.assertIsNone(by_id['3']['service_name'])
        self.assertEqual(result['service_catalog']['matched'],1)
        # Annotation must not leak into the shared cache or the Seville view.
        self.assertNotIn('service_name', cached.cached['larga_distancia']['parsed']['all_vehicles'][0])

    def test_static_cache_limit_and_failure_are_isolated(self):
        with self.assertRaises((zipfile.BadZipFile,ValueError)):
            server.parse_service_types(b'not a zip')
        monotonic=[0]
        calls=[]
        def fetch(): calls.append(1); return catalog_zip()
        cache=server.StaticServiceCache(fetcher=fetch,monotonic=lambda:monotonic[0],clock=lambda:NOW)
        self.assertEqual(cache.get()['status'],'available')
        self.assertEqual(cache.get()['status'],'available')
        self.assertEqual(len(calls),1)
        monotonic[0]=server.STATIC_CACHE_SECONDS
        cache.get(); self.assertEqual(len(calls),2)
        failing=server.StaticServiceCache(fetcher=lambda: (_ for _ in ()).throw(OSError('test')),monotonic=lambda:0,clock=lambda:NOW)
        self.assertEqual(failing.get()['status'],'unavailable')
        self.assertEqual(failing.get()['lookup'],{})

    def test_http_rechecks_freshness_after_slow_catalog_download(self):
        now = [NOW + 85]
        fake = server.RenfeCache(fetcher=lambda _: feed(entity('m',40.4,-3.7)),
                                 monotonic=lambda: 1, clock=lambda: now[0])
        def delayed_catalog():
            now[0] += 8
            return catalog_zip()
        static = server.StaticServiceCache(fetcher=delayed_catalog,monotonic=lambda: 1,clock=lambda: now[0])
        httpd = server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        thread = threading.Thread(target=httpd.serve_forever,daemon=True)
        with patch.object(server,'CACHE',fake), patch.object(server,'STATIC_CACHE',static):
            thread.start()
            try:
                with urlopen(f'http://127.0.0.1:{httpd.server_port}/api/trenes?ambito=espana') as response:
                    body = json.load(response)
                self.assertEqual(body['generated_at'], NOW + 93)
                self.assertEqual(body['feeds']['larga_distancia']['status'], 'stale')
                self.assertEqual(body['feeds']['larga_distancia']['vehicles'], [])
                self.assertIsNone(body['feeds']['larga_distancia']['count'])
            finally:
                httpd.shutdown(); thread.join(); httpd.server_close()

    def test_national_http_scope_uses_fixed_urls_and_rejects_unknown_scope(self):
        fake=server.RenfeCache(fetcher=lambda _:feed(entity('m',40.4,-3.7)),monotonic=lambda:1,clock=lambda:NOW)
        static=server.StaticServiceCache(fetcher=catalog_zip,monotonic=lambda:1,clock=lambda:NOW)
        httpd=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        thread=threading.Thread(target=httpd.serve_forever,daemon=True)
        with patch.object(server,'CACHE',fake), patch.object(server,'STATIC_CACHE',static):
            thread.start()
            try:
                base=f'http://127.0.0.1:{httpd.server_port}/api/trenes'
                with urlopen(base+'?ambito=espana&url=https://evil.example') as response:
                    body=json.load(response)
                    self.assertEqual(body['scope'],'espana')
                    self.assertEqual(body['feeds']['larga_distancia']['vehicles'][0]['service_name'],'AVE')
                    self.assertEqual(response.headers['Cache-Control'],'no-store')
                with self.assertRaises(HTTPError) as error: urlopen(base+'?ambito=otro')
                self.assertEqual(error.exception.code,400)
            finally:
                httpd.shutdown(); thread.join(); httpd.server_close()


if __name__=='__main__': unittest.main()
