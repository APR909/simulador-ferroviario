#!/usr/bin/env python3
"""Empaqueta la demo en un HTML: lógica, CSS, Leaflet y muestra OSM integrados.
El mapa base de teselas sigue requiriendo red; la geometría de vías funciona sin ella.
"""
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parent.parent
html = (root / 'index.html').read_text(encoding='utf-8')
leaflet_css = (root / 'vendor/leaflet.css').read_text(encoding='utf-8')
maplibre_css = (root / 'vendor/maplibre-gl.css').read_text(encoding='utf-8')
style = (root / 'styles.css').read_text(encoding='utf-8')
leaflet_js = (root / 'vendor/leaflet.js').read_text(encoding='utf-8')
modules = []
for name in ('geo.js', 'graph.js', 'scenario.js', 'multiline.js', 'realtime.js', 'live-source.js', 'live-motion.js', 'infrastructure.js', 'theme.js', 'limitations.js', 'cancellations.js', 'national.js', 'timetable.js', 'live-journeys.js', 'timetable-ui.js', 'app.js'):
    code = (root / 'src' / name).read_text(encoding='utf-8')
    code = re.sub(r'^import .+? from [\'"].+?[\'"];\s*$', '', code, flags=re.MULTILINE)
    code = re.sub(r'^export (?=(?:async )?(?:function|class|const|let|var)\b)', '', code, flags=re.MULTILINE)
    modules.append(f'\n// --- {name} ---\n{code}')
embedded_data = json.dumps(json.loads((root / 'data/sevilla-osm.json').read_text(encoding='utf-8')), ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
embedded_spain = json.dumps(json.loads((root / 'data/espana-osm.json').read_text(encoding='utf-8')), ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
embedded_infrastructure = json.dumps(json.loads((root / 'data/infraestructura-osm.json').read_text(encoding='utf-8')), ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
embedded_ltv = json.dumps(json.loads((root / 'data/limitaciones-adif.json').read_text(encoding='utf-8')), ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
embedded_timetable = json.dumps(json.loads((root / 'data/itinerarios-renfe.json').read_text(encoding='utf-8')), ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')

def js_string(path):
    source = (root / path).read_text(encoding='utf-8')
    source = re.sub(r'\n//# sourceMappingURL=.*?\s*$', '', source)
    return json.dumps(source, ensure_ascii=True).replace('<', '\\u003c')

# The blob URLs make the vector renderer and its worker self-contained even
# when this single file is opened from disk. Basemap tiles still need network.
embedded_maplibre = (
    '<script>try { const jsUrl = source => URL.createObjectURL(new Blob([source], {type:"text/javascript"}));'
    'window.RAIL_BASEMAP_URLS = {'
    'library:jsUrl(' + js_string('vendor/maplibre-gl.mjs') + '),'
    # Browsers can block module workers under file://. The classic worker is
    # bundled from the same MapLibre version and .cjs selects classic mode.
    'worker:jsUrl(' + js_string('vendor/maplibre-gl-worker.classic.js') + ') + "#worker.cjs",'
    'plugin:jsUrl(' + js_string('vendor/leaflet-maplibre-gl.js') + ')};'
    '} catch (_) { /* Simulation still works without a basemap. */ }</script>\n'
)
def replace_required(content, old, new):
    if old not in content:
        raise SystemExit(f'No se encontró el recurso que debe integrarse: {old}')
    return content.replace(old, new, 1)

html = replace_required(html, '<link rel="stylesheet" href="vendor/leaflet.css">', f'<style>\n{leaflet_css}\n</style>')
html = replace_required(html, '<link rel="stylesheet" href="vendor/maplibre-gl.css">', f'<style>\n{maplibre_css}\n</style>')
html = replace_required(html, '<link rel="stylesheet" href="styles.css?v=15">', f'<style>\n{style}\n</style>')
html = replace_required(html, '<script src="vendor/leaflet.js"></script>', '<script>\n' + leaflet_js.replace('</script', '<\\/script') + '\n</script>')
html = replace_required(html, '<script type="module" src="src/app.js?v=17"></script>', '<script>window.RAIL_SAMPLE = ' + embedded_data + '; window.RAIL_SPAIN_SAMPLE = ' + embedded_spain + '; window.RAIL_INFRASTRUCTURE = ' + embedded_infrastructure + '; window.RAIL_LTV_SAMPLE = ' + embedded_ltv + '; window.RAIL_TIMETABLE_SAMPLE = ' + embedded_timetable + ';</script>\n' + embedded_maplibre + '<script type="module">\n' + ''.join(modules).replace('</script', '<\\/script') + '\n</script>')
output = root / 'simulador.html'
output.write_text(html, encoding='utf-8')
print(f'Generado {output} ({output.stat().st_size:,} bytes)')
