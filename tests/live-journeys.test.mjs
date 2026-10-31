import test from 'node:test';
import assert from 'node:assert/strict';
import { indexTimetable } from '../src/timetable.js';
import { matchLiveJourneys } from '../src/live-journeys.js';

const sample={schema:1,timezone:'Europe/Madrid',start_date:'2026-10-30',days:4,
  sources:[{id:'av',included_from:'2026-10-30',included_until:'2026-11-02'},
    {id:'cer',included_from:'2026-10-30',included_until:'2026-11-02'}],
  stops:[['51003','Sevilla Santa Justa',37.3924,-5.9748],['51100','San Bernardo',37.3775,-5.9795],['51405','Cádiz',36.529,-6.288]],
  trips:[[0,'01307','Media Distancia','1',[0,23*3600+50*60,23*3600+50*60,1,24*3600+5*60,24*3600+7*60,2,24*3600+50*60,24*3600+50*60]]]};
const now=Date.parse('2026-10-31T00:30:00+01:00');
const car={id:'radar:ld-01307',label:'01307',type:'long_distance',source:'larga_distancia',origin_code:'51003',destination_code:'51405'};

test('cruza tren, tipo y extremos inequívocos con el día GTFS correcto',()=>{
  const results=matchLiveJourneys(indexTimetable(sample),[car],now);
  const result=results.get(car.id);
  assert.equal(results.size,1);assert.equal(result.serviceDate,'2026-10-30');
  assert.equal(result.pattern.visits.length,3);
  assert.equal(result.departure,Date.parse('2026-10-30T23:50:00+01:00'));
});
test('no enlaza por número solo, endpoints desconocidos ni tipo equivocado',()=>{
  for(const change of [{origin_code:'99999'},{destination_code:''},{label:'99999'},
    {type:'commuter',source:'cercanias'},{route_ambiguous:true}]) {
    assert.equal(matchLiveJourneys(indexTimetable(sample),[{...car,...change}],now).size,0);
  }
});
test('acepta un retraso después de la llegada programada sin inventar la hora real',()=>{
  const late=Date.parse('2026-10-31T03:00:00+01:00');
  assert.equal(matchLiveJourneys(indexTimetable(sample),[car],late).size,1);
  const tooLate=Date.parse('2026-10-31T07:00:01+01:00');
  assert.equal(matchLiveJourneys(indexTimetable(sample),[car],tooLate).size,0);
});
test('ninguna coincidencia cuando hay más de un viaje viable para la misma identidad',()=>{
  const extra=[...sample.trips[0]];extra[4]=[0,23*3600+40*60,23*3600+40*60,1,24*3600,24*3600+2*60,2,24*3600+55*60,24*3600+55*60];
  assert.equal(matchLiveJourneys(indexTimetable({...sample,trips:[...sample.trips,extra]}),[car],now).size,0);
});
