#!/usr/bin/env python3
"""Actualiza la instantánea redistribuible LTV Adif (no modifica el servidor).

Requiere conexión a las cuatro capas públicas fijas. Conserva las fechas de la
fuente y nunca convierte un fallo de consulta en una lista vacía.
"""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(root))
from limitaciones import LimitationsCache  # noqa: E402

snapshot = LimitationsCache().get()
if snapshot['status'] not in ('recent', 'stale'):
    raise SystemExit('La fuente no se pudo validar o carece de fechas; no se modificó la instantánea.')
target = root / 'data' / 'limitaciones-adif.json'
# Replacing atomically prevents an interrupted write from corrupting the file.
temporary = target.with_suffix('.json.tmp')
temporary.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
temporary.replace(target)
print(f"Guardados {snapshot['count']} puntos AV y {len(snapshot['unlocated'])} sin geometría en {target} · estado {snapshot['status']}")
print('© Administrador de infraestructuras ferroviarias')
