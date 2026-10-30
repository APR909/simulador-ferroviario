#!/usr/bin/env python3
"""Descarga vías y nodos OSM en el formato JSON que importa Vía Lab.

Ejemplo (sur, oeste, norte, este):
    python3 scripts/descargar_osm.py 37.180 -3.620 37.190 -3.605 -o data/mi-zona.json

Consulta áreas pequeñas y respeta las políticas del servidor Overpass elegido.
"""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('sur', type=float, help='latitud mínima')
    parser.add_argument('oeste', type=float, help='longitud mínima')
    parser.add_argument('norte', type=float, help='latitud máxima')
    parser.add_argument('este', type=float, help='longitud máxima')
    parser.add_argument('-o', '--output', default='data/mi-zona.json', help='archivo de salida')
    parser.add_argument('--endpoint', default='https://overpass-api.de/api/interpreter', help='URL del intérprete Overpass')
    args = parser.parse_args()
    if not (-90 <= args.sur < args.norte <= 90 and -180 <= args.oeste < args.este <= 180):
        parser.error('Bbox inválido: deben cumplirse sur < norte y oeste < este.')
    if args.norte - args.sur > 0.2 or args.este - args.oeste > 0.2:
        parser.error('Utiliza un área pequeña: máximo 0,2 grados por lado para este prototipo.')
    bbox = f'{args.sur},{args.oeste},{args.norte},{args.este}'
    query = f'[out:json][timeout:60];way["railway"="rail"]({bbox});(._;>;);out body;'
    payload = urllib.parse.urlencode({'data': query}).encode('utf-8')
    request = urllib.request.Request(args.endpoint, data=payload, headers={
        'User-Agent': 'ViaLab-EducationalPrototype/0.1',
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
        'Accept': 'application/json',
    })
    try:
        with urllib.request.urlopen(request, timeout=80) as response:
            document = json.load(response)
        if not isinstance(document.get('elements'), list):
            raise ValueError('La respuesta no tiene una lista elements válida.')
        ways = sum(1 for e in document['elements'] if e.get('type') == 'way')
        nodes = sum(1 for e in document['elements'] if e.get('type') == 'node')
        if not ways or not nodes:
            raise ValueError('El área no contiene vías y nodos utilizables.')
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(document, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        print(f'Guardado {output}: {ways} ways y {nodes} nodos. Datos © colaboradores de OpenStreetMap (ODbL).')
        return 0
    except (OSError, ValueError, urllib.error.URLError) as exc:
        print(f'No se pudo descargar la zona: {exc}', file=sys.stderr)
        print('Prueba más tarde, con un área menor, otro endpoint Overpass, o exporta JSON desde Overpass Turbo.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
