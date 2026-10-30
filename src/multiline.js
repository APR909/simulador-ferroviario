/**
 * Educational multi-route dispatcher. Shared OSM edges and OSM junction
 * nodes are exclusive virtual resources. This is NOT a railway interlocking
 * or a validation of physical/safe routes. Same physical edge in opposite
 * directions is intentionally rejected to avoid head-on lock deadlocks.
 * Distances metres, time seconds, speed metres/second.
 */
const MULTI_EPS = 1e-7;
const MULTI_JUNCTION_RADIUS = 15;
const MULTI_MAX_EVENTS = 60;

function multiIsNumber(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function multiValidateRoute(graph, line) {
  const route = line?.route;
  if (!line?.id || !route || !Array.isArray(route.nodeIds) || route.nodeIds.length < 2 ||
      !Array.isArray(route.points) || route.points.length !== route.nodeIds.length ||
      !multiIsNumber(route.length, 200, 100000)) throw new Error('Línea o geometría no válidas.');
  if (new Set(route.nodeIds).size !== route.nodeIds.length) throw new Error(`La línea ${line.id} repite nodos.`);
  for (let i=1; i<route.nodeIds.length; i++) {
    if (!(graph.adj.get(String(route.nodeIds[i-1])) || []).some(edge => edge.to === String(route.nodeIds[i]))) {
      throw new Error(`La línea ${line.id} contiene nodos sin conexión.`);
    }
  }
}

export class MultiSimulation {
  constructor(graph, lines, trainConfigs, { clearance = 12 } = {}) {
    if (!graph?.nodes || !graph?.adj || !Array.isArray(lines) || !lines.length || lines.length > 10 ||
        !Array.isArray(trainConfigs) || !trainConfigs.length || trainConfigs.length > 30 ||
        !multiIsNumber(clearance, 1, 100)) throw new Error('Escenario multiruta no válido.');
    this.graph = graph;
    this.clearance = clearance;
    this.elapsed = 0;
    this.interventions = 0;
    this.events = [];
    this.resources = new Map();
    this.lines = [];
    this.lineById = new Map();
    const edgeDirections = new Map();
    // Even a degree-two node can be a conflict when one line ends and a
    // second begins there. Register every node common to different routes,
    // in addition to graph junctions of degree three or more.
    const nodeLines = new Map();
    for (const input of lines) {
      for (const rawId of new Set(input?.route?.nodeIds || [])) {
        const nodeId=String(rawId);
        if (!nodeLines.has(nodeId)) nodeLines.set(nodeId,new Set());
        nodeLines.get(nodeId).add(String(input?.id ?? ''));
      }
    }

    for (const input of lines) {
      multiValidateRoute(graph, input);
      const lineId = String(input.id);
      if (this.lineById.has(lineId)) throw new Error(`La línea ${lineId} está repetida.`);
      const line = { ...input, id:lineId, spans:[], spanByKey:new Map(), stops:[...(input.stops || [])] };
      const register = (key, kind, start, end) => {
        if (end <= start + MULTI_EPS) return;
        if (line.spanByKey.has(key)) throw new Error(`La línea ${lineId} repite el tramo ${key}.`);
        const span = { key, kind, start, end };
        line.spans.push(span); line.spanByKey.set(key, span);
        if (!this.resources.has(key)) this.resources.set(key, { key, kind, owner:null, occupiedBy:null, lineIds:new Set() });
        this.resources.get(key).lineIds.add(lineId);
      };
      for (let i=1; i<line.route.nodeIds.length; i++) {
        const a = String(line.route.nodeIds[i-1]), b = String(line.route.nodeIds[i]);
        const edge = graph.adj.get(a).find(item => item.to === b);
        const key = `E:${edge.edgeId}`;
        const orientation = `${a}>${b}`;
        const previous = edgeDirections.get(key);
        if (previous && previous.orientation !== orientation && previous.lineId !== lineId) {
          throw new Error(`Las líneas ${previous.lineId} y ${lineId} recorren una misma vía en sentidos opuestos; este prototipo no admite ese conflicto.`);
        }
        if (!previous) edgeDirections.set(key, {orientation, lineId});
        register(key, 'edge', line.route.points[i-1].distance, line.route.points[i].distance);
      }
      for (let i=0; i<line.route.nodeIds.length; i++) {
        const nodeId = String(line.route.nodeIds[i]);
        if ((graph.adj.get(nodeId) || []).length < 3 && (nodeLines.get(nodeId)?.size || 0) < 2) continue;
        const d = line.route.points[i].distance;
        register(`J:${nodeId}`, 'junction', Math.max(0,d-MULTI_JUNCTION_RADIUS), Math.min(line.route.length,d+MULTI_JUNCTION_RADIUS));
      }
      line.spans.sort((a,b) => a.start-b.start || a.end-b.end || a.key.localeCompare(b.key));
      line.stops.sort((a,b) => a.distance-b.distance);
      for (const stop of line.stops) {
        if (!multiIsNumber(stop.distance, 100, line.route.length-30) || !multiIsNumber(stop.dwellSeconds, 0, 1800)) {
          throw new Error(`Parada no válida en ${lineId}.`);
        }
      }
      this.lines.push(line); this.lineById.set(lineId,line);
    }
    let sharedNumber = 0;
    this.sharedResources = [...this.resources.values()].filter(resource => resource.lineIds.size > 1);
    for (const resource of this.sharedResources) resource.label = `C${String(++sharedNumber).padStart(3,'0')}`;

    // Conservative lock-order check: every shared resource must admit a
    // single global acquisition order. Cyclic route combinations are refused
    // rather than allowing a circular wait that could stop trains forever.
    const nextResources = new Map(this.sharedResources.map(resource => [resource.key,new Set()]));
    const indegree = new Map(this.sharedResources.map(resource => [resource.key,0]));
    for (const line of this.lines) {
      const shared = line.spans.filter(span => nextResources.has(span.key)).map(span => span.key);
      for (let i=1; i<shared.length; i++) {
        const from=shared[i-1], to=shared[i];
        if (from===to || nextResources.get(from).has(to)) continue;
        nextResources.get(from).add(to); indegree.set(to,indegree.get(to)+1);
      }
    }
    const readyResources=[...indegree.keys()].filter(key => indegree.get(key)===0);
    let ordered=0;
    while (readyResources.length) {
      const key=readyResources.pop(); ordered++;
      for (const next of nextResources.get(key)) {
        indegree.set(next,indegree.get(next)-1);
        if (indegree.get(next)===0) readyResources.push(next);
      }
    }
    if (ordered!==nextResources.size) throw new Error('Las rutas comparten cruces en orden incompatible; este prototipo rechaza ese posible interbloqueo.');

    const seen = new Set();
    this.trains = trainConfigs.map(config => {
      const id = String(config.id || ''), line = this.lineById.get(String(config.lineId));
      const length = config.length ?? 65, acceleration = config.acceleration ?? .65, braking = config.braking ?? .85;
      const turnaroundSeconds = config.turnaroundSeconds ?? 60;
      if (!id || !/^[A-Za-z0-9_-]{1,16}$/.test(id) || seen.has(id) || !line ||
          !multiIsNumber(config.speedKmh, 5, 160) || !multiIsNumber(config.departureSeconds, 0, 86400) ||
          !multiIsNumber(length, 20, Math.min(300,line.route.length-100)) ||
          !multiIsNumber(acceleration, .05, 3) || !multiIsNumber(braking, .1, 3) ||
          !multiIsNumber(turnaroundSeconds, 0, 3600) || line.stops.some(stop => stop.distance <= length + 5)) {
        throw new Error(`Configuración no válida para el tren ${id || 'sin identificador'}.`);
      }
      seen.add(id);
      return {
        id, lineId:line.id, line, speedKmh:config.speedKmh, maxSpeed:config.speedKmh/3.6,
        departureSeconds:config.departureSeconds, length, acceleration, braking, turnaroundSeconds,
        phase:'scheduled', head:0, speed:0, targetSpeed:0, incident:false,
        readyAt:config.departureSeconds, enteredAt:null, firstDepartureAt:null,
        completedTrips:0, stopIndex:0, dwellUntil:null, holdUntil:null, holdRequested:0,
        reservations:new Set(), blockedBy:null, blockedResource:null, stopLimit:0,
      };
    });
    this.trainById = new Map(this.trains.map(train => [train.id,train]));
    this.refreshOccupancy();
    this.admitReadyTrains();
    this.refreshOccupancy();
    this.reserveAll();
    this.updateAuthorities();
  }

  event(text) {
    this.events.push({time:this.elapsed, text});
    if (this.events.length > MULTI_MAX_EVENTS) this.events.shift();
  }

  refreshOccupancy() {
    for (const resource of this.resources.values()) resource.occupiedBy = null;
    for (const train of this.trains) {
      if (train.phase !== 'active') continue;
      const tail = Math.max(0,train.head-train.length);
      for (const span of train.line.spans) {
        if (span.start >= train.head - MULTI_EPS) break;
        if (tail >= span.end - MULTI_EPS) continue;
        const resource = this.resources.get(span.key);
        if (resource.owner !== train.id) throw new Error(`El tren ${train.id} ocupa un tramo sin reserva.`);
        if (resource.occupiedBy && resource.occupiedBy !== train.id) throw new Error(`Dos trenes ocupan ${span.key}.`);
        resource.occupiedBy = train.id;
      }
    }
  }

  releaseCleared() {
    for (const train of this.trains) {
      if (train.phase !== 'active') continue;
      const tail = train.head-train.length;
      for (const key of train.reservations) {
        const span = train.line.spanByKey.get(key), resource = this.resources.get(key);
        if (span.end > tail + MULTI_EPS) continue;
        if (resource.occupiedBy === train.id) throw new Error('Un tramo ocupado no puede liberarse.');
        if (resource.owner === train.id) resource.owner = null;
        train.reservations.delete(key);
      }
    }
  }

  claim(train, resource) {
    if (resource.owner !== null && resource.owner !== train.id) return false;
    resource.owner = train.id; train.reservations.add(resource.key);
    return true;
  }

  admitReadyTrains() {
    const ready = this.trains.filter(train => train.phase !== 'active' && !train.incident && train.readyAt <= this.elapsed + MULTI_EPS)
      .sort((a,b) => a.readyAt-b.readyAt || a.id.localeCompare(b.id));
    let entered = false;
    for (const train of ready) {
      const head = train.length;
      const required = train.line.spans.filter(span => span.end > MULTI_EPS && span.start < head+this.clearance+MULTI_EPS);
      const occupied = required.map(span => this.resources.get(span.key)).find(resource => resource.owner !== null);
      if (!required.length || occupied) { train.blockedBy = occupied?.owner || null; continue; }
      for (const span of required) this.claim(train,this.resources.get(span.key));
      train.phase='active'; train.head=head; train.speed=0; train.targetSpeed=0; train.stopIndex=0;
      train.enteredAt=this.elapsed; if (train.firstDepartureAt === null) train.firstDepartureAt=this.elapsed;
      train.dwellUntil=null; train.holdUntil=null; train.holdRequested=0; train.blockedBy=null; train.blockedResource=null;
      this.event(`${train.id} entra en ${train.lineId}.`); entered = true;
    }
    return entered;
  }

  reserveAll() {
    const active = this.trains.filter(train => train.phase === 'active')
      .sort((a,b) => a.enteredAt-b.enteredAt || a.id.localeCompare(b.id));
    for (const train of active) {
      const tail = Math.max(0,train.head-train.length);
      const brakingDistance = train.speed**2/(2*train.braking);
      const lookahead = Math.max(180,brakingDistance+train.speed*.6+2*this.clearance+35);
      let target = Math.min(train.line.route.length,train.head+lookahead);
      const stop = train.line.stops[train.stopIndex];
      if (stop && stop.distance >= train.head) target = Math.min(target,stop.distance+MULTI_JUNCTION_RADIUS+this.clearance);
      let blocked = null;
      for (const span of train.line.spans) {
        if (span.start > target + MULTI_EPS) break;
        if (span.end <= tail + MULTI_EPS) continue;
        const resource = this.resources.get(span.key);
        if (!this.claim(train,resource)) { blocked = resource; break; }
      }
      const old = train.blockedBy;
      train.blockedBy = blocked?.owner || null;
      train.blockedResource = blocked?.key || null;
      if (train.blockedBy && train.blockedBy !== old) this.event(`${train.id} espera tramo reservado por ${train.blockedBy}.`);
    }
  }

  updateAuthorities() {
    for (const train of this.trains) {
      if (train.phase !== 'active') { train.stopLimit=0; continue; }
      let limit = train.line.route.length + train.length;
      for (const span of train.line.spans) {
        if (span.end <= train.head + MULTI_EPS) continue;
        const resource = this.resources.get(span.key);
        if (resource.owner !== train.id) { limit = Math.min(limit,span.start-this.clearance); break; }
      }
      train.stopLimit = Math.max(0,limit);
    }
  }

  processTimers() {
    for (const train of this.trains) {
      if (train.phase !== 'active') continue;
      if (train.dwellUntil !== null && this.elapsed + MULTI_EPS >= train.dwellUntil) {
        train.dwellUntil = null; train.stopIndex++;
        this.event(`${train.id} sale de la parada.`);
      }
      if (train.holdUntil !== null && this.elapsed + MULTI_EPS >= train.holdUntil) train.holdUntil = null;
    }
  }

  setIncident(id, active) {
    const train = this.trainById.get(String(id));
    if (!train) throw new Error('No existe ese tren.');
    train.incident = Boolean(active);
    this.event(`${active ? 'Incidencia' : 'Incidencia resuelta'} · ${train.id}.`);
  }

  delayTrain(id, seconds=60) {
    const train = this.trainById.get(String(id));
    if (!train || !multiIsNumber(seconds,1,3600)) throw new Error('No se pudo aplicar el retardo.');
    if (train.phase !== 'active') train.readyAt += seconds;
    else if (train.dwellUntil !== null) train.dwellUntil += seconds;
    else if (train.holdUntil !== null) train.holdUntil += seconds;
    else train.holdRequested += seconds;
    this.event(`${train.id}: retardo ficticio de ${seconds} s.`);
  }

  step(dt=.1) {
    if (!multiIsNumber(dt,.001,.5)) throw new Error('Paso de simulación no válido.');
    this.processTimers();
    this.refreshOccupancy();
    this.releaseCleared();
    if (this.admitReadyTrains()) this.refreshOccupancy();
    this.reserveAll();
    this.updateAuthorities();
    for (const train of this.trains) {
      if (train.phase !== 'active') continue;
      const stop = train.line.stops[train.stopIndex];
      const stopDistance = stop && train.dwellUntil === null ? stop.distance : Infinity;
      const available = Math.max(0,Math.min(train.stopLimit,stopDistance)-train.head);
      const b=train.braking;
      const discriminant=(b*dt)**2-4*b*dt*train.speed+8*b*available;
      const safeEndSpeed=Math.max(0,(Math.sqrt(Math.max(0,discriminant))-b*dt)/2);
      const held=train.incident || train.holdRequested>0 || train.holdUntil !== null || train.dwellUntil !== null;
      const target=held ? 0 : Math.min(train.maxSpeed,safeEndSpeed);
      let newSpeed=train.speed<target ? Math.min(target,train.speed+train.acceleration*dt) : Math.max(target,train.speed-b*dt);
      let movement=newSpeed===0 && train.speed>0 && train.speed<=b*dt ? train.speed**2/(2*b) : (train.speed+newSpeed)*.5*dt;
      if (movement>available+MULTI_EPS) { movement=available; newSpeed=0; this.interventions++; }
      train.head+=movement; train.speed=newSpeed; train.targetSpeed=target;
    }
    this.elapsed+=dt;
    this.refreshOccupancy();
    for (const train of this.trains) {
      if (train.phase !== 'active') continue;
      const stop=train.line.stops[train.stopIndex];
      if (stop && train.dwellUntil===null && Math.abs(train.head-stop.distance)<.12 && train.speed<.12) {
        train.speed=0; train.dwellUntil=this.elapsed+stop.dwellSeconds;
        this.event(`${train.id} se detiene en ${stop.name}.`);
      }
      if (train.holdRequested>0 && train.speed<.03) {
        train.speed=0; train.holdUntil=this.elapsed+train.holdRequested; train.holdRequested=0;
      }
      if (train.head-train.length < train.line.route.length-MULTI_EPS) continue;
      for (const key of train.reservations) {
        const resource=this.resources.get(key);
        if (resource.occupiedBy===train.id) throw new Error('No se puede liberar un tramo bajo un tren.');
        if (resource.owner===train.id) resource.owner=null;
      }
      train.reservations.clear(); train.phase='off-route'; train.speed=0; train.targetSpeed=0;
      train.completedTrips++; train.readyAt=this.elapsed+train.turnaroundSeconds; train.blockedBy=null; train.blockedResource=null;
      this.event(`${train.id} sale de ${train.lineId}; retorno virtual.`);
    }
    this.updateAuthorities();
  }

  status(train) {
    if (train.phase !== 'active') {
      if (train.incident) return 'Salida retenida por incidencia';
      const remaining=Math.max(0,Math.ceil(train.readyAt-this.elapsed-MULTI_EPS));
      if (remaining) return train.phase==='scheduled' ? `Salida en ${remaining} s` : `Fuera · regreso en ${remaining} s`;
      return train.blockedBy ? `Espera entrada · ${train.blockedBy}` : 'Preparado para entrar';
    }
    if (train.incident) return train.speed>.15 ? 'Frenando por incidencia' : 'Detenido por incidencia';
    if (train.holdRequested>0) return 'Frenando por retardo';
    if (train.holdUntil!==null) return `Retenido · ${Math.max(0,Math.ceil(train.holdUntil-this.elapsed-MULTI_EPS))} s`;
    if (train.dwellUntil!==null) return `Parada · ${train.line.stops[train.stopIndex]?.name || 'estación'}`;
    if (train.head >= train.line.route.length) return 'Saliendo de la zona';
    if (train.blockedBy && train.speed<.2 && train.stopLimit-train.head<.5) return `Espera tramo · ${train.blockedBy}`;
    if (train.blockedBy && train.targetSpeed < train.maxSpeed*.85) return `Frenando · ${train.blockedBy}`;
    return 'En marcha';
  }
}
