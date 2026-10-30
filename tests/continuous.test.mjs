import test from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../src/simulation.js';

function checkContinuous(sim) {
  for (const block of sim.blocks) {
    assert.ok(block.occupiedBy.length <= 1, `bloque ${block.index} compartido`);
    for (const id of block.occupiedBy) assert.equal(block.owner, id);
    if (block.owner !== null) {
      const owner = sim.trains.find(train => train.id === block.owner);
      assert.equal(owner?.phase, 'active', 'un tren fuera de la zona no puede reservar bloques');
    }
  }
  const onRoute = sim.trains.filter(train => train.phase === 'active').sort((a, b) => b.head - a.head);
  for (const train of sim.trains) {
    assert.ok(train.speed >= 0 && train.speed <= train.maxSpeed + 1e-7);
    if (train.phase === 'active') {
      assert.ok(train.head <= sim.routeLength + train.length + 1e-5, 'la cabeza no supera la salida virtual');
      assert.ok(train.head <= train.stopLimit + 1e-5, 'la cabeza no supera la autorización');
      for (const block of sim.blocks) {
        const underTrain = train.head > block.start + 1e-7 && Math.max(0, train.head - train.length) < block.end - 1e-7;
        if (underTrain) {
          assert.equal(block.owner, train.id);
          assert.ok(block.occupiedBy.includes(train.id));
        }
      }
    } else {
      assert.equal(train.phase, 'off-route');
      assert.equal(train.speed, 0);
      assert.ok(sim.blocks.every(block => block.owner !== train.id));
    }
  }
  for (let i = 1; i < onRoute.length; i++) {
    assert.ok(onRoute[i].head <= onRoute[i-1].head - onRoute[i-1].length + 1e-5, 'los trenes no deben solaparse');
  }
}

test('circulación continua: ambos trenes completan varias pasadas sin bloquearse', () => {
  for (const length of [600, 952.1434774681063, 1218, 2000]) {
    for (const dt of [0.03, 0.1, 0.5]) {
      const sim = new Simulation(length, { turnaroundSeconds: 5 });
      const steps = Math.ceil(1100 / dt);
      let sawReentry = false;
      const trips = new Map(sim.trains.map(train => [train.id, 0]));
      for (let i = 0; i < steps; i++) {
        sim.step(dt); checkContinuous(sim);
        for (const train of sim.trains) {
          if (train.completedTrips > 0 && train.phase === 'active' && train.head < sim.routeLength * .35) sawReentry = true;
          trips.set(train.id, train.completedTrips);
        }
      }
      assert.ok(sawReentry, `${length} m, paso ${dt}: sin reingreso`);
      assert.ok(sim.trains.every(train => train.completedTrips >= 2), `${length} m, paso ${dt}: ${JSON.stringify([...trips])}`);
      assert.equal(sim.interventions, 0, `intervención numérica ${length} m, paso ${dt}`);
    }
  }
});

test('al salir conserva el último bloque hasta que pasa toda la cola', () => {
  const sim = new Simulation(952.1434774681063, { turnaroundSeconds: 30 });
  const train = sim.trains[0], last = sim.blocks.at(-1);
  let steps = 0;
  while (train.head < sim.routeLength && steps++ < 6000) sim.step(0.1);
  assert.ok(train.head >= sim.routeLength);
  while (train.phase === 'active' && steps++ < 8000) {
    if (train.head - train.length < sim.routeLength - 1e-7) {
      assert.equal(last.owner, train.id);
      assert.ok(last.occupiedBy.includes(train.id));
    }
    sim.step(0.1); checkContinuous(sim);
  }
  assert.equal(train.phase, 'off-route');
  assert.equal(train.completedTrips, 1);
  assert.notEqual(last.owner, train.id);
});

test('un tren que espera fuera no entra si la vía de entrada está ocupada', () => {
  const sim = new Simulation(952, { turnaroundSeconds: 0 });
  const [waiting, occupying] = sim.trains;
  // The following fixture represents the leader already clear of the section;
  // the other train still occupies the first block in the initial state.
  for (const block of sim.blocks) if (block.owner === waiting.id) { block.owner = null; block.occupiedBy = []; }
  waiting.phase = 'off-route'; waiting.head = sim.routeLength + waiting.length; waiting.readyAt = 0; waiting.speed = 0;
  assert.ok(sim.blocks[0].occupiedBy.includes(occupying.id));
  assert.equal(sim.admitReadyTrains(), false);
  assert.equal(waiting.phase, 'off-route');
  assert.equal(sim.blocks[0].owner, occupying.id);
});

test('una incidencia retiene al tren y al resolverse ambos vuelven a circular', () => {
  const sim = new Simulation(952, { turnaroundSeconds: 1 });
  const [train, follower] = sim.trains;
  const initial = train.head;
  sim.setIncident(train.id, true);
  for (let i = 0; i < 3000; i++) { sim.step(.1); checkContinuous(sim); }
  assert.equal(train.head, initial);
  assert.equal(train.completedTrips, 0);
  assert.equal(sim.status(follower), 'Esperando autorización');
  sim.setIncident(train.id, false);
  for (let i = 0; i < 7000; i++) { sim.step(.1); checkContinuous(sim); }
  assert.ok(train.completedTrips >= 2 && follower.completedTrips >= 2);
});

test('un tren con incidencia fuera de zona no se reintroduce hasta resolverla', () => {
  const sim = new Simulation(952, { turnaroundSeconds: 0 });
  const train = sim.trains[0];
  let steps = 0;
  while (train.phase === 'active' && steps++ < 8000) sim.step(.1);
  assert.equal(train.phase, 'off-route');
  sim.setIncident(train.id, true);
  for (let i = 0; i < 1000; i++) { sim.step(.1); checkContinuous(sim); }
  assert.equal(train.phase, 'off-route');
  sim.setIncident(train.id, false);
  steps = 0;
  while (train.phase !== 'active' && steps++ < 4000) { sim.step(.1); checkContinuous(sim); }
  assert.equal(train.phase, 'active');
});

test('opción de una sola pasada y validación de parámetros', () => {
  const sim = new Simulation(952, { continuous: false });
  for (let i = 0; i < 5000; i++) sim.step(.1);
  assert.equal(sim.status(sim.trains[0]), 'Fin de recorrido');
  assert.equal(sim.status(sim.trains[1]), 'Esperando autorización');
  assert.throws(() => new Simulation(952, { continuous: 'sí' }), /no válidos/);
  assert.throws(() => new Simulation(952, { turnaroundSeconds: -1 }), /no válidos/);
});
