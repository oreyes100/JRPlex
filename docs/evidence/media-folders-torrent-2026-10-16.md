# Evidencia — filtros de medios, carpetas y transmisión torrent

**Fecha:** 2026-10-16 (America/Mexico_City)  
**Versión:** JRPlex 0.1.0, gateway publicado en `192.168.1.250`; borde nginx `192.168.1.34` sin cambios  
**Revisión:** auto-revisión de Codex; la revisión visual autenticada del navegador agotó el tiempo de espera.

## Alcance y criterios

1. Las declaraciones `.ts`, `.d.ts`, `.d.mts` y `.d.cts` no aparecen ni se ofrecen como vídeo; MP4, MKV, AVI y MP3 conservan su elegibilidad según tipo de biblioteca.
2. Los usuarios exploran y buscan dentro de las bibliotecas Jellyfin que tienen autorizadas. El administrador puede elegir una carpeta local o de Google Drive para registrar una biblioteca.
3. La reproducción torrent espera a que la primera pieza se verifique; los contenedores que el navegador no reproduce directamente se convierten a MP4 fragmentado.
4. Producción conserva gateway, Jellyfin, qBittorrent y HTTPS saludables; no se modifica nginx ni se reinician los motores multimedia.

## Hallazgos de producción

Consulta de solo lectura a `jellyfin.db` en el VPS: 14,912 entradas de vídeo MP4, 115 MKV, 447 AVI, 5,762 `.ts` y 47,722 falsas entradas `.d.ts`; no había entradas Audio `.mp3` ni una vista/carpeta MusicAlbum registrada. Esto explica por qué las declaraciones contaminaban las primeras páginas y por qué MP3 no podía aparecer en Música: el formato sí está admitido, pero la instancia no tiene archivos MP3 indexados ni una biblioteca con su carpeta.

El gateway de producción no contenía FFmpeg. El cliente torrent entregaba el contenedor original al elemento `<video>` y enviaba cabeceras 200 antes de esperar la primera pieza, lo que podía dejar el navegador cargando en un swarm sin piezas o con un contenedor no compatible.

## Correcciones

- Se excluyó `.ts` de elegibilidad multimedia y de las opciones de torrent. `.d.ts`, `.d.mts` y `.d.cts` siguen excluidos incluso si quedan pistas obsoletas en Jellyfin. Los falsos positivos dejaron de mostrarse como tarjetas de diagnóstico; el detalle administrativo conserva nombre y ruta para elementos reproducibles.
- Se añadió la vista **Carpetas**. Enumera las vistas que Jellyfin expone a la cuenta actual; navegar y buscar usa `ParentId` y restringe resultados a esa biblioteca y sus subcarpetas. La paginación conserva todo el catálogo.
- El selector de bibliotecas es exclusivo del administrador y limita orígenes a `/media/local` y `/media/cloud`. Rechaza `..`, separadores en nombres y orígenes distintos. Para Drive consulta el endpoint autenticado `Environment/DirectoryContents` de Jellyfin; no monta FUSE en el gateway.
- La primera descarga torrent espera a que la primera pieza tenga estado verificado antes de responder. MKV, AVI y otros contenedores no ofrecidos directamente como MP4/WebM pasan por FFmpeg a MP4 fragmentado H.264/AAC. Se muestran estados de espera/error en el reproductor; no se ignora la promesa `play()`.
- Se instala FFmpeg en la imagen gateway; nginx, qBittorrent y Jellyfin no se reconstruyen.

## Verificaciones

| Verificación | Resultado | Evidencia |
|---|---|---|
| Elegibilidad `.ts`/`.d.ts` y formatos MP4/MKV/AVI/MP3 | APROBADA | Pruebas de `media-eligibility.test.mjs`; `.ts` ya no es válido ni como item de Jellyfin ni en las opciones de torrent |
| Autorización, recorrido por raíz/carpeta, filtro y rechazo de `..` | APROBADA en prueba de API | `gateway.test.mjs`; Jellyfin real respondió 401 al endpoint sin credenciales, como se esperaba. La navegación autenticada no se verificó visualmente |
| Pruebas de regresión completas | APROBADA, 5/5 ejecuciones | En cada ejecución: 55 pruebas, 52 aprobadas, 0 fallidas, 3 opcionales omitidas |
| Prueba sintética del manejador de MKV | APROBADA | Mock de qB descarga pieza 0 y FFmpeg de prueba emite MP4 fragmentado; `torrents.test.mjs` valida HTTP 200, `video/mp4` y H.264/AAC sintéticos |
| FFmpeg instalado y encoder disponible en VPS | APROBADA | `ffmpeg -encoders` encontró `libx264` y `aac` dentro de `jrplex-gateway-1` |
| Canal real de conversión en el contenedor publicado | APROBADA, contenido sintético | Se generó un MKV de 146,292 bytes dentro de gateway; se pasó por `createTorrentClient.stream()` con estados de piezas verificadas y se obtuvo MP4 de 165,591 bytes. `ffprobe` identificó H.264, AAC y contenedor MOV/MP4 |
| Salud y publicación HTTPS final | APROBADA | `gateway`, `jellyfin` y `qbittorrent` en `running`; gateway `healthy`. `/`, `/privacy`, `/app.js`, `/styles.css`, el HTML de Search Console y `/healthz`: HTTP 200, `ssl_verify_result=0` |
| Reproducción de un magnet con peers reales | PENDIENTE | No se contactó un swarm ni se añadió contenido a qBittorrent durante esta prueba. La ruta se comprobó con proveedor qB simulado y medio sintético |
| MP3 de Drive/local visibles en Música | BLOQUEADA por configuración de ruta | La base no contiene MP3 indexados ni biblioteca Music. Hace falta elegir la carpeta correcta con el nuevo selector y completar el escaneo de Jellyfin; no se inventó una ruta |
| Inspección visual con sesión administrativa/usuario | BLOQUEADA | La enumeración de ventanas del navegador y la captura de estado de Computer Use agotaron tiempo de espera; no se declara una prueba de interfaz aprobada |

## Incidente de publicación y recuperación

El primer intento añadió montajes bind locales/Drive al gateway y Compose rechazó la recreación con `permission denied` al consultar la raíz FUSE. No se alteró el punto de montaje ni se cambió nginx. Se retiraron esos montajes y el selector pasó a solicitar directorios por la API autenticada de Jellyfin. La republicación solo-código siguiente y la final reconstruyeron únicamente el gateway y terminaron con `healthz: ok`.

## Estado de Google OAuth reportado por el usuario

El usuario pegó el estado de Google que indica marca verificada y publicada, app en producción, usuarios externos y límite mostrado 0/100. Se registra como información aportada por el usuario; no se comprobó en Google Cloud durante esta iteración y no fue necesario modificar OAuth para estos defectos.

## Decisión

**BLOQUEADO** para aceptación global: las correcciones locales y la conversión sintética están desplegadas y verificadas, pero no hay evidencia de reproducción de un magnet con peers, MP3 indexados bajo una ruta real ni prueba visual autenticada. El criterio de catalogación `.ts` corregido queda aprobado por pruebas; los criterios de música y la reproducción torrent en vivo siguen pendientes.
