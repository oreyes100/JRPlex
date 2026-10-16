# Evidencia: elegibilidad y reproducción de medios de Drive — 2026-10-15

## Problema y diagnóstico

El usuario informó que los elementos de Google Drive no iniciaban en ninguna calidad. La entrada mostrada en el reproductor resolvía a un archivo `.bin` de firmware, no a una película. La respuesta de Jellyfin tenía `MediaStreams` vacío y `MediaSources` sin formato; FFprobe devolvió `Invalid data found when processing input`, y FFmpeg terminó con código 183. La biblioteca de Drive contenía archivos generales del Drive (incluidos binarios y respaldos) que Jellyfin había clasificado como películas.

La falla observada no demostraba un fallo general de Google Drive ni del transcodificador. Se comprobó también un MP4 real de la misma unidad remota: H.264/AAC, 1280×720, 153.002667 s. A través del gateway JRPlex, `PlaybackInfo` respondió 200, HLS y su lista hija respondieron 200, el primer segmento y el segmento de inicialización respondieron 206; la reproducción original por rango respondió 206 con `Content-Type: video/mp4`. La prueba HLS se detuvo al finalizar.

## Corrección publicada

- El catálogo solicita a Jellyfin `MediaStreams` y `MediaSources` y omite elementos que no contienen una pista real de vídeo o audio.
- Se aplica el mismo filtro a resultados, elementos reanudables, páginas siguientes y episodios; carpetas y contenedores de navegación siguen accesibles.
- El detalle y la acción de reproducir vuelven a validar las pistas antes de ofrecer o iniciar la reproducción.
- El servidor ahora entrega `app.js` como módulo y el módulo de elegibilidad desde el mismo origen.
- El despliegue usó `deploy/publish-google-drive.ps1` sin activar ni reiniciar el montaje. Solo se reconstruyó el gateway. El respaldo privado del código se creó en el VPS; las credenciales y `runtime` quedaron fuera del paquete.

## Verificación posterior al despliegue

| Comprobación | Resultado |
|---|---|
| Unit tests de elegibilidad | 3 aprobados, 0 fallidos: película con vídeo, fallback a streams de fuente, audio y contenedores; `.bin` sin pistas se excluye |
| Assets de producción | `/` 200; `/app.js` 200 `text/javascript`; `/media-eligibility.js` 200 `text/javascript`; HTML carga el reproductor como módulo |
| Gateway | `healthz` respondió `{"status":"ok"}`; el contenedor quedó saludable tras la publicación |
| Suite completa en VPS | 47 tests, 46 aprobados, 0 fallidos, 1 omitido; salida en `/tmp/jrplex-playback-tests.log` del VPS |
| Drive | Servicio de montaje activo; `fuse.rclone` con `ro,nosuid,nodev` |
| Navegador | No verificado visualmente en esta sesión: la conexión CUA expiró antes de inspeccionar la pestaña. El propietario debe recargar la página publicada para recibir el módulo nuevo. |

## Resultado

**Corrección técnica del reproductor de Drive: APROBADA en servidor y pruebas automatizadas.** El archivo que originó el reporte no es reproducible y ya no debe mostrarse como película; un MP4 válido de Drive ya pasó reproducción original y HLS a través del gateway. No se afirma una verificación visual en navegador. La decisión global de JRPlex permanece `BLOQUEADO` por requisitos de aceptación pendientes que se enumeran en [`../GAUNTLET.md`](../GAUNTLET.md).
