import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/simulation.js';

function check(sim) {
  for (const block of sim.blocks) {
    assert.ok(block.occupiedBy.length <= 1, `bloque ${block.index} compartido`);
    for (const id of block.occupiedBy) assert.equal(block.owner, id);
  }
  for (const train of sim.trains) {
    assert.ok(train.head <= sim.routeLength - sim.clearance + 1e-5);
    assert.ok(train.speed >= 0);
    assert.ok(train.head <= train.authorityEnd - sim.clearance + 1e-5);
  }
  assert.ok(sim.trains[1].head < sim.trains[0].head - sim.trains[0].length, 'los trenes no deben solaparse');
}

test('dos trenes conservan la exclusión por bloques durante una marcha completa', () => {
  const sim = new Simulation(1218, { continuous: false });
  for (let i=0; i<6000; i++) { sim.step(0.1); check(sim); }
  assert.equal(sim.interventions, 0);
  assert.equal(sim.status(sim.trains[0]), 'Fin de recorrido');
  assert.equal(sim.status(sim.trains[1]), 'Esperando autorización');
});

test('un tren detenido retiene los bloques ocupados y el seguidor frena antes del bloqueo', () => {
  const sim = new Simulation(1218, { continuous: false });
  const [leader, follower] = sim.trains;
  sim.setIncident('101', true);
  const initialLeader = leader.head;
  for (let i=0; i<2500; i++) { sim.step(0.1); check(sim); }
  assert.equal(leader.head, initialLeader);
  assert.equal(sim.status(leader), 'Detenido por incidencia');
  assert.equal(sim.status(follower), 'Esperando autorización');
  assert.equal(sim.interventions, 0);
  const before = follower.head;
  sim.setIncident('101', false);
  for (let i=0; i<1000; i++) { sim.step(0.1); check(sim); }
  assert.ok(follower.head > before + 50, 'el seguidor se reanuda tras liberarse la vía');
});

test('no se libera un bloque hasta que la cola abandona el bloque', () => {
  const sim = new Simulation(1218, { continuous: false });
  const leader = sim.trains[0];
  const startBlock = sim.blocks.find(b => b.start <= leader.head - leader.length && leader.head - leader.length < b.end);
  assert.equal(startBlock.owner, leader.id);
  while (leader.head - leader.length < startBlock.end - 0.1) {
    sim.step(0.1);
    assert.equal(startBlock.owner, leader.id);
  }
  for (let i=0; i<20; i++) sim.step(0.1);
  assert.notEqual(startBlock.owner, leader.id);
});

test('valida pasos y longitud mínima', () => {
  assert.throws(() => new Simulation(400), /600 m/);
  const sim = new Simulation(600, { continuous: false });
  assert.throws(() => sim.step(1), /Paso/);
  for (let i=0; i<4000; i++) { sim.step(0.1); check(sim); }
  assert.equal(sim.interventions, 0);
});

test('detiene la simulación si un tren ocupa un bloque sin reserva', () => {
  const sim = new Simulation(1218, { continuous: false });
  const occupied = sim.blocks.find(b => b.occupiedBy.includes('101'));
  occupied.owner = null;
  assert.throws(() => sim.step(0.1), /sin reserva/);
});

test('conserva invariantes con diferentes longitudes, pasos e incidencias', () => {
  for (let length = 600; length <= 2000; length += 175) {
    for (const dt of [0.03, 0.1, 0.5]) {
      const sim = new Simulation(length, { continuous: false });
      for (let i = 0; i < 1600; i++) {
        if (i === 200) sim.setIncident('101', true);
        if (i === 700) sim.setIncident('101', false);
        sim.step(dt); check(sim);
      }
      assert.equal(sim.interventions, 0, `intervención numérica con ${length} m y dt=${dt}`);
    }
  }
});
