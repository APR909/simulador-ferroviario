/**
 * Educational single-route, single-direction block simulation.
 * In continuous mode trains exit the modelled section, wait off-map, and
 * re-enter only after the entry blocks are clear. The return is fictitious.
 * It does NOT implement railway interlocking or certify a real installation.
 * Units: metres, seconds, metres/second and metres/second².
 */
const EPSILON = 1e-7;

export class Simulation {
  constructor(routeLength, { blockSize = 150, clearance = 8, continuous = true, turnaroundSeconds = 20 } = {}) {
    if (!Number.isFinite(routeLength) || routeLength < 600 || routeLength > 100000) {
      throw new Error('El recorrido debe medir entre 600 m y 100 km en este prototipo.');
    }
    if (!Number.isFinite(blockSize) || blockSize <= 0 || !Number.isFinite(clearance) || clearance < 0 || clearance >= blockSize / 2) {
      throw new Error('Parámetros de bloque no válidos.');
    }
    if (typeof continuous !== 'boolean' || !Number.isFinite(turnaroundSeconds) || turnaroundSeconds < 0) {
      throw new Error('Modo de circulación o tiempo de retorno no válidos.');
    }
    this.routeLength = routeLength;
    this.blockSize = blockSize;
    this.clearance = clearance;
    this.continuous = continuous;
    this.turnaroundSeconds = turnaroundSeconds;
    this.elapsed = 0;
    this.interventions = 0;
    this.blocks = [];
    for (let start = 0, index = 0; start < routeLength; start += blockSize, index++) {
      this.blocks.push({
        index, start, end: Math.min(routeLength, start + blockSize),
        owner: null, occupiedBy: []
      });
    }
    this.trains = [
      { id: '101', name: 'Tren 101', role: 'Delante', color: '#195e59', head: routeLength * 0.54, length: 70,
        speed: 0, maxSpeed: 18 / 3.6, acceleration: 0.55, braking: 0.75, incident: false, phase: 'active', completedTrips: 0, readyAt: null },
      { id: '102', name: 'Tren 102', role: 'Detrás', color: '#c3742b', head: routeLength * 0.16, length: 70,
        speed: 0, maxSpeed: 32 / 3.6, acceleration: 0.65, braking: 0.8, incident: false, phase: 'active', completedTrips: 0, readyAt: null }
    ];
    this.refreshOccupancy(true);
    this.reserveAhead();
    this.updateAuthorities();
  }

  /** Physical occupancy covers the entire train, not just its front. */
  refreshOccupancy(initialize = false) {
    for (const block of this.blocks) block.occupiedBy = [];
    for (const train of this.trains) {
      if (train.phase !== 'active') continue;
      const tail = Math.max(0, train.head - train.length);
      for (const block of this.blocks) {
        if (train.head > block.start + EPSILON && tail < block.end - EPSILON) {
          block.occupiedBy.push(train.id);
          if (block.owner !== null && block.owner !== train.id) {
            throw new Error(`Invariante incumplida: el tren ${train.id} ocupa un bloque reservado por otro.`);
          }
          if (block.owner === null && !initialize) {
            throw new Error(`Invariante incumplida: el tren ${train.id} ha entrado en un bloque sin reserva.`);
          }
          if (initialize) block.owner = train.id;
        }
      }
    }
    for (const block of this.blocks) {
      if (block.occupiedBy.length > 1) throw new Error('Invariante incumplida: dos trenes en un bloque.');
    }
  }

  /** Release only when the tail has cleared the complete block. */
  releaseCleared() {
    for (const block of this.blocks) {
      if (block.owner === null) continue;
      const train = this.trains.find(t => t.id === block.owner);
      if (train && block.end <= train.head - train.length + EPSILON) block.owner = null;
    }
  }

  /**
   * Retain reservations already granted; never give the same block to two trains.
   * This toy scenario is unidirectional, so the frontmost train is handled first.
   */
  reserveAhead() {
    for (const train of this.trains.filter(t => t.phase === 'active').sort((a, b) => b.head - a.head)) {
      const brakingDistance = train.speed ** 2 / (2 * train.braking);
      const lookahead = Math.max(this.blockSize * 2, brakingDistance + this.clearance + 60);
      const target = Math.min(this.routeLength - EPSILON, train.head + lookahead);
      const first = Math.min(this.blocks.length - 1, Math.floor(train.head / this.blockSize));
      const last = Math.min(this.blocks.length - 1, Math.floor(target / this.blockSize));
      for (let i = first; i <= last; i++) {
        const block = this.blocks[i];
        if (block.owner !== null && block.owner !== train.id) break;
        block.owner = train.id;
      }
    }
  }

  updateAuthorities() {
    for (const train of this.trains) {
      if (train.phase !== 'active') {
        train.authorityEnd = null; train.stopLimit = null; train.blockedBy = null;
        continue;
      }
      const first = Math.min(this.blocks.length - 1, Math.floor(train.head / this.blockSize));
      let i = first;
      while (i < this.blocks.length && this.blocks[i].owner === train.id) i++;
      train.authorityEnd = i === first ? train.head : this.blocks[i - 1].end;
      train.blockedBy = i < this.blocks.length ? this.blocks[i].owner : null;
      if (this.continuous && i === this.blocks.length && i > first) {
        // A virtual exit beyond the modelled section lets the *whole* train
        // clear the final block before it disappears. This is not an OSM route.
        train.stopLimit = this.routeLength + train.length;
        train.authorityEnd = train.stopLimit + this.clearance;
      } else {
        train.stopLimit = Math.max(0, Math.min(this.routeLength, train.authorityEnd) - this.clearance);
      }
    }
  }

  /** Remove a train only once its tail has cleared the final virtual block. */
  completeDepartures() {
    for (const train of this.trains) {
      if (train.phase !== 'active' || train.head - train.length < this.routeLength - EPSILON) continue;
      for (const block of this.blocks) {
        if (block.owner === train.id) {
          if (block.occupiedBy.includes(train.id)) throw new Error('No se puede liberar un bloque bajo un tren.');
          block.owner = null;
        }
      }
      train.phase = 'off-route';
      train.completedTrips++;
      train.readyAt = this.elapsed + this.turnaroundSeconds;
      train.speed = 0;
      train.targetSpeed = 0;
    }
  }

  /** Re-entry is atomic and waits for all blocks under the train to be free. */
  admitReadyTrains() {
    const waiting = this.trains
      .filter(train => train.phase === 'off-route' && !train.incident && train.readyAt <= this.elapsed + EPSILON)
      .sort((a, b) => a.readyAt - b.readyAt || a.id.localeCompare(b.id));
    let admitted = false;
    for (const train of waiting) {
      const head = train.length;
      const required = this.blocks.filter(block => head > block.start + EPSILON && 0 < block.end - EPSILON);
      if (!required.length || required.some(block => block.owner !== null || block.occupiedBy.length)) continue;
      for (const block of required) block.owner = train.id;
      train.head = head;
      train.speed = 0;
      train.targetSpeed = 0;
      train.phase = 'active';
      train.readyAt = null;
      admitted = true;
    }
    return admitted;
  }

  setIncident(trainId, active) {
    const train = this.trains.find(t => t.id === String(trainId));
    if (!train) throw new Error('No existe ese tren.');
    train.incident = Boolean(active);
  }

  step(dt = 0.1) {
    if (!Number.isFinite(dt) || dt <= 0 || dt > 0.5) throw new Error('Paso de simulación no válido.');
    this.refreshOccupancy();
    this.releaseCleared();
    if (this.continuous && this.admitReadyTrains()) this.refreshOccupancy();
    this.reserveAhead();
    this.updateAuthorities();
    for (const train of this.trains) {
      if (train.phase !== 'active') continue;
      const available = Math.max(0, train.stopLimit - train.head);
      const b = train.braking;
      // Require distance moved during this step plus subsequent braking distance
      // to stay within the authority: (v0+v1)dt/2 + v1²/(2b) <= available.
      const discriminant = (b * dt) ** 2 - 4 * b * dt * train.speed + 8 * b * available;
      const safeEndSpeed = Math.max(0, (Math.sqrt(Math.max(0, discriminant)) - b * dt) / 2);
      const target = train.incident ? 0 : Math.min(train.maxSpeed, safeEndSpeed);
      let newSpeed = train.speed < target
        ? Math.min(target, train.speed + train.acceleration * dt)
        : Math.max(target, train.speed - b * dt);
      // If braking reaches zero before dt, integrate only until the stopping time.
      let movement = newSpeed === 0 && train.speed > 0 && train.speed <= b * dt
        ? train.speed ** 2 / (2 * b)
        : (train.speed + newSpeed) * 0.5 * dt;
      // Final numerical guard, not a substitute for a real safety system.
      if (movement > available + EPSILON) {
        movement = available;
        newSpeed = 0;
        this.interventions++;
      }
      train.head += movement;
      train.speed = newSpeed;
      train.targetSpeed = target;
    }
    this.elapsed += dt;
    this.refreshOccupancy();
    if (this.continuous) this.completeDepartures();
    this.updateAuthorities();
  }

  status(train) {
    if (train.phase === 'off-route') {
      if (train.incident) return 'Fuera de zona · incidencia';
      const remaining = Math.max(0, Math.ceil(train.readyAt - this.elapsed - EPSILON));
      return remaining ? `Fuera · vuelve en ${remaining} s` : 'Esperando vía de entrada';
    }
    const available = Math.max(0, train.stopLimit - train.head);
    if (train.incident) return train.speed > 0.15 ? 'Frenando por incidencia' : 'Detenido por incidencia';
    if (this.continuous && train.head >= this.routeLength) return 'Saliendo de la zona';
    if (available < 0.3 && train.speed < 0.15) {
      return train.authorityEnd >= this.routeLength - EPSILON ? 'Fin de recorrido' : 'Esperando autorización';
    }
    if (train.targetSpeed !== undefined && train.targetSpeed < train.maxSpeed * 0.88 && train.speed > 0.15) {
      return train.authorityEnd >= this.routeLength - EPSILON
        ? (this.continuous ? 'Frenando para salir' : 'Frenando para el final') : 'Frenando por bloqueo';
    }
    return 'En marcha';
  }
}
