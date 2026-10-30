"""Synthetic fixtures only; tests never present invented vehicles as live data."""
import importlib.util
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('via_servidor', ROOT / 'servidor.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
NOW = 1_793_316_000


def vehicle(entity_id='a', vehicle_id='1', lat=37.39, lon=-5.98, t=NOW, **extra):
    vp = {'position': {'latitude': lat, 'longitude': lon}, 'vehicle': {'id': vehicle_id, 'label': f'Fixture {vehicle_id}'}, **extra}
    if t is not None:
        vp['timestamp'] = str(t)
    return {'id': entity_id, 'vehicle': vp}


def feed(*entities, header=NOW):
    return {'header': {'gtfsRealtimeVersion': '2.0', 'timestamp': str(header)}, 'entity': list(entities)}


def cached(payload, error=None):
    c = {'label': 'Fixture', 'dataset': 'https://example.test', 'fetched_at': NOW}
    if error:
        c['error'] = error
    else:
        c['parsed'] = server.parse_feed(payload)
    return c


class ParseFeedTests(unittest.TestCase):
    def test_empty_feed_is_a_true_zero_not_unavailable(self):
        snapshot = server.feed_snapshot(cached(feed()), NOW)
        self.assertEqual(snapshot['status'], 'fresh')
        self.assertEqual(snapshot['count'], 0)
        self.assertEqual(snapshot['vehicles'], [])
        # GTFS repeated fields may be omitted when empty.
        self.assertEqual(server.feed_snapshot(cached({'header': {'timestamp': str(NOW)}}), NOW)['count'], 0)

    def test_missing_header_or_invalid_entity_list_is_an_error(self):
        for data in ({}, {'header': {}}, {'header': {'timestamp': 'x'}}, {'header': {'timestamp': '1e100'}}, {'header': {'timestamp': str(NOW)}, 'entity': None}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                server.parse_feed(data)

    def test_bbox_missing_positions_invalid_numbers_and_boundaries(self):
        entities = [vehicle('inside','1'), vehicle('outside','2', lon=-6.281),
                    vehicle('boundary','3', lat=37.14, lon=-5.68),
                    vehicle('invalid','4', lat=float('nan')), vehicle('missing','5', lat=None),
                    {'id': 'no-position', 'vehicle': {'vehicle': {'id': '6'}}},
                    {'vehicle': {'position': {'latitude':37.39,'longitude':-5.98}}}]
        result = server.feed_snapshot(cached(feed(*entities)), NOW)
        self.assertEqual(result['count'], 2)
        self.assertEqual({v['id'] for v in result['vehicles']}, {'1', '3'})

    def test_deduplicates_before_bbox_filter_using_latest_measurement(self):
        result = server.feed_snapshot(cached(feed(vehicle('old','same', t=NOW-5),
                                                  vehicle('new','same', lat=38, t=NOW),
                                                  vehicle('another','2', t=NOW))), NOW)
        self.assertEqual([v['id'] for v in result['vehicles']], ['2'])

    def test_stale_individual_position_excluded_and_missing_time_is_marked(self):
        data = feed(vehicle('old','1', t=NOW-91), vehicle('no-time','2', t=None), vehicle('fresh','3', t=NOW-10))
        result = server.feed_snapshot(cached(data), NOW)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['count'], 2)
        self.assertEqual(result['excluded_stale'], 1)
        self.assertEqual(result['feed_time_fallback'], 1)
        by_id = {v['id']:v for v in result['vehicles']}
        self.assertEqual(by_id['2']['time_basis'], 'feed')
        self.assertEqual(by_id['3']['time_basis'], 'vehicle')

    def test_invalid_explicit_timestamp_is_not_promoted(self):
        invalid = vehicle('bad','1'); invalid['vehicle']['timestamp'] = 'bad'
        result = server.feed_snapshot(cached(feed(invalid)), NOW)
        self.assertEqual(result['count'], 0)

    def test_stale_or_future_header_never_shown_as_live(self):
        for stamp in (NOW-91, NOW+31):
            result = server.feed_snapshot(cached(feed(vehicle(t=NOW), header=stamp)), NOW)
            self.assertEqual(result['status'], 'stale')
            self.assertIsNone(result['count'])
            self.assertEqual(result['vehicles'], [])
        for stamp in (NOW-90, NOW+30):
            self.assertEqual(server.feed_snapshot(cached(feed(header=stamp)), NOW)['status'], 'fresh')

    def test_failures_are_not_zero(self):
        result = server.feed_snapshot(cached(None, error='fallo'), NOW)
        self.assertEqual(result['status'], 'error')
        self.assertIsNone(result['count'])
        self.assertEqual(result['vehicles'], [])

    def test_bundled_data_uses_same_documented_bbox(self):
        bundled = json.loads((ROOT / 'data/sevilla-osm.json').read_text())
        self.assertEqual(bundled['bbox'], server.BBOX)


class CacheTests(unittest.TestCase):
    def test_shared_30_second_ttl_partial_failure_and_expiry(self):
        clock = [100.0]
        now = [NOW]
        calls = []
        def fetch(url):
            calls.append(url)
            if url.endswith('vehicle_positions_LD.json'):
                raise OSError('synthetic network error')
            return feed(vehicle(t=NOW))
        cache = server.RenfeCache(fetcher=fetch, monotonic=lambda: clock[0], clock=lambda: now[0])
        first = cache.get()
        self.assertEqual(first['feeds']['cercanias']['count'], 1)
        self.assertEqual(first['feeds']['larga_distancia']['status'], 'error')
        self.assertEqual(len(calls), 2)
        clock[0] += 29.9; now[0] += 29
        cache.get()
        self.assertEqual(len(calls), 2)
        clock[0] += 0.1; now[0] += 1
        cache.get()
        self.assertEqual(len(calls), 4)
        # A cached header still ages; successful HTTP does not make old data fresh.
        now[0] = NOW+91
        self.assertEqual(cache.get()['feeds']['cercanias']['status'], 'stale')

    def test_new_observed_positions_replace_cached_coordinates_after_ttl(self):
        clock, now, latitude = [0.0], [NOW], [37.39]
        def fetch(url):
            if url.endswith('vehicle_positions_LD.json'):
                return feed(header=now[0])
            return feed(vehicle('a', '1', lat=latitude[0], t=now[0]), header=now[0])
        cache = server.RenfeCache(fetcher=fetch, monotonic=lambda: clock[0], clock=lambda: now[0])
        self.assertEqual(cache.get()['feeds']['cercanias']['vehicles'][0]['latitude'], 37.39)
        latitude[0] = 37.40
        clock[0] = 29; now[0] += 29
        self.assertEqual(cache.get()['feeds']['cercanias']['vehicles'][0]['latitude'], 37.39)
        clock[0] = 30; now[0] += 1
        self.assertEqual(cache.get()['feeds']['cercanias']['vehicles'][0]['latitude'], 37.40)

    def test_unexpected_failure_of_one_feed_does_not_hide_the_other(self):
        def fetch(url):
            if url.endswith('vehicle_positions_LD.json'):
                raise RuntimeError('synthetic decoder failure')
            return feed(vehicle())
        cache = server.RenfeCache(fetcher=fetch, monotonic=lambda: 1, clock=lambda: NOW)
        result = cache.get()['feeds']
        self.assertEqual(result['cercanias']['count'], 1)
        self.assertIsNone(result['larga_distancia']['count'])
        self.assertEqual(result['larga_distancia']['status'], 'error')

    def test_concurrent_requests_coalesce_refreshes(self):
        calls = []
        lock = threading.Lock()
        def fetch(url):
            with lock:
                calls.append(url)
            return feed()
        cache = server.RenfeCache(fetcher=fetch, monotonic=lambda: 10, clock=lambda: NOW)
        results = []
        threads = [threading.Thread(target=lambda: results.append(cache.get())) for _ in range(10)]
        for thread in threads: thread.start()
        for thread in threads: thread.join()
        self.assertEqual(len(results), 10)
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(r['feeds']['cercanias']['count'] == 0 for r in results))

    def test_http_api_serves_json_without_client_supplied_url(self):
        fake = server.RenfeCache(fetcher=lambda _: feed(), monotonic=lambda: 1, clock=lambda: NOW)
        httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        with patch.object(server, 'CACHE', fake):
            thread.start()
            try:
                with urlopen(f'http://127.0.0.1:{httpd.server_port}/api/trenes?url=https://evil.example/') as response:
                    body = json.load(response)
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers['Cache-Control'], 'no-store')
                    self.assertEqual(body['feeds']['cercanias']['count'], 0)
                    self.assertEqual(body['bbox'], server.BBOX)
            finally:
                httpd.shutdown(); thread.join(); httpd.server_close()


if __name__ == '__main__':
    unittest.main()
