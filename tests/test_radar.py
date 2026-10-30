"""Pruebas con datos sintéticos: no son posiciones reales."""
from datetime import datetime,timezone
from types import SimpleNamespace
import threading
import unittest
from unittest.mock import patch
from urllib.request import urlopen
import json
import servidor as server
import radar
NOW=1793395000
BOX=[{'south':35,'north':44.4,'west':-9.8,'east':4.6}]

def iso(t): return datetime.fromtimestamp(t,timezone.utc).isoformat().replace('+00:00','Z')
def item(id='ld-1',lat=40.4,lon=-3.7,t=NOW,product='Alta Velocidad',category='AV'):
 return {'id':id,'trainCode':id.split('-')[-1],'type':'long_distance','latitude':lat,'longitude':lon,
         'timestamp':iso(t),'productName':product,'productCategory':category,'originName':'Madrid','destinationName':'Sevilla'}
def feed(*rows,when=NOW):return {'trains':list(rows),'count':len(rows),'updatedAt':iso(when)}

class RadarParsingTests(unittest.TestCase):
 def test_iso_requires_timezone_and_supports_nanoseconds(self):
  self.assertEqual(radar.iso_timestamp('2026-10-30T21:25:39.791156037Z'),1793395539.791156)
  self.assertIsNone(radar.iso_timestamp('2026-10-30T22:25:39'))
  self.assertIsNone(radar.iso_timestamp('2026-15-30T21:25:39Z'))
 def test_validates_snapshot_and_individual_position_time(self):
  with self.assertRaises(ValueError):radar.parse_radar({'updatedAt':iso(NOW),'count':1,'trains':[]})
  with self.assertRaises(ValueError):radar.parse_radar({'updatedAt':'today','count':0,'trains':[]})
  values=feed(item(),{**item('ld-2'),'timestamp':None},{**item('ld-3'),'latitude':float('nan')})
  parsed=radar.parse_radar(values)
  self.assertEqual(len(parsed['all_vehicles']),1);self.assertEqual(parsed['invalid'],2)
  self.assertEqual(parsed['all_vehicles'][0]['service_name'],'Alta Velocidad')
  self.assertEqual(parsed['all_vehicles'][0]['time_basis'],'vehicle')
 def test_duplicate_positions_same_time_are_not_invented(self):
  parsed=radar.parse_radar(feed(item('ld-1',40.4,-3.7),item('ld-1',40.5,-3.8),item('ld-2')))
  self.assertEqual(len(parsed['all_vehicles']),1);self.assertEqual(len(parsed['ambiguous_vehicles']),1)
  parsed=radar.parse_radar(feed(item('ld-1',t=NOW-2),item('ld-1',lat=40.41,t=NOW)))
  self.assertEqual(parsed['all_vehicles'][0]['latitude'],40.41)
 def test_conflicting_product_is_not_falsely_classified(self):
  parsed=radar.parse_radar(feed(item(),item(product='Media Distancia',category='MD')))
  self.assertIsNone(parsed['all_vehicles'][0]['service_name'])

class RadarCacheTests(unittest.TestCase):
 def test_scope_freshness_partial_and_source(self):
  now=[NOW];calls=[]
  cache=radar.RadarCache(fetcher=lambda: calls.append(1) or feed(item(),item('ld-old',t=NOW-91),item('ld-far',lat=1)),
                         clock=lambda:now[0],monotonic=lambda:0)
  result=cache.get(BOX)
  self.assertEqual(result['status'],'partial');self.assertEqual(result['count'],1)
  self.assertEqual(result['excluded_stale'],1);self.assertEqual(result['source_provider'],'radar')
  self.assertIn('RadarDeTrenes',result['attribution']);self.assertEqual(len(calls),1)
  now[0]=NOW+91;result=cache.get(BOX)
  self.assertEqual(result['status'],'stale');self.assertIsNone(result['count']);self.assertEqual(result['vehicles'],[])
 def test_errors_and_future_header_are_not_zero(self):
  bad=radar.RadarCache(fetcher=lambda:feed(item(),when=NOW+31),clock=lambda:NOW,monotonic=lambda:0).get(BOX)
  self.assertEqual(bad['status'],'stale');self.assertIsNone(bad['count'])
  failure=radar.RadarCache(fetcher=lambda: (_ for _ in ()).throw(OSError('offline')),clock=lambda:NOW,monotonic=lambda:0).get(BOX)
  self.assertEqual(failure['status'],'error');self.assertIsNone(failure['count'])
 def test_concurrent_requests_share_fixed_source(self):
  calls=[]
  cache=radar.RadarCache(fetcher=lambda:calls.append(1) or feed(item()),clock=lambda:NOW,monotonic=lambda:0)
  threads=[threading.Thread(target=lambda:cache.get(BOX)) for _ in range(8)]
  for t in threads:t.start()
  for t in threads:t.join()
  self.assertEqual(len(calls),1)

class RadarHttpTests(unittest.TestCase):
 def serve_once(self,cache,alternate,scope='espana'):
  http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
  thread=threading.Thread(target=http.serve_forever,daemon=True)
  with patch.object(server,'CACHE',cache),patch.object(server,'RADAR_CACHE',alternate):
   thread.start()
   try:
    with urlopen(f'http://127.0.0.1:{http.server_port}/api/trenes?ambito={scope}&url=https://evil.example/') as response:
     return json.load(response)
   finally:http.shutdown();thread.join();http.server_close()
 def test_fallback_used_only_when_direct_feed_is_stale(self):
  def fetch(url):
   header=NOW-3600 if url==server.FEEDS['larga_distancia']['url'] else NOW
   return {'header':{'timestamp':header},'entity':[]}
  direct=server.RenfeCache(fetcher=fetch,clock=lambda:NOW,monotonic=lambda:0)
  alt=radar.RadarCache(fetcher=lambda:feed(item()),clock=lambda:NOW,monotonic=lambda:0)
  result=self.serve_once(direct,alt)
  long=result['feeds']['larga_distancia']
  self.assertEqual(long['source_provider'],'radar');self.assertEqual(long['direct_status'],'stale')
  self.assertEqual(long['count'],1);self.assertEqual(long['vehicles'][0]['label'],'1')
  self.assertEqual(result['service_catalog']['status'],'radar_product')
 def test_cannot_promote_expired_fallback_after_slow_fetch(self):
  now=[NOW]
  def direct_fetch(url):
   header=NOW-3600 if url==server.FEEDS['larga_distancia']['url'] else NOW
   return {'header':{'timestamp':header},'entity':[]}
  def slow(): now[0]+=91;return feed(item())
  direct=server.RenfeCache(fetcher=direct_fetch,clock=lambda:now[0],monotonic=lambda:0)
  alternate=radar.RadarCache(fetcher=slow,clock=lambda:now[0],monotonic=lambda:0)
  result=self.serve_once(direct,alternate)
  self.assertEqual(result['feeds']['cercanias']['status'],'stale')
  self.assertEqual(result['feeds']['larga_distancia']['status'],'stale')
  self.assertEqual(result['feeds']['larga_distancia']['alternate_status'],'stale')
  self.assertIsNone(result['feeds']['larga_distancia']['count'])
 def test_direct_feed_takes_precedence_without_network_fallback(self):
  direct=server.RenfeCache(fetcher=lambda _: {'header':{'timestamp':NOW},'entity':[]},clock=lambda:NOW,monotonic=lambda:0)
  calls=[];alternate=radar.RadarCache(fetcher=lambda:calls.append(1) or feed(item()),clock=lambda:NOW,monotonic=lambda:0)
  result=self.serve_once(direct,alternate,scope='sevilla')
  self.assertEqual(result['feeds']['larga_distancia']['status'],'fresh');self.assertEqual(calls,[])

 def test_fallback_when_all_direct_positions_are_expired(self):
  old={'id':'old','vehicle':{'position':{'latitude':40.4,'longitude':-3.7},
       'vehicle':{'id':'old'},'timestamp':NOW-91}}
  direct=server.RenfeCache(fetcher=lambda _: {'header':{'timestamp':NOW},'entity':[old]},clock=lambda:NOW,monotonic=lambda:0)
  alternate=radar.RadarCache(fetcher=lambda:feed(item()),clock=lambda:NOW,monotonic=lambda:0)
  result=self.serve_once(direct,alternate)
  self.assertEqual(result['feeds']['larga_distancia']['source_provider'],'radar')
  self.assertEqual(result['feeds']['larga_distancia']['direct_status'],'partial')
  self.assertEqual(result['feeds']['larga_distancia']['count'],1)

 def test_direct_partial_with_valid_positions_is_not_mixed(self):
  def entity(identifier,when):return {'id':identifier,'vehicle':{
   'position':{'latitude':40.4,'longitude':-3.7},'vehicle':{'id':identifier},
   'timestamp':when,'trip':{'tripId':'trip'}}}
  direct=server.RenfeCache(fetcher=lambda _: {'header':{'timestamp':NOW},'entity':[entity('fresh',NOW),entity('old',NOW-91)]},clock=lambda:NOW,monotonic=lambda:0)
  calls=[];alternate=radar.RadarCache(fetcher=lambda:calls.append(1) or feed(item()),clock=lambda:NOW,monotonic=lambda:0)
  catalog=SimpleNamespace(get=lambda:{'status':'available','lookup':{'trip':'AVE'},'fetched_at':NOW})
  with patch.object(server,'STATIC_CACHE',catalog):result=self.serve_once(direct,alternate)
  data=result['feeds']['larga_distancia']
  self.assertEqual(calls,[]);self.assertEqual(data['status'],'partial')
  self.assertEqual([v['id'] for v in data['vehicles']],['fresh']);self.assertEqual(data['vehicles'][0]['service_name'],'AVE')

 def test_direct_ave_label_is_identified_in_sevilla_too(self):
  row={'id':'sev','vehicle':{'position':{'latitude':37.39,'longitude':-5.98},
       'vehicle':{'id':'sev'},'timestamp':NOW,'trip':{'tripId':'trip'}}}
  direct=server.RenfeCache(fetcher=lambda _: {'header':{'timestamp':NOW},'entity':[row]},clock=lambda:NOW,monotonic=lambda:0)
  alternate=radar.RadarCache(fetcher=lambda:feed(item()),clock=lambda:NOW,monotonic=lambda:0)
  catalog=SimpleNamespace(get=lambda:{'status':'available','lookup':{'trip':'AVE'},'fetched_at':NOW})
  with patch.object(server,'STATIC_CACHE',catalog):result=self.serve_once(direct,alternate,scope='sevilla')
  self.assertEqual(result['feeds']['larga_distancia']['vehicles'][0]['service_name'],'AVE')
  self.assertEqual(result['service_catalog']['matched'],1)

if __name__=='__main__':unittest.main()
