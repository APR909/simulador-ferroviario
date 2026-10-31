import test from 'node:test';
import assert from 'node:assert/strict';
import { indexTimetable, findTimetableJourneys, gtfsServiceStart, madridCalendarDate, formatTimetableTime,
  matchBoardEvent, createBoardSource } from '../src/timetable.js';

function sample() {
  return {schema:1,timezone:'Europe/Madrid',start_date:'2026-10-30',days:4,
    sources:[{id:'av',included_from:'2026-10-30',included_until:'2026-11-02'},
      {id:'cer',included_from:'2026-10-30',included_until:'2026-11-02'}],
    stops:[['51003','Sevilla Santa Justa',37.3924,-5.9748],['51100','San Bernardo',37.3775,-5.9795],['51405','Cádiz',36.529,-6.288]],
    trips:[[0,'01307','Media Distancia','1',[0,23*3600+50*60,23*3600+50*60,1,24*3600+5*60,24*3600+7*60,2,24*3600+50*60,24*3600+50*60]],
      [1,'23502','C1','4',[1,8*3600,8*3600,0,9*3600,9*3600]]],};
}
const when=Date.parse('2026-10-31T00:30:00+01:00');
function trip() {return findTimetableJourneys(indexTimetable(sample()),when)[0];}
function boardRow(journey,stopIndex,kind,overrides={}) {
  const stop=journey.pattern.visits[stopIndex];
  return {trainCode:'01307',stationCode:stop.station.code,originCode:'51003',destinationCode:'51405',trafficType:'AVLDMD',
    plannedTime:journey.serviceStart+(kind==='arrivals'?stop.arrival:stop.departure)*1000,
    timeType:'ESTIMATED',delayMinutes:7,timestamp:when,...overrides};
}

test('conserva horas GTFS superiores a 24 y días de servicio',()=>{
  const list=findTimetableJourneys(indexTimetable(sample()),when);
  assert.equal(list.length,1);assert.equal(list[0].pattern.code,'01307');assert.equal(list[0].serviceDate,'2026-10-30');
  assert.equal(list[0].departure,Date.parse('2026-10-30T23:50:00+01:00'));
  assert.equal(list[0].arrival,Date.parse('2026-10-31T00:50:00+01:00'));
  assert.equal(findTimetableJourneys(indexTimetable(sample()),Date.parse('2026-11-01T00:30:00+01:00')).length,0);
  assert.equal(formatTimetableTime(list[0].arrival),'31/10 · 00:50');
});
test('hora de servicio GTFS en Madrid respeta cambios de hora, medianoche y meses',()=>{
  assert.equal(new Date(gtfsServiceStart('2026-10-25')).toISOString(),'2026-10-24T23:00:00.000Z');
  assert.equal(new Date(gtfsServiceStart('2026-03-29')).toISOString(),'2026-03-28T22:00:00.000Z');
  assert.equal(madridCalendarDate(Date.parse('2026-10-30T23:01:00Z')),'2026-10-31');
  assert.equal(gtfsServiceStart('2026-02-30'),null);
});
test('filtra por tipo, número, estación y sin acentos',()=>{
  const index=indexTimetable(sample());
  assert.equal(findTimetableJourneys(index,when,{query:'cadiz'}).length,1);
  assert.equal(findTimetableJourneys(index,when,{query:'01307',av:false}).length,0);
  assert.equal(findTimetableJourneys(index,when,{query:'Sevilla',commuter:false}).length,1);
  assert.equal(findTimetableJourneys(index,when,{query:'inventado'}).length,0);
});
test('rechaza datos o filas GTFS inválidas, sin reconstruir ni inventar paradas',()=>{
  assert.throws(()=>indexTimetable({...sample(),timezone:'UTC'}),/formato/);
  const broken=sample();broken.trips.push([0,'X','AVE','1',[999,0,0,1,30,30]]);
  broken.trips.push([0,'X','AVE','80',[0,0,0,1,30,30]]);
  broken.trips.push([0,'X','AVE','1',[0,200,200,1,30,30]]);
  const index=indexTimetable(broken);assert.equal(index.discarded,3);assert.equal(index.patterns.length,2);
});
test('hora estimada o real solo con el número, paradas, origen/destino, hora y fecha coincidentes',()=>{
  const journey=trip();
  const dep=boardRow(journey,0,'departures',{timeType:'REAL',delayMinutes:5});
  const arr=boardRow(journey,2,'arrivals',{timeType:'ESTIMATED',delayMinutes:10});
  const board={updatedAt:when,departures:[dep],arrivals:[arr]};
  assert.deepEqual(matchBoardEvent(board,journey,0,'departures',when),
    {kind:'real',time:Date.parse('2026-10-30T23:55:00+01:00'),delayMinutes:5,updatedAt:when});
  assert.deepEqual(matchBoardEvent(board,journey,2,'arrivals',when),
    {kind:'estimada',time:Date.parse('2026-10-31T01:00:00+01:00'),delayMinutes:10,updatedAt:when});
  for(const override of [{trainCode:'99999'},{stationCode:'99999'},{originCode:'9'},{destinationCode:'9'},
    {plannedTime:dep.plannedTime+86400000},{timeType:'SCHEDULED'},{delayMinutes:undefined},
    {circulationState:'CANCELLED'},{trafficType:'CERCANIAS'},{timestamp:when-300000}]) {
    assert.equal(matchBoardEvent({...board,departures:[{...dep,...override}]},journey,0,'departures',when),null,JSON.stringify(override));
  }
  assert.equal(matchBoardEvent({...board,updatedAt:when-180000},journey,0,'departures',when),null);
  assert.equal(matchBoardEvent({...board,departures:[{...dep,originCode:''}]},journey,0,'departures',when),null);
  assert.equal(matchBoardEvent({...board,arrivals:[{...arr,timeType:'REAL'}]},journey,2,'arrivals',when),null);
  assert.equal(matchBoardEvent({...board,departures:[dep,{...dep,delayMinutes:10}]},journey,0,'departures',when),null);
});
test('consulta de tablones tiene caché y URL segura sin credenciales',async()=>{
  let clock=when,calls=0;
  const source=createBoardSource({clock:()=>clock,fetchImpl:async(url,options)=>{
    calls++;assert.equal(url,'https://radardetrenes.com/api/v1/stations/51003/board-renfe');assert.equal(options.credentials,'omit');
    return {ok:true,headers:new Headers(),text:async()=>JSON.stringify({updatedAt:clock,arrivals:[],departures:[]})};
  }});
  await Promise.all([source.get('51003'),source.get('51003')]);assert.equal(calls,1);
  clock+=29000;await source.get('51003');assert.equal(calls,1);
  clock+=2000;await source.get('51003');assert.equal(calls,2);
  await assert.rejects(source.get('../x'),/no válido/);
});
