import importlib.util
import tempfile
import unittest
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('generar_itinerarios_renfe', ROOT / 'scripts/generar_itinerarios_renfe.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class TestGenerarItinerarios(unittest.TestCase):
    def feed(self, path, *, unsorted=False):
        rows = {
            'calendar.txt': 'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nA,1,1,1,1,1,1,1,20261030,20261101\n',
            'calendar_dates.txt': 'service_id,date,exception_type\nA,20261031,2\nB,20261031,1\n',
            'routes.txt': 'route_id,route_short_name\nr,MD\n',
            'stops.txt': 'stop_id,stop_name,stop_lat,stop_lon\n51003,Sevilla,37.39,-5.97\n51405,Cádiz,36.52,-6.28\n',
            'trips.txt': 'route_id,service_id,trip_id,trip_short_name,block_id\nr,A,t1,01307,A01307\nr,B,t2,01307,B01307\n',
            'stop_times.txt': ('trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'
                't1,23:50:00,23:50:00,51003,1\n'
                't1,25:05:00,25:05:00,51405,2\n'
                't2,23:50:00,23:50:00,51003,1\n'
                't2,25:05:00,25:05:00,51405,2\n')
        }
        if unsorted:
            rows['stop_times.txt'] += 't1,26:00:00,26:00:00,51405,3\n'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, value in rows.items():
                archive.writestr(name, value)

    def test_calendar_exceptions_midnight_and_deduplicated_patterns(self):
        with tempfile.TemporaryDirectory() as td:
            av, cer = Path(td) / 'av.zip', Path(td) / 'cer.zip'
            self.feed(av); self.feed(cer)
            result = mod.generate({'av':(av,'orig-av'), 'cer':(cer,'orig-cer')}, date(2026,10,30), 3, '2026-10-30T09:00:00Z')
        self.assertEqual(result['schema'], 1)
        self.assertEqual(result['sources'][0]['last_modified'], 'orig-av')
        self.assertEqual(len(result['trips']), 2)  # one equivalent pattern per feed
        for feed, code, route, mask, stops in result['trips']:
            self.assertEqual(code, '01307')
            self.assertEqual(mask, '7')  # A Fri/Sun + added B Saturday
            self.assertEqual(stops[-2:], [25*3600+5*60, 25*3600+5*60])
        self.assertEqual(result['sources'][0]['included_until'], '2026-11-01')

    def test_out_of_order_trip_groups_fail_instead_of_silently_fabricating_route(self):
        with tempfile.TemporaryDirectory() as td:
            av, cer = Path(td) / 'av.zip', Path(td) / 'cer.zip'
            self.feed(av, unsorted=True); self.feed(cer)
            with self.assertRaisesRegex(ValueError, 'no está agrupado'):
                mod.generate({'av':(av,''), 'cer':(cer,'')}, date(2026,10,30), 3)

    def test_retains_only_missing_past_service_days_from_prior_timetable(self):
        with tempfile.TemporaryDirectory() as td:
            av, cer = Path(td) / 'av.zip', Path(td) / 'cer.zip'
            self.feed(av); self.feed(cer)
            previous = mod.generate({'av':(av,''), 'cer':(cer,'')}, date(2026,10,30), 3, '2026-10-30T09:00:00Z')
            current = mod.generate({'av':(av,''), 'cer':(cer,'')}, date(2026,10,30), 3, '2026-11-01T09:00:00Z')
        for trip in current['trips']:
            trip[3] = '6'  # new schedule covers Saturday and Sunday, not Friday
            trip[4][1] += 60  # new pattern differs from the prior one
            trip[4][2] += 60
        for source in current['sources']:
            source['included_from'] = '2026-10-31'
            source['included_dates'] = ['2026-10-31','2026-11-01']
        merged = mod.merge_previous_snapshot(current, previous, date(2026,11,1))
        self.assertEqual(len(merged['trips']), 4)
        for source in merged['sources']:
            self.assertEqual(source['included_from'], '2026-10-30')
            self.assertEqual(source['included_dates'], ['2026-10-30','2026-10-31','2026-11-01'])
            self.assertEqual(source['archived_dates'], [{'date':'2026-10-30','captured_at':'2026-10-30T09:00:00Z'}])
        # The newer snapshot wins on Saturday, and no stale future day is merged.
        for feed in (0, 1):
            self.assertEqual(sorted(int(row[3],16) for row in merged['trips'] if row[0] == feed), [1,6])

    def test_invalid_time_and_date(self):
        self.assertEqual(mod.parse_gtfs_time('25:05:00'), 90300)
        self.assertIsNone(mod.parse_gtfs_time('25:61:00'))
        self.assertIsNone(mod.parse_gtfs_time('72:00:00'))
        self.assertIsNone(mod.parse_gtfs_date('20260230'))


if __name__ == '__main__':
    unittest.main()
