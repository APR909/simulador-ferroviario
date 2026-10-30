"""GTFS sintético; no contiene ni simula avisos reales."""
from datetime import datetime, timezone
import importlib.util
import io
import json
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
from urllib.request import urlopen
import zipfile

import cancelaciones as c
ROOT=Path(__file__).resolve().parent.parent
spec=importlib.util.spec_from_file_location('via_servidor_canc',ROOT/'servidor.py')
server=importlib.util.module_from_spec(spec);spec.loader.exec_module(server)
NOW=int(datetime(2026,10,30,8,0,tzinfo=timezone.utc).timestamp()) # 09:00 Madrid


def gtfs_zip(include_geometry=True):
    data={
      'routes.txt':'route_id,route_short_name\nr-av,AVE\nr-md,MD\n',
      'trips.txt':'route_id,service_id,trip_id\nr-av,s-one,t-one\nr-av,s-repeat,t-repeat\nr-av,s-repeat,t-explicit\nr-av,s-one,t-nogeo\nr-md,s-one,t-md\n',
      'calendar.txt':('service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n'
                      's-one,1,1,1,1,1,1,1,20261030,20261030\n'
                      's-repeat,1,1,1,1,1,1,1,20261029,20261103\n'),
      'calendar_dates.txt':'service_id,date,exception_type\n',
      'stops.txt':f'stop_id,stop_name,stop_lat,stop_lon\na,Origen A,{"40.4,-3.7" if include_geometry else ","}\nb,Destino B,37.39,-5.99\n',
      'stop_times.txt':'trip_id,arrival_time,departure_time,stop_id,stop_sequence\n'+''.join(
        f'{t},11:00:00,11:00:00,a,1\n{t},13:00:00,13:00:00,b,2\n'
        for t in ('t-one','t-repeat','t-explicit','t-nogeo','t-md')),
    }
    output=io.BytesIO()
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED) as z:
        for name,text in data.items():z.writestr(name,text)
    return output.getvalue()


def entity(trip,relationship='CANCELED',start=None,individual=None):
    descriptor={'tripId':trip,'scheduleRelationship':relationship}
    if start is not None:descriptor['startDate']=start
    update={'trip':descriptor}
    if individual is not None:update['timestamp']=str(individual)
    return {'id':'id-'+trip,'tripUpdate':update}


def feed(*entities,header=NOW):return {'header':{'timestamp':str(header)},'entity':list(entities)}


class ParseTests(unittest.TestCase):
    def test_cancellation_vs_conflicting_relationship_and_missing_id(self):
        data=feed(entity('t-one'),entity('t-one'),entity('t-explicit',start='20261030'),
                  entity('t-repeat'),entity('t-repeat','SCHEDULED'),
                  {'tripUpdate':{'trip':{'scheduleRelationship':'CANCELED'}}})
        parsed=c.parse_cancellations(data)
        self.assertEqual(len(parsed['candidates']),2)
        self.assertEqual(parsed['conflicting'],1);self.assertEqual(parsed['missing_id'],1)
        self.assertEqual(parsed['header_timestamp'],NOW)
        self.assertIsNone(parsed['candidates'][0]['individual_timestamp'])
        with self.assertRaises(ValueError):c.parse_cancellations({'header':{}})
        with self.assertRaises(ValueError):c.parse_cancellations({'header':{'timestamp':NOW},'entity':None})
        with self.assertRaises(ValueError):c.parse_cancellations({'header':{'timestamp':NOW},'entity':['invalid']})
        with self.assertRaises(ValueError):c.parse_cancellations({'header':{'timestamp':NOW,'incrementality':'UNRECOGNIZED'},'entity':[]})
        numeric=feed({'tripUpdate':{'trip':{'tripId':'t-one','scheduleRelationship':3}}})
        self.assertEqual(len(c.parse_cancellations(numeric)['candidates']),1)

    def test_bundled_iana_zone_is_available_without_system_tzdb(self):
        with (ROOT/'data/europe-madrid-tzdb-2026c.tzif').open('rb') as f:
            zone=c.ZoneInfo.from_file(f,key='Europe/Madrid')
        self.assertEqual(datetime(2026,10,30,8,tzinfo=timezone.utc).astimezone(zone).hour,9)

    def test_no_startdate_for_repeating_trip_must_never_be_assigned_to_today(self):
        parsed=c.parse_cancellations(feed(entity('t-one'),entity('t-repeat'),entity('t-explicit',start='20261030'),entity('t-md')))
        records,missing,ambiguous=c.resolve_trips(gtfs_zip(),parsed['candidates'],NOW)
        self.assertEqual({r['trip_id'] for r in records},{'t-one','t-explicit'})
        self.assertEqual(missing,0);self.assertEqual(ambiguous,1)
        self.assertTrue(all(r['service_name']=='AVE' for r in records))
        self.assertTrue(all(r['location']=={'latitude':40.4,'longitude':-3.7} for r in records))
        self.assertTrue(all(r['service_date']=='2026-10-30' for r in records))
        self.assertEqual(records[0]['origin'],'Origen A');self.assertEqual(records[0]['destination'],'Destino B')
        self.assertTrue(all(r['individual_timestamp'] is None for r in records))

    def test_cancelled_trip_without_geo_remains_listed_not_placed(self):
        parsed=c.parse_cancellations(feed(entity('t-nogeo')))
        records,_,_=c.resolve_trips(gtfs_zip(include_geometry=False),parsed['candidates'],NOW)
        self.assertEqual(len(records),1);self.assertIsNone(records[0]['location'])

    def test_explicit_invalid_date_or_nonunique_calendar_not_guessed(self):
        parsed=c.parse_cancellations(feed(entity('t-explicit',start='20261399'),entity('t-repeat')))
        records,_,ambiguous=c.resolve_trips(gtfs_zip(),parsed['candidates'],NOW)
        self.assertEqual(records,[]);self.assertEqual(ambiguous,2)

    def test_old_and_future_source_headers_are_not_current(self):
        for header in (NOW-91,NOW+31):self.assertFalse(c.is_recent(header,NOW))
        for header in (NOW-90,NOW+30):self.assertTrue(c.is_recent(header,NOW))

    def test_calendar_exception_and_dst_are_conservative(self):
        day=datetime(2026,10,25,tzinfo=c.MADRID).date() # autumn change: 02:30 occurs twice
        self.assertIsNone(c._local_instant(day,2*3600+30*60))
        self.assertIsNone(c._local_instant(day,4*3600)) # GTFS noon-minus-12 vs wall time
        self.assertIsNotNone(c._local_instant(datetime(2026,10,26,tzinfo=c.MADRID).date(),4*3600))
        cal={'start':day,'end':day,'weekdays':('1',)*7}
        self.assertFalse(c._service_active(day,cal,{'20261025':'2'}))
        self.assertTrue(c._service_active(day,None,{'20261025':'1'}))

    def test_a_service_that_was_cancelled_yesterday_is_not_moved_to_today(self):
        # t-repeat exists over several days and lacks the GTFS-RT startDate.
        # Even if one and only one of its future departures falls in 24h,
        # assigning the cancellation to it would be an unjustified guess.
        parsed=c.parse_cancellations(feed(entity('t-repeat')))
        records,_,ambiguous=c.resolve_trips(gtfs_zip(),parsed['candidates'],NOW)
        self.assertEqual(records,[]);self.assertEqual(ambiguous,1)


class CacheTests(unittest.TestCase):
    def test_feed_age_and_slow_catalog_are_rechecked(self):
        now=[NOW];mono=[0]
        cache=c.CancellationCache(fetcher=lambda _:feed(entity('t-one',individual=NOW)),
              catalog_provider=lambda:{'status':'available','body':gtfs_zip(),'fetched_at':NOW},
              clock=lambda:now[0],monotonic=lambda:mono[0])
        result=cache.get();self.assertEqual(result['count'],1);self.assertEqual(result['status'],'fresh')
        now[0]=NOW+91
        stale=cache.get();self.assertEqual(stale['status'],'stale');self.assertIsNone(stale['count']);self.assertEqual(stale['records'],[])
        now=[NOW]
        def slow():now[0]+=91;return {'status':'available','body':gtfs_zip(),'fetched_at':NOW}
        stale=c.CancellationCache(fetcher=lambda _:feed(entity('t-one')),catalog_provider=slow,
                                  clock=lambda:now[0],monotonic=lambda:0).get()
        self.assertEqual(stale['status'],'stale');self.assertIsNone(stale['count'])

    def test_old_individual_update_is_excluded_and_missing_time_is_partial(self):
        payload=feed(entity('t-one',individual=NOW-91),entity('t-nogeo'))
        cache=c.CancellationCache(fetcher=lambda _:payload,
              catalog_provider=lambda:{'status':'available','body':gtfs_zip(),'fetched_at':NOW},
              clock=lambda:NOW,monotonic=lambda:0)
        result=cache.get();self.assertEqual(result['status'],'partial')
        self.assertEqual(result['stale_individual_updates'],1);self.assertEqual(result['missing_individual_timestamps'],1)
        self.assertEqual([x['trip_id'] for x in result['records']],['t-nogeo'])

    def test_individual_update_ages_out_even_if_header_is_fresh(self):
        now=[NOW]
        payload=feed(entity('t-one',individual=NOW-70))
        cache=c.CancellationCache(fetcher=lambda _:payload,
              catalog_provider=lambda:{'status':'available','body':gtfs_zip(),'fetched_at':NOW},
              clock=lambda:now[0],monotonic=lambda:0)
        self.assertEqual(cache.get()['count'],1)
        now[0]+=21;result=cache.get()
        self.assertEqual(result['status'],'partial');self.assertEqual(result['count'],0)
        self.assertEqual(result['stale_individual_updates'],1)

    def test_errors_do_not_become_zero_and_sources_are_fixed(self):
        requested=[]
        def fetch(url):requested.append(url);return feed(entity('t-one'))
        cache=c.CancellationCache(fetcher=fetch,catalog_provider=lambda:{'status':'unavailable'},clock=lambda:NOW,monotonic=lambda:0)
        result=cache.get();self.assertEqual(result['status'],'error');self.assertIsNone(result['count'])
        self.assertEqual(requested,[c.TRIP_UPDATES_URL])

    def test_http_endpoint_uses_fixed_source_even_with_url_param(self):
        calls=[]
        def fetch(url):calls.append(url);return feed(entity('t-one'))
        cache=c.CancellationCache(fetcher=fetch,catalog_provider=lambda:{'status':'available','body':gtfs_zip(),'fetched_at':NOW},clock=lambda:NOW,monotonic=lambda:0)
        httpd=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler);thread=threading.Thread(target=httpd.serve_forever,daemon=True)
        with patch.object(server,'CANCELLATIONS_CACHE',cache):
            thread.start()
            try:
                with urlopen(f'http://127.0.0.1:{httpd.server_port}/api/cancelaciones-av?url=https://evil.example/') as response:
                    result=json.load(response);self.assertEqual(result['count'],1)
                    self.assertEqual(response.headers['Cache-Control'],'no-store')
                self.assertEqual(calls,[c.TRIP_UPDATES_URL])
            finally:httpd.shutdown();thread.join();httpd.server_close()


if __name__=='__main__':unittest.main()
