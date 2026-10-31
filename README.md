# Vía Lab · España y Sevilla

Mapa ferroviario web y simulador didáctico. La vista **España** presenta vías de OpenStreetMap, posiciones recientes de Renfe cuando están disponibles y dos capas independientes: **cancelaciones identificables de viajes AV de Renfe** y **limitaciones temporales de velocidad (LTV) de Adif**. La vista **Sevilla** conserva, por separado, el escenario ficticio de cinco líneas, diez trenes y recursos virtuales compartidos. **Itinerarios** permite explorar horarios programados de las últimas 24 horas; no reproduce posiciones históricas.

> **Límite importante:** las LTV son una instantánea publicada, no un feed de averías o cortes en tiempo real. Las cancelaciones son avisos de viajes de Renfe, no causas ni ubicaciones de cortes. Ninguna capa es un diagnóstico completo de la red; consulta el [estado de la red de Adif](https://www.adif.es/viajeros/estado-de-la-red) para los avisos de tráfico.

> **Alcance y seguridad:** no es un sistema de control ferroviario ni un mapa operativo certificado. Una conexión geométrica OSM no demuestra que exista un itinerario autorizado. No utilizar para operar trenes ni tomar decisiones de seguridad.

## 1. Inicio paso a paso

### GitHub Pages: trenes sin servidor propio

En GitHub Pages la aplicación es estática y no puede ejecutar `servidor.py`. Cuando falta `/api/trenes`, el navegador consulta directamente la API pública con CORS de [RadarDeTrenes](https://radardetrenes.com/docs) para posiciones AV/LD/MD y Cercanías. Se actualiza como máximo cada 30 segundos por pestaña, requiere conexión y depende de la disponibilidad del intermediario. Si el proveedor responde con HTTP 429, se respeta `Retry-After` hasta un máximo de siete días; sin cabecera válida se espera dos minutos. La cobertura es parcial; el reloj del dispositivo debe estar bien ajustado para que se validen correctamente las fechas. Los puntos de Cercanías consultados de esta forma no se animan si su hora GPS individual no puede verificarse.

Además, al seleccionar un itinerario el navegador consulta automáticamente los tablones actuales mediante el mismo intermediario. En GitHub Pages las cancelaciones necesitan el servidor Python y se indican como **SIN SERVIDOR**; las LTV solo muestran la **INSTANTÁNEA** incluida, no una consulta actual. No se presenta ninguna de ellas como disponible en tiempo real.

### Itinerarios y línea de tiempo de 24 horas

1. Abre **Itinerarios · 24 horas** en la barra superior. La sección **Recorridos en curso · Ahora** muestra trenes detectados en la instantánea actual de RadarDeTrenes, con búsqueda, filtro por tipo y puntos opcionales en el mapa. Su contador representa únicamente los registros recientes que publica la fuente, no todos los trenes existentes. La consulta se actualiza aproximadamente cada 30 s mientras la vista está abierta; si no hay una fuente reciente se muestra `—`, no un cero ficticio. Los trenes pueden aparecer mientras se cargan los horarios o si estos fallan; las paradas solo se añaden al disponer de un cruce válido.
2. Selecciona un tren detectado para ver su trayecto. Si coincide inequívocamente por tipo, número, origen, destino y fecha de servicio con el GTFS de Renfe se dibujan sus paradas programadas. Para trenes sin esa correspondencia se muestra el punto disponible y, cuando se conocen los extremos, una línea recta entre ellos; no se inventan paradas ni horarios. En Cercanías RadarDeTrenes no garantiza una hora GPS individual, por lo que el punto se etiqueta como instantánea sin hora individual verificada.
3. La línea de tiempo sigue siendo independiente: arrastra el deslizador o usa −24 h, −12 h y −6 h para elegir un instante pasado; **Ahora** vuelve al final de la ventana.
4. La lista muestra viajes cuyo **horario programado** abarca el instante elegido. Filtra por número, línea, estación o tipo de servicio; toca un viaje para consultar su secuencia de paradas y horas de llegada y salida. Pulsa una parada para centrar el mapa.
5. Al seleccionar un viaje se consultan **automáticamente cada aproximadamente 45 s** hasta 12 tablones actuales de Renfe / ADIF a través de RadarDeTrenes, con hasta tres peticiones simultáneas y caché de 30 s por estación. La consulta se pausa al cambiar de vista u ocultar la pestaña y se reanuda al volver; **Actualizar ahora** permite repetirla manualmente. Si el proveedor limita las solicitudes, se respeta su tiempo de espera.
6. Cada llegada o salida muestra siempre la hora **programada** y, si hay una coincidencia fiable, por separado la **estimada** o **real** y su demora. Se exige coincidencia de número, estación, origen, destino y hora programada. Solo se rotula `real` si el tablón la identifica como `REAL`, y `estimada` si indica `ESTIMATED`; se calcula como hora programada más demora publicada. Los tablones y registros con fecha antigua se descartan, no se infiere puntualidad si faltan datos y se muestra la hora de la última comprobación. El reloj del dispositivo debe ser correcto.

Los tablones se consultan directamente desde cada navegador y no requieren servidor adicional. No todas las estaciones o salidas/llegadas están disponibles; se indica si una parada queda fuera del límite de consulta. Las horas actuales no se guardan ni forman un histórico de las últimas 24 horas. Pueden dejar de aparecer cuando el viaje sale del tablón; ni una estimación ni un retraso genérico se convierten en hora real confirmada.

**No hay histórico GPS:** la vista no guarda posiciones y la línea discontinua une estaciones en línea recta; no representa una vía ni un trayecto efectivamente recorrido. El horario no prueba que el tren circulase. Metro, tranvía y otros operadores no están en estos GTFS de Renfe. Para planificar viajes consulta al operador.

Los calendarios son una **instantánea estática** de [Renfe AV/LD/MD](https://data.renfe.com/dataset/horarios-de-alta-velocidad-larga-distancia-y-media-distancia) y [Cercanías](https://data.renfe.com/dataset/horarios-cercanias), CC BY 4.0. El archivo inicial incluido en el repositorio se generó el **31-10-2026** (hora de Madrid), con días de servicio AV/LD/MD del **29-10 al 30-11-2026** y Cercanías del **30-10 al 28-11-2026**. GitHub Pages intenta publicar una instantánea renovada cada día mediante GitHub Actions; la fecha y cobertura visibles en la aplicación corresponden al despliegue efectivamente publicado. Los horarios pueden cambiar y algunas circulaciones se omiten por validaciones conservadoras. La aplicación avisa cuando el instante queda fuera de cobertura: no interpreta la falta de horarios como ausencia de trenes.

El flujo descarga los dos GTFS, recupera la instantánea de horarios previamente publicada y conserva días de servicio pasados solo si desaparecieron por completo del nuevo GTFS. Se etiquetan como **instantánea previa** y pueden omitir cambios; no se guarda ningún histórico GPS. Si la descarga, la validación o las pruebas fallan, el flujo no despliega datos nuevos y permanece visible la última versión válida. Las ejecuciones programadas pueden retrasarse o detenerse; revisa su estado en **Actions** y la fecha mostrada en la aplicación. El flujo publica un artefacto generado, **sin actualizar mediante commits los archivos base del repositorio**.

Para renovar también la copia local o la que hay en el repositorio, ejecuta desde la carpeta del proyecto y vuelve a publicar los archivos modificados:

```bash
python3 scripts/generar_itinerarios_renfe.py --previous data/itinerarios-renfe.json  # conserva días previos si aún están disponibles
python3 scripts/crear_html_autocontenido.py   # también renueva el HTML de un solo archivo
npm test
```

El generador usa calendarios y excepciones GTFS, conserva tiempos superiores a 24 h y aplica la zona `Europe/Madrid` con la definición GTFS de medianoche de servicio («mediodía menos 12 horas»). Rechaza viajes con datos ambiguos en vez de corregirlos por aproximación. Consulta `python3 scripts/generar_itinerarios_renfe.py --help` para usar ZIP ya descargados o ajustar el periodo. El HTML autocontenido incluye los horarios para funcionar sin red; la consulta de tablones sí requiere conexión.

### Con consultas directas mediante el servidor Python

1. Descomprime el proyecto y abre una terminal en su carpeta.
2. Con Python 3 ejecuta:

   ```bash
   python3 servidor.py --host 127.0.0.1 --port 8000
   ```

   En Windows puede ser `py servidor.py --host 127.0.0.1 --port 8000`. Alternativamente, si tienes Node.js y Python, `npm start` inicia el mismo servidor, escuchando en `0.0.0.0`.
3. Abre <http://localhost:8000/>. En una vista previa remota el servidor debe escuchar en `0.0.0.0`, y se debe usar la URL de la vista previa, no el `localhost` del navegador.
4. La vista **España** se abre por defecto. Usa **Península**, **Canarias** o **Toda España** para cambiar el encuadre. Activa o desactiva las capas de vías en el panel; pulsa un tramo para consultar sus datos OSM. Al acercar aparecen estaciones y paradas con nombre. El botón **Oscuro / Claro** de la barra superior cambia la interfaz y el fondo del mapa; la elección se guarda en el navegador cuando este permite `localStorage`.
5. En **Trenes observados**, `AV` identifica un servicio de alta velocidad reconocido, `R` otro servicio del feed mixto AV/Larga/Media Distancia y `C` una posición de Cercanías. Estas son observaciones separadas de los trenes `SIM`. La capa de Cercanías está inicialmente oculta en España: actívala en el panel si quieres verla. El filtro **Solo alta velocidad / AVE / Avlo / Avant** depende de las etiquetas disponibles y puede quedar desactivado. Consulta el estado y la hora de cada fuente; `—` indica dato atrasado o no disponible.
6. La casilla **Animar entre observaciones** muestra una interpolación visual estimada entre posiciones GPS ya recibidas. No sigue necesariamente la vía ni representa la ubicación exacta en ese instante. Espera una segunda posición individual reciente para ver movimiento, pulsa un icono para consultar el último GPS y desactiva la casilla si prefieres saltar directamente a cada posición observada.
7. Pulsa **Sevilla · simulador** en la barra superior para volver a la red y al escenario local. En **Simulación ficticia**, pulsa **Iniciar simulación** y usa 1×–32×. Las cinco líneas, sus horarios y los marcadores `SIM` son ficticios. Al volver a España, el escenario se pausa y puedes reanudarlo al regresar.
8. En **Gestionar tren simulado** elige un tren; puedes detenerlo con **Simular incidencia** o introducir un **Retardo +60 s**. Resuelve manualmente la incidencia; el retardo termina solo. Abre **Editar velocidades y salidas** para modificar el plan y reiniciar el escenario.
9. En Sevilla, las tarjetas de **Líneas ficticias** centran cada recorrido. **Ver líneas** encuadra todos; **Ver red completa** encuadra el extracto local. Las casillas ocultan o muestran las vías de fondo por modo, sin ocultar los recorridos ficticios. Las observaciones Renfe del panel local son independientes de la simulación.
10. Para explorar la infraestructura, amplía hasta **zoom 12 o más** y activa en el panel **Elementos de vía**. Pulsa los símbolos para consultar señales, agujas, cruces o hitos OSM. En España puedes usar **Localizar una señal de ejemplo** para centrar una señal etiquetada. Pulsa una vía para ver sus etiquetas disponibles; «Ver etiquetas OSM» despliega las etiquetas conservadas. Las señales y sus aspectos posibles no son lecturas en tiempo real.
11. En España, **Cancelaciones AV · Renfe** muestra avisos de viajes AVE, Avlo y Avant que se pueden identificar de forma inequívoca y cuya salida está prevista en las próximas 24 horas. La **X roja** indica la estación programada de salida, no una avería ni su ubicación. Consulta el detalle, los avisos descartados por ambigüedad y la fecha del feed; la casilla permite ocultarlos.
12. **Limitaciones de velocidad · AV** añade marcadores de Adif distintos de las señales OSM. La cifra del símbolo es la velocidad publicada en km/h. Pulsa un marcador o abre **Ver referencias localizadas** y elige uno para acercarte y ver la línea, los PK, vías y fecha de origen. La casilla permite ocultarlos. La etiqueta **DATO ANTIGUO**, **INSTANTÁNEA** o **FECHA DESCONOCIDA** advierte de que no se puede confirmar la situación actual. El botón **Consultar** solicita una actualización; no modifica la fecha de la fuente. Para averías y cortes, usa el enlace a **Estado de la red** de Adif.

Si el puerto 8000 ya está ocupado, inspecciona qué proceso lo utiliza antes de detenerlo. En Linux/macOS puedes usar `lsof -i :8000` o `ss -ltnp`; en Windows, `netstat -ano | findstr :8000`. También puedes elegir otro puerto con `--port 8001`.

**El servidor incluido amplía las fuentes disponibles.** Consulta las dos fuentes de posiciones GTFS-RT de Renfe y, como alternativa para AV/LD/MD si el GTFS directo falla, caduca o solo contiene posiciones descartadas, la API independiente de RadarDeTrenes. También consulta el feed fijo de cancelaciones de Renfe, el GTFS estático para etiquetas y horarios, y los servicios públicos de LTV y tramos de Adif. Ofrece API relativas al navegador. Un simple `python3 -m http.server` no proporciona esas API; en ese caso el navegador consulta RadarDeTrenes directamente para posiciones y, al seleccionar un viaje, para tablones de itinerarios. Consultar cada cinco minutos no hace que la fuente LTV sea de actualización inmediata.

### HTML autocontenido

`simulador.html` incorpora código, estilos, ambas redes de vías, la infraestructura OSM y **instantáneas fechadas** de LTV Adif y de horarios GTFS de Renfe. Puedes abrirlo directamente con doble clic: las redes, los datos estáticos y la simulación de Sevilla funcionan, y OpenFreeMap se carga si hay conexión y WebGL2. Desde un archivo (`file://`) o un alojamiento estático, el navegador puede consultar posiciones directamente a RadarDeTrenes si permite la conexión CORS; sin red mostrará `—`, no un cero ficticio. Las cancelaciones requieren el servidor Python y las LTV se muestran como **INSTANTÁNEA**, sin afirmar que continúen vigentes. Para disponer también de esas API, arranca `servidor.py` y visita <http://localhost:8000/simulador.html>.

En un visor aislado sin acceso a la red, las vías y la simulación continúan sobre una cuadrícula. Pulsa **Reintentar** cuando vuelva a estar disponible el fondo. En una CSP restrictiva hay que permitir conexiones HTTPS a `tiles.openfreemap.org` y los workers de MapLibre; el HTML autocontenido usa workers `blob:`.

### Pruebas y generación

Necesitas Node.js 18+ y Python 3.9+ para ejecutar la suite principal; no hace falta instalar paquetes de Node ni Python para usar el proyecto ni para esa suite. Se utiliza la zona horaria `Europe/Madrid` del sistema; para equipos que no dispongan de base de zonas IANA se incluye una copia de respaldo TZDB 2026c en dominio público:

```bash
npm test                                  # Node --test y unittest de Python
python3 scripts/crear_html_autocontenido.py
```

La segunda orden regenera `simulador.html` a partir de los archivos modulares y los datos incluidos. Opcionalmente, para reproducir la comprobación de interfaz con observaciones **sintéticas**, inicia `servidor.py` en el puerto 8000 y, en otra terminal, instala Playwright y Chromium y ejecuta:

```bash
npm install --no-save --no-package-lock playwright
npx playwright install chromium
node tests/browser-motion.mjs
```

Esta prueba opcional comprueba interpolación, caducidad, filtros, movimiento reducido, móvil y el HTML aislado; no necesita datos reales. Para otro servidor se puede fijar `VIALAB_URL`. Para probar específicamente la ruta de GitHub Pages, inicia `python3 -m http.server 8001` en otra terminal y ejecuta `node tests/browser-pages.mjs`. `node tests/browser-pages-live.mjs` es una comprobación opcional con RadarDeTrenes real y requiere red; las cifras varían y pueden ser cero.

## 2. Qué representan los mapas

### España: infraestructura OSM

La vista nacional utiliza los extractos de [España](https://download.geofabrik.de/europe/spain.html) y [Canarias](https://download.geofabrik.de/africa/canary-islands.html) de Geofabrik, instantánea OSM del **29 de octubre de 2026**. España y Canarias son dos ficheros distintos. La selección también incluye Baleares y puede contener vías en áreas vecinas. Las islas sin vías de las categorías incluidas no presentan trazos; no se inventa una red. `data/espana-osm.json` contiene **45.695 fragmentos OSM**, con cero referencias de nodos ausentes al generarlo, y 2.956 nodos de estaciones/paradas con nombre. No son 45.695 líneas comerciales ni 2.956 estaciones únicas.

| Capa | Fragmentos | Criterio simplificado |
|---|---:|---|
| Alta velocidad | 6.645 | `railway=rail` y `highspeed=yes` |
| Ferrocarril convencional | 16.273 | `railway=rail` no clasificada en las anteriores u otras categorías |
| Vía estrecha | 5.334 | `railway=narrow_gauge` |
| Metro y tranvía | 5.366 | `railway=subway`, `light_rail` o `tram` |
| Vías de servicio | 12.077 | `railway=rail` con `service=yard`, `siding`, `spur` o `crossover`, excepto vías ya clasificadas como alta velocidad |

El color rojo marca las vías **etiquetadas** `highspeed=yes`, no todas las vías que potencialmente permiten alta velocidad: OSM puede carecer de esa etiqueta o contener errores. No se deduce alta velocidad a partir de `maxspeed`. Una línea que no aparezca en rojo no queda necesariamente excluida de la red de alta velocidad; tampoco se garantiza que un tramo rojo esté operativo. No se incorporan como vías los objetos etiquetados directamente `railway=construction` o `railway=disused`; otros atributos pueden requerir comprobación. Las coordenadas se redondean a cinco decimales, y los trazos incluyen vías de servicio, no un catálogo de relaciones o servicios comerciales.

Las cifras del panel se refieren al extracto completo, no solo al área visible. Las estaciones se muestran a partir del zoom 9 y se limitan a 600 por ventana; representan únicamente nodos OSM con nombre y pueden existir duplicados o estaciones modeladas como áreas que no aparecen. Los colores y las etiquetas no certifican infraestructura ni explotación. En dispositivos modestos, cargar el extracto nacional puede tardar unos segundos.

### Datos de vía y señalización

La capa común de infraestructura procede del mismo extracto nacional OSM del **29 de octubre de 2026**. Contiene estos **nodos cartografiados**, no un inventario completo de instalaciones físicas:

| Tipo OSM | Nodos incluidos |
|---|---:|
| Señales ferroviarias `railway=signal` | 1.091 |
| Agujas `railway=switch` | 12.370 |
| Pasos a nivel `railway=level_crossing` | 5.058 |
| Cruces `railway=crossing` | 2.294 |
| Hitos `railway=milestone` | 759 |

Se muestran desde el zoom 12, con un máximo de 600 elementos por vista; el panel avisa si debes ampliar para ver más. Las señales tienen prioridad en el límite, seguidas de agujas, cruces e hitos. Cada filtro permite ocultar o mostrar su categoría. En una vía se muestran, **solo si están etiquetados**, datos como velocidad máxima, ancho en mm, electrificación, tensión, frecuencia, operador, ASFA o ETCS. Los cuadros enlazan al objeto original y permiten ver las etiquetas conservadas: pueden faltar, ser incorrectas o estar desactualizadas. No constituyen límites ni autorizaciones operativas.

Los símbolos representan **ubicaciones y atributos estáticos**. No se conoce el estado actual de señales, agujas o barreras. Los posibles aspectos de una señal, cuando figuran en `railway:signal:main:states`, son posibilidades etiquetadas, no el aspecto que muestra ahora. La dirección `forward`/`backward` y la posición izquierda/derecha son relativas al sentido del `way` OSM, no un sentido geográfico absoluto. La simulación no lee ni controla la señalización real.

El rectángulo de Sevilla de esta capa contiene 264 agujas, 80 pasos a nivel, ocho cruces y **ningún nodo de señal etiquetado** en esta instantánea. Es una limitación de cobertura OSM, no significa que allí no existan señales reales. Los símbolos de infraestructura del mapa de Sevilla utilizan el extracto nacional del 29 de octubre, mientras que sus vías locales proceden del extracto andaluz del día 28. Si importas otra zona, la capa de elementos sigue usando únicamente el extracto nacional incluido.

### Cancelaciones de viajes AV de Renfe

El servidor consulta el [GTFS-RT de horarios de Renfe](https://data.renfe.com/dataset/horarios-viaje-alta-velocidad-larga-media-distancia) y lo cruza por `trip_id` exacto con el [GTFS estático oficial](https://data.renfe.com/dataset/horarios-de-alta-velocidad-larga-distancia-y-media-distancia). Filtra `scheduleRelationship=CANCELED` de viajes identificados como **AVE, Avlo o Avant** y con salida programada en las próximas 24 horas. No cubre otras operadoras, otros productos, cancelaciones de paradas individuales, retrasos, causas ni todos los avisos de infraestructura. El mapa coloca una **X en la estación prevista de salida**, no en la posición de una incidencia, y conserva los viajes sin coordenadas en la lista.

- Las cabeceras del feed se consultan cada 30 s y se rechazan si superan 90 s o están más de 30 s en el futuro. **Una cabecera reciente no asegura que cada aviso sea reciente**: se rechazan avisos con fecha individual explícitamente antigua o futura. Los que carecen de fecha individual pueden mostrarse solo como datos parciales, con «fecha no indicada»; su antigüedad no se puede verificar.
- Se comprueba el calendario GTFS, sus excepciones y el horario en `Europe/Madrid`. Si falta `startDate` y un mismo `trip_id` puede circular en varios días del catálogo, se excluye por ambiguo aunque solo una de sus salidas se encuentre dentro de las próximas 24 horas. Esto evita trasladar una cancelación de ayer a otro día. También se excluyen descripciones contradictorias, horarios dudosos y salidas en días de cambio de hora (la referencia GTFS «mediodía menos 12 h» puede diferir de la hora civil). Los contadores de descartes corresponden al **feed completo**, no al número de incidencias de hoy ni solo de AV.
- Ante descartes el panel indica **DATOS PARCIALES**. Un `0` significa únicamente «ninguna cancelación inequívoca identificada en el alcance anterior», no que la red esté libre de problemas. Si el feed está atrasado, la consulta falla o no hay servidor, muestra `—` y retira los marcadores. El GTFS estático se guarda en caché durante seis horas, no ofrece garantías de actualización y puede no coincidir con el RT.
- Atribución: **Origen de los datos: Renfe Operadora**, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). El programa prioriza la base horaria del sistema y usa como respaldo el archivo `data/europe-madrid-tzdb-2026c.tzif` de [IANA TZDB 2026c](https://www.iana.org/time-zones), de dominio público. Actualiza la base horaria si cambian las normas.

### Limitaciones de velocidad de Adif · no son avisos en directo

La capa **LTV Adif** usa el [servicio público de limitaciones temporales](https://www.arcgis.com/home/item.html?id=5e62ef71f0614bb3b007df238607e8bf) y el [catálogo de tramos en servicio](https://www.arcgis.com/home/item.html?id=4ec7c0fb3cab42b0b488d65e65eeb7aa), ambos de Adif. El servicio LTV publica puntos y una tabla sin geometría. Se seleccionan registros cuyo **código de línea y rango de PK** se solapan con un tramo que el catálogo clasifica `COD_TIPO_R=A` («uso principal de alta velocidad»). El catálogo es independiente, de actualización trimestral, y sus PK son aproximados: esta unión puede excluir limitaciones y no demuestra que todo el intervalo de cada LTV sea AV. No se usan distancias a OSM ni se presupone que una línea entera sea de alta velocidad.

- El **punto es la referencia geográfica suministrada por Adif**, no una señal física ni necesariamente el inicio, fin o lugar exacto de una incidencia. El registro da los PK inicial y final por separado. Una LTV no es necesariamente una avería o un corte, y no se conocen automáticamente sus causas.
- Se presentan por separado la **última edición de datos** del servicio, la **fecha efectiva del archivo** indicado por Adif y la **fecha de consulta**. Se usa la más antigua de las dos primeras para evaluar el envejecimiento. Si excede seis horas, la interfaz indica **DATO ANTIGUO**; este umbral es conservador y no describe la periodicidad garantizada de Adif. Incluso un dato reciente no garantiza información al minuto ni vigencia operativa.
- El servidor consulta las capas fijas a demanda, con caché compartida de cinco minutos, validación de esquema, IDs, sistema de coordenadas y controles frente a consultas truncadas o cambios entre capas. Si alguna consulta falla, devuelve `status=error` y `count=null`, nunca un cero. El navegador mantiene, claramente etiquetada, la última instantánea válida o la incluida sin conexión. Los registros AV sin geometría se conservan en una lista y no reciben un punto inventado. Un código AV sin PK clasificable se cuenta como desconocido y no se inventa su clasificación.
- La instantánea distribuida se consultó el **30-10-2026**; la última edición de datos de origen era **26-10-2026 08:22** y la fecha efectiva del archivo **26-10-2026 09:00**, hora peninsular. Contiene **84 puntos** que cumplen el cruce descrito. Son datos históricos, no 84 incidencias actuales. Las cifras y fechas pueden cambiar al consultar el servidor.
- El visor enlaza al [estado de la red de Adif](https://www.adif.es/viajeros/estado-de-la-red) para cortes y averías. No hemos integrado un feed público, completo y georreferenciado de incidencias AV al minuto; no se convierte un retraso de un tren en una presunta avería.
- Atribución exigida por los dos servicios: **© Administrador de infraestructuras ferroviarias**. Las condiciones aparecen en los enlaces a los elementos ArcGIS y permiten cualquier uso con esa atribución.

Para actualizar manualmente la instantánea redistribuible (con conexión) y volver a generar el HTML:

```bash
python3 scripts/actualizar_limitaciones.py
python3 scripts/crear_html_autocontenido.py
```

El primer comando no sustituye el archivo si la fuente falla o carece de fecha validable; tampoco garantiza que Adif haya publicado datos recientes.

### Sevilla metropolitana

El extracto incluido procede de OpenStreetMap, a través de la instantánea de Geofabrik Andalucía del **28 de octubre de 2026**. Se seleccionaron los segmentos que intersecan este **rectángulo geográfico**, que es una aproximación práctica y **no** el límite administrativo oficial del área metropolitana:

| Límite | Coordenada WGS84 |
|---|---:|
| Oeste | −6,28° |
| Sur | 37,14° |
| Este | −5,68° |
| Norte | 37,60° |

Incluye, por ejemplo, el entorno de Santa Justa, Benacazón y Utrera, además de la geometría disponible de la línea 1 del metro y el tranvía sevillano. Se conservan 699 fragmentos de vías y 5.742 nodos referenciados: 556 fragmentos etiquetados `rail`, 85 `subway` y 58 `tram`. Son **fragmentos OSM**, no 699 líneas ni estaciones. Incluyen vías de servicio, cocheras y apartaderos cuando están etiquetados como vía; también se incluye una colección de nodos de estaciones/paradas, en la que una parada puede tener varios nodos.

El importador admite `rail`, `subway`, `light_rail`, `tram` y `narrow_gauge`; en esta instantánea no aparecen vías `light_rail` ni `narrow_gauge` dentro del rectángulo. Las categorías `construction`, `disused` y las atracciones de monorraíl no forman parte de esta selección. Un segmento que cruza el límite puede conservar un extremo fuera del rectángulo para mantener la geometría. El fondo de OpenFreeMap puede mostrar elementos externos a la zona, pero el recuento y el extracto de vías utilizan los límites anteriores.

**OSM es colaborativo y puede contener omisiones, errores o información desactualizada.** La palabra «red completa» en el botón significa encuadrar todo el extracto incluido, no una garantía de cobertura, estado de servicio ni exactitud de todas las vías reales.

## 3. Interpretar el número de trenes

En Sevilla, la cifra principal es la **suma de posiciones recientes publicadas por las fuentes Renfe que están disponibles**, filtradas al rectángulo anterior. En España se presentan las dos fuentes por separado y se usan dos rectángulos aproximados: longitud −9,8 a 4,6 / latitud 35,0 a 44,4; y longitud −18,5 a −13,0 / latitud 27,4 a 29,8. No son fronteras administrativas y pueden incluir posiciones en países vecinos. **Ninguna cifra es el total de trenes en circulación:**

- Fuentes GTFS-RT directas: [Cercanías Renfe](https://data.renfe.com/dataset/ubicacion-vehiculos) y [Alta Velocidad, Larga y Media Distancia Renfe](https://data.renfe.com/dataset/posicion-vehiculos-av-ld-md), ambas con licencia [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Si el feed directo AV/LD/MD falla, caduca o solo tiene posiciones no utilizables, se consulta como alternativa [RadarDeTrenes](https://radardetrenes.com/docs), servicio independiente basado en datos de Renfe y ADIF. Se identifica expresamente el mediador; no se suman las dos listas AV/LD/MD. Las condiciones de RadarDeTrenes son las de su propia web, no se presupone que sean idénticas a las del GTFS abierto.
- **Metro de Sevilla, TUSSAM/tranvía, Ouigo, iryo y otros operadores no están cubiertos** por esas dos fuentes. No se ha integrado una fuente pública verificada de posiciones para ellos. Los horarios GTFS estáticos no equivalen a posiciones reales.
- Se cuentan vehículos identificables con coordenadas publicadas, no se deduce si están físicamente moviéndose. La cobertura del feed puede ser incompleta, y una suma entre fuentes podría contar dos veces un vehículo publicado por ambas.
- Cada fuente muestra `0` solo si su respuesta es válida y reciente y no contiene posiciones válidas dentro de la zona. `—` significa que está ausente, ha fallado o su marca temporal no es reciente. Si solo una de las dos fuentes es utilizable, la suma se marca **parcial**.
- El servidor consulta cada feed directo como máximo cada **30 s** y la alternativa RadarDeTrenes también como máximo cada **30 s**, con caché compartida entre navegadores. En un alojamiento estático se hace una consulta de la flota completa a RadarDeTrenes como máximo cada **30 s por pestaña**, compartida entre las vistas de España y Sevilla. Renfe declara una frecuencia de 20 s para Cercanías y 15 s para AV/LD/MD; este prototipo solicita menos a menudo.
- Se aplica un umbral de **90 s** a la cabecera GTFS-RT y, cuando existe, a la hora de cada posición; para RadarDeTrenes son obligatorias y se validan `updatedAt` y `timestamp`. Se toleran hasta 30 s de diferencia hacia el futuro. En el navegador se compara con el reloj del dispositivo, que debe estar correctamente ajustado. En Cercanías vía RadarDeTrenes la marca puede reflejar la agregación y no un GPS individual verificable; se advierte y no se interpola. Los datos fuera del umbral y los registros marcados por RadarDeTrenes como posiblemente antiguos no se dibujan como recientes. Si no se dispone de una fuente utilizable no se sustituyen los datos por ceros ni por posiciones simuladas.
- Algunos vehículos no llevan hora individual de medición. En ese caso se utiliza la hora de publicación de la cabecera, se indica **sin hora GPS** y no se puede asegurar que la posición sea tan reciente como la cabecera. Esta es una limitación del feed, no una extrapolación.
- Los marcadores y recuentos envejecen también en el navegador: al superar el umbral dejan de presentarse como actuales aunque la pestaña no haya conseguido refrescar. Por prudencia, el navegador suma el tiempo completo de la consulta a la edad aparente; una conexión lenta puede hacer que se descarte algún dato todavía reciente.

Si el GTFS directo AV/LD/MD entrega una marca antigua o incompatible con la hora actual, se intenta la alternativa independiente. Si tampoco hay una instantánea alternativa reciente, se señala **Dato atrasado** y se muestra `—`. No se corrige automáticamente la hora ni se presupone un huso horario distinto: GTFS-RT define los timestamps como segundos Unix. Las horas en la interfaz se presentan en `Europe/Madrid`.

El feed Renfe AV/LD/MD mezcla alta velocidad, larga y media distancia. `R` **no implica por sí solo que el servicio sea AVE ni que circule por una línea de alta velocidad**. Para el GTFS directo, el servidor puede cruzar `trip_id` exactamente con el [GTFS estático oficial de Renfe](https://data.renfe.com/dataset/horarios-de-alta-velocidad-larga-distancia-y-media-distancia), almacenado en caché durante seis horas. RadarDeTrenes aporta su propio nombre de producto. El filtro incluye las etiquetas reconocidas `AVE`, `AVE INT`, `AVLO`, `AVANT`, `AVANT EXP` y `Alta Velocidad`; excluye Cercanías, otros nombres y posiciones sin identificar. «Alta Velocidad» es una clasificación genérica, **no prueba que el servicio sea de la marca AVE**, su modelo ni su velocidad real. Si no existen identificaciones, el filtro queda desactivado. Servicios como Alvia o Euromed pueden usar tramos AV, pero no se añaden al filtro por inferencia de marca o velocidad.

### Cómo se anima una observación

Cuando llegan dos posiciones recientes del mismo identificador, con hora GPS individual, viaje compatible y desplazamiento plausible, se interpola **en línea recta entre puntos ya observados** durante un máximo de 30 s. Se descarta la animación si el intervalo supera 90 s o el salto es incompatible con 432 km/h más un margen de 120 m de ruido; las lecturas contradictorias para la misma hora se ocultan. Esto es una estimación visual, no un recorrido verificado ni una medición GPS del instante mostrado: puede atravesar zonas sin vía, quedar retrasada o no reflejar paradas. Nunca extrapola más allá de la última posición recibida. El aro discontinuo distingue un icono en interpolación y la ficha muestra la última coordenada y hora observadas.

Con un único GPS, sin hora individual, con un salto sospechoso o al desmarcar **Animar entre observaciones**, se muestra directamente el último punto válido. Si el dato caduca o desaparece, se retira el icono; si no llega otra medición no se inventa movimiento. El ajuste de movimiento reducido del sistema desactiva inicialmente la animación. No se publican datos ficticios como reales ni se hace coincidir el marcador con la vía automáticamente.

## 4. Usar la simulación didáctica

Al abrir la aplicación se preparan en Sevilla **cinco rutas ficticias y diez trenes** sobre geometría OSM real. Los nombres son orientativos; no son líneas, paradas, itinerarios, servicios ni horarios operativos validados. La ruta calculada puede utilizar vías de servicio, agujas, cocheras o apartaderos. Las paradas son temporizadores en puntos geométricos próximos a los nombres indicados, no una simulación real de andenes.

| Línea ficticia | Ruta aproximada | Trenes: velocidad máxima / salida desde las 08:00 | Parada ficticia |
|---|---|---|---|
| L1 · Norte | San Jerónimo → Santa Justa → Virgen del Rocío, 12,5 km | 101: 74 km/h, 0 s; 102: 60 km/h, 90 s | Santa Justa, 28 s |
| L2 · Sur | Santa Justa → San Bernardo → Bellavista, 8,1 km | 201: 82 km/h, 0 s; 202: 64 km/h, 100 s | San Bernardo, 24 s |
| L3 · Este | Santa Justa → San Bernardo → Palmete, 10,7 km | 301: 67 km/h, 25 s; 302: 76 km/h, 125 s | San Bernardo, 32 s |
| M1 · Metro | Ciudad Expo → San Bernardo → Olivar, 17,9 km | 401: 52 km/h, 0 s; 402: 40 km/h, 70 s | San Bernardo, 20 s |
| T1 · Tranvía | Plaza Nueva → San Bernardo → Eduardo Dato, 3,1 km | 501: 25 km/h, 0 s; 502: 19 km/h, 50 s | San Bernardo, 18 s |

Las rutas L2 y L3 comparten geometría OSM y compiten por recursos. **Tramos compartidos** muestra recursos comunes a varias líneas: naranja ocupado, verde reservado y gris libre. El texto indica quién espera y el último evento. Los identificadores `C...` son virtuales, no circuitos ni señales reales. Los filtros de ferrocarril, metro y tranvía afectan a las vías de fondo; los trazos de las líneas ficticias permanecen visibles.

El reloj comienza a las **08:00 ficticias** y avanza con pasos de 0,1 s. Los botones 1×/4×/8×/16×/32× aceleran el tiempo, no cambian la velocidad máxima expresada en km/h. Cada tren acelera y frena; su velocidad mostrada puede ser inferior a la programada por una parada, otra reserva o una incidencia.

La circulación es **continua**: cuando toda la cola sale de la ruta, el tren deja libres sus recursos, espera 60 segundos simulados y vuelve a entrar si puede reservar la entrada. El regreso al origen es virtual, no se representa ni presupone una vía real de retorno. La tarjeta muestra su estado y el número de pasadas completas. Una incidencia retenida puede causar una espera indefinida hasta que el usuario la resuelva.

### Ejercicio paso a paso: gestionar un conflicto

1. En **Gestionar tren simulado** elige **SIM 201 · L2 Sur** con la simulación en pausa y pulsa **Simular incidencia**.
2. Selecciona **32×** y pulsa **Iniciar simulación**. El 201 retiene los recursos que ocupa; cuando llega su hora, el 301 de L3 puede quedar en **Espera entrada · 201**. Otros trenes de líneas independientes continúan.
3. Con el 201 seleccionado, pulsa **Resolver incidencia**. Al despejarse el tramo, el 301 puede entrar; observa las tarjetas y el panel de recursos.
4. Elige otro tren y pulsa **Retardo +60 s**. Si aún no ha entrado, se aplaza su próxima salida; si está en marcha, frena y permanece retenido 60 s después de detenerse. Si está en una parada, se alarga esa espera. El retardo se libera automáticamente.
5. Abre **Editar velocidades y salidas**. Introduce valores de **5 a 160 km/h** y una salida entera de **0 a 86400 s** desde las 08:00. **Aplicar y reiniciar** vuelve el reloj a las 08:00 y reconstruye las reservas; se pierden los retardos e incidencias en curso. El botón de reinicio también conserva el plan editado y elimina el estado en marcha.

**Añadir línea** permite seleccionar dos nodos OSM como origen y destino. Se agrega una ruta ficticia y dos trenes, y se reinicia el conjunto en pausa; una importación nueva comienza sin las líneas anteriores. Distancia admitida: 600 m–100 km; máximo 10 líneas y 30 trenes en el motor. Por diseño, se rechazan rutas que compartan una arista OSM en sentidos opuestos o un orden de recursos compartidos que pueda causar espera circular. No se resuelven cruces de trenes enfrentados ni itinerarios operativos. Las vías sin IDs OSM compartidos no se conectan solo por cercanía visual.

### Si parece que un tren no se mueve

- Pulsa **Iniciar simulación** y selecciona **16× o 32×**: la línea de metro mide casi 18 km y su segunda salida es más lenta.
- Revisa la tarjeta: `Salida en…`, `Parada`, `Espera tramo`, `Espera entrada` o `Fuera · regreso…` son esperas explicadas. La cifra de pasadas aumenta al completar cada recorrido. Una incidencia debe resolverse manualmente.
- Pulsa **Ver líneas** o una tarjeta de línea para encuadrar los recorridos. Si aparece una versión antigua, recarga con `Ctrl+F5` o `Cmd+Mayús+R`.
- Los iconos `AV`, `R` y `C` son **observaciones Renfe**, no trenes simulados. Con la animación activada solo se mueven si llega otra posición individual válida y compatible; con una única observación o sin hora GPS quedan en el último punto recibido.

## 5. Organización y arquitectura

```text
index.html                         interfaz modular
simulador.html                     versión autocontenida
styles.css                         interfaz y estilos del mapa
servidor.py                        HTTP estático + API de Renfe y LTV
limitaciones.py                    cliente ArcGIS ADIF, clasificación AV y caché
cancelaciones.py                   cancelaciones Renfe + horarios/fechas GTFS exactos
radar.py                           alternativa atribuida y validación de RadarDeTrenes
src/geo.js                         distancias y geometría de rutas
src/graph.js                       importación OSM y camino mínimo
src/scenario.js                    cinco rutas ficticias y horarios de ejemplo
src/multiline.js                   motor multirruta y reservas OSM compartidas
src/simulation.js                  motor anterior de una ruta, conservado para pruebas
src/realtime.js                    caducidad y agregación de observaciones
src/live-source.js                 fuente RadarDeTrenes directa para alojamiento estático
src/live-motion.js                 interpolación visual acotada de posiciones recibidas
src/national.js                    mapa nacional, capas y filtros de observaciones
src/timetable.js                   calendario GTFS, ventana y validación de tablones
src/live-journeys.js               asociación conservadora de flota y horarios
src/timetable-ui.js                línea de tiempo, paradas y mapa de itinerarios
src/limitations.js                 capa y ficha LTV, validación y estado de frescura
src/cancellations.js               capa Renfe de cancelaciones, consulta y fichas
src/infrastructure.js              filtros, selección y fichas de elementos OSM
src/theme.js                       selector claro/oscuro y persistencia
src/app.js                         mapa, controles y actualización en navegador
data/espana-osm.json               fragmentos y atributos OSM nacionales, paradas
data/infraestructura-osm.json      señales, agujas, cruces e hitos OSM
data/limitaciones-adif.json        instantánea LTV fechada, atribuida a Adif
data/europe-madrid-tzdb-2026c.tzif respaldo IANA para la zona Europe/Madrid
data/TZDB-README.txt               procedencia y licencia del archivo TZif
data/sevilla-osm.json              vías y nodos OSM de la zona incluida
data/granada-osm.json              antigua muestra usada en pruebas de regresión
scripts/importar_espana_osm.py     extracción nacional desde los dos PBF
scripts/importar_infraestructura_osm.py  etiquetas de vías y nodos ferroviarios
scripts/importar_sevilla_osm.py    extracción reproducible desde PBF regional
scripts/descargar_osm.py           descarga opcional de zonas pequeñas por Overpass
scripts/actualizar_limitaciones.py  actualiza la instantánea de Adif si es válida
scripts/generar_itinerarios_renfe.py descarga y compacta calendarios/horarios GTFS
data/itinerarios-renfe.json         instantánea estática de horarios GTFS de Renfe
scripts/crear_html_autocontenido.py empaquetado del HTML
tests/                             pruebas Node y Python con fixtures sintéticos
vendor/                            Leaflet, MapLibre y licencias
```

`GET /api/trenes` usa por defecto el bbox de Sevilla; `GET /api/trenes?ambito=espana` usa los dos rectángulos nacionales. En ambos ámbitos se informa del catálogo de servicios cuando está disponible. La respuesta contiene el instante del servidor y las dos fuentes, cada una con `status`, `count`, `header_timestamp` cuando existe y una lista de posiciones recientes. El proveedor alternativo se indica con `source_provider: "radar"` y conserva el estado previo `direct_status`; no se fusiona con el feed directo. El navegador usa una URL relativa; no llama a `localhost` ni directamente a Renfe. El servidor no acepta URL externas suministradas por el cliente. Los candados evitan consultas duplicadas concurrentes y los feeds directos se consultan en paralelo con timeout. Los fallos de una fuente no ocultan la otra.

`GET /api/cancelaciones-av` devuelve `status`, `header_timestamp`, `generated_at`, viajes `records` y `count` (`null` si el feed es antiguo o falla). Incluye `unmatched_trips`, `ambiguous_trips` y `stale_individual_updates` como contadores de descartes, y `missing_individual_timestamps` para los avisos mostrados sin fecha propia. Usa solo el feed fijo de Renfe y el GTFS estático compartido; ninguna cancelación alimenta la simulación.

`GET /api/limitaciones` devuelve `status`, `source_edited_at`, `file_effective_at`, `fetched_at`, puntos `records`, `unlocated` y `count` (`null` ante error). Su cliente usa solo URL fijas de Adif; los parámetros del navegador no permiten elegir el origen. El navegador recalcula la edad desde las fechas de origen y distingue la última consulta de una actualización de los datos. Ninguna LTV afecta al motor de simulación.

El servidor HTTP incluido está orientado al desarrollo y escucha en la interfaz indicada por `--host`. Antes de exponerlo a una red pública habría que incorporar, entre otras medidas, un servidor de producción, controles de acceso, TLS, límites de peticiones y observabilidad. No hay ninguna función de seguridad ferroviaria.

### Grafo

- Cada nodo OSM referenciado conserva su ID y coordenadas; cada `way` aporta una secuencia ordenada de nodos.
- Cada par consecutivo genera una arista con longitud aproximada Haversine. El grafo es no dirigido en este prototipo.
- Las conexiones se crean solo mediante IDs de nodo compartidos, nunca por cruces o proximidad gráfica.
- `shortestPath()` aplica Dijkstra y `makeRoute()` transforma el resultado en geometría recorrible.

Incluso un nodo compartido puede ser un cruce sin comunicación, una aguja restringida o un caso que exija ancho, sentido y reglas adicionales. El camino mínimo es una **hipótesis geométrica**, no un itinerario ferroviario validado.

### Motor multirruta

`buildDemoScenario()` calcula cinco caminos con Dijkstra en grafos filtrados por modo y crea diez configuraciones ficticias. `new MultiSimulation(graph, lines, trains)` comparte **una sola tabla de recursos** entre todas las rutas: cada arista OSM de un recorrido es un recurso exclusivo y cada nodo de grado ≥ 3, o compartido por varias líneas, añade un recurso de cruce con una ventana de ±15 m. Los recursos pertenecientes a dos o más líneas se muestran en el panel inferior; también se coordinan las aristas compartidas por trenes de una misma línea. La identidad es por IDs OSM, no por cercanía.

Cada paso recalcula la ocupación de la cabeza y la cola, libera recursos solo cuando la cola los despeja y reserva por delante en el orden de cada ruta. La reentrada exige adquirir atómicamente los recursos que ocupa el tren. La autorización limita el avance; la planificación del frenado tiene en cuenta `v²/(2b)` y el paso discreto. Las paradas, incidencias, retardos y salidas son temporizadores del simulador. Un fallo de invariantes detiene la simulación en vez de dibujar dos ocupantes en el mismo recurso.

Para evitar ciertos interbloqueos se rechaza compartir una arista en sentidos opuestos y se exige que el orden de los recursos compartidos de todas las rutas tenga un orden topológico común; las combinaciones cíclicas se rechazan. Esta restricción es **conservadora**: puede rechazar rutas que un sistema real sí resolvería. No modela circulación bidireccional sobre vía única, inversión de marcha, regulación real de prioridades, perfiles de velocidad, agujas y señales operativas, capacidad de andenes ni normativas de seguridad. La aproximación de cruces OSM y el rechazo de ciclos no prueban seguridad ferroviaria ni garantizan todos los casos físicos.

Un cruce visual sin un ID de nodo común no se detecta. A la inversa, un nodo OSM común no certifica que el movimiento sea físicamente posible; varias vías pueden estar mal modeladas o faltar datos. El motor anterior de una única ruta permanece en `src/simulation.js` y sus pruebas son regresiones independientes; la interfaz usa `src/multiline.js`.

`tests/multiline.test.mjs` comprueba durante dos horas simuladas que los diez trenes progresan, comparten recursos sin doble ocupación y completan varias pasadas; también cubre incidencias, retardos, un cruce sintético, rechazos por sentidos opuestos y ciclos de recursos. Las pruebas no equivalen a una validación de seguridad ni demuestran que los recorridos existan operativamente.

## 6. Importar otra zona OSM

1. Abre <https://overpass-turbo.eu/> y enfoca un área pequeña.
2. Ejecuta:

   ```overpass
   [out:json][timeout:60];
   way["railway"~"^(rail|subway|light_rail|tram|narrow_gauge)$"]({{bbox}});
   (._; >;);
   out body;
   ```

3. Exporta **raw data directly from Overpass API** como JSON. No utilices GeoJSON si quieres conservar la identidad de los nodos.
4. En la aplicación abre **Trabajar con otra zona → Cargar JSON de OpenStreetMap**. El límite es 15 MB o 30.000 aristas. Selecciona origen y destino con **Añadir línea** como se describe arriba.
5. **Restaurar red de Sevilla** vuelve al extracto incluido. Las posiciones Renfe siguen filtradas al rectángulo de Sevilla, independientemente del archivo de vías importado.

Overpass puede limitar peticiones. Para áreas extensas es preferible procesar un extracto regional. Si los nodos faltan o las vías pertenecen a componentes distintos, la ruta puede no existir; no fuerces uniones por cercanía.

### Regenerar el extracto metropolitano

Solo para preparar los datos, instala la dependencia opcional `osmium` y descarga la versión regional OSM de Geofabrik:

```bash
python3 -m pip install osmium
curl -L https://download.geofabrik.de/europe/spain/andalucia-latest.osm.pbf -o andalucia.osm.pbf
python3 scripts/importar_sevilla_osm.py andalucia.osm.pbf
python3 scripts/crear_html_autocontenido.py
npm test
```

La descarga regional puede rondar los 200 MB y su tamaño cambia. El script no necesita el PBF en tiempo de ejecución. Su rectángulo y los tipos seleccionados están definidos al comienzo del archivo; si se modifican, hay que actualizar también `BBOX` en `servidor.py` y las pruebas. Para conservar una fecha verificable, usa una URL de instantánea fechada y pasa `--source-url ... --source-date AAAA-MM-DD`. Comprueba la licencia y atribución antes de distribuir datos derivados.

### Regenerar el extracto nacional

No es necesario para utilizar la aplicación. Los PBF no se incluyen en el ZIP; regenerar la instantánea exige PyOsmium, el programa `osmium` de `osmium-tool`, aproximadamente 1,6 GB de descarga y varias pasadas por ambos ficheros. El tiempo y la memoria dependen del equipo. Por ejemplo, para reproducir las fuentes fechadas incluidas:

```bash
python3 -m pip install osmium
# Instala además osmium-tool con el gestor de paquetes de tu sistema.
curl -L https://download.geofabrik.de/europe/spain-261029.osm.pbf -o spain-261029.osm.pbf
curl -L https://download.geofabrik.de/africa/canary-islands-261029.osm.pbf -o canary-islands-261029.osm.pbf
python3 scripts/importar_espana_osm.py spain-261029.osm.pbf canary-islands-261029.osm.pbf --date 2026-10-29

# -R filtra sin arrastrar todos los nodos de cada vía; se usan solo sus etiquetas.
for region in spain-261029 canary-islands-261029; do
  osmium tags-filter -R "$region.osm.pbf" 'w/railway=rail,narrow_gauge,subway,light_rail,tram' -o "$region-ways.osm.pbf"
  osmium tags-filter -R "$region.osm.pbf" 'n/railway=signal,switch,level_crossing,crossing,milestone' -o "$region-infra.osm.pbf"
done
python3 scripts/importar_infraestructura_osm.py \
  --ways spain-261029-ways.osm.pbf canary-islands-261029-ways.osm.pbf \
  --nodes spain-261029-infra.osm.pbf canary-islands-261029-infra.osm.pbf \
  --date 2026-10-29
python3 scripts/crear_html_autocontenido.py
npm test
```

Los archivos fechados pueden dejar de estar disponibles. Para otra instantánea, proporciona los PBF correspondientes y ajusta explícitamente `--date AAAA-MM-DD`, `--spain-source URL` y `--canary-source URL`; así los metadatos no afirmarán una fecha o fuente incorrecta. Las pruebas actuales fijan la fecha del extracto distribuido y comprueban algunos tramos conocidos: revísalas al actualizar los datos. No filtres un PBF grande con índices densos en un equipo con memoria limitada sin comprobar primero sus requisitos. Comprueba la atribución y la licencia ODbL antes de distribuir datos derivados.

## 7. Fuentes y licencias

- Vías e infraestructura: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright), bajo [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/); extractos originales de [Geofabrik España](https://download.geofabrik.de/europe/spain.html), [Canarias](https://download.geofabrik.de/africa/canary-islands.html) y [Andalucía](https://download.geofabrik.de/europe/spain/andalucia.html). Los IDs y datos derivados están en `data/espana-osm.json`, `data/infraestructura-osm.json` y `data/sevilla-osm.json`. Consulta también el [etiquetado ferroviario OSM en España](https://wiki.openstreetmap.org/wiki/OpenRailwayMap/Tagging_in_Spain).
- LTV y clasificación de tramos: © Administrador de infraestructuras ferroviarias, [servicio LTV de Adif](https://www.arcgis.com/home/item.html?id=5e62ef71f0614bb3b007df238607e8bf), [tramos en servicio](https://www.arcgis.com/home/item.html?id=4ec7c0fb3cab42b0b488d65e65eeb7aa) y [visor oficial](https://ltv-adif.hub.arcgis.com/). Los metadatos de ambos servicios autorizan cualquier uso con la atribución indicada. No confundir estos datos con los [avisos de tráfico](https://www.adif.es/viajeros/estado-de-la-red).
- Cancelaciones: [GTFS-RT de Renfe AV/LD/MD](https://data.renfe.com/dataset/horarios-viaje-alta-velocidad-larga-media-distancia), datos de Renfe Operadora, CC BY 4.0. Estaciones y calendarios proceden del GTFS estático. [IANA TZDB](https://www.iana.org/time-zones) es de dominio público.
- Servicios: [GTFS estático oficial de Renfe AV/LD/MD](https://data.renfe.com/dataset/horarios-de-alta-velocidad-larga-distancia-y-media-distancia), para identificar nombres cuando hay coincidencia exacta.
- Posiciones GTFS directas: [Renfe Data · Cercanías](https://data.renfe.com/dataset/ubicacion-vehiculos) y [Renfe Data · AV/LD/MD](https://data.renfe.com/dataset/posicion-vehiculos-av-ld-md), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Posiciones alternativas: datos de **Renfe y ADIF** a través de [RadarDeTrenes](https://radardetrenes.com/docs), servicio independiente; se aplican sus propias condiciones de uso y atribución. Sin garantías de disponibilidad, puntualidad ni cobertura.
- Fondo: [OpenFreeMap](https://openfreemap.org/), © OpenMapTiles y OpenStreetMap; ver sus [condiciones](https://openfreemap.org/tos/). Requiere conexión y WebGL2 y no tiene garantía de disponibilidad.
- [GTFS-Realtime](https://gtfs.org/documentation/realtime/reference/) y sus [recomendaciones de frescura](https://gtfs.org/documentation/realtime/realtime-best-practices/).
- Leaflet 1.9.4, MapLibre GL JS 6.16.0 y el adaptador MapLibre GL Leaflet 0.1.4 se distribuyen con sus licencias en `vendor/`. El worker clásico del HTML autocontenido se generó desde el worker de MapLibre mediante esbuild.
