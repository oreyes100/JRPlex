# Evidencia: catálogo, fotos, torrents y Google OAuth — 2026-10-16

## Alcance

Iteración de producción solicitada después de que el propietario reportó que la biblioteca de Drive mostraba muy pocos videos, pidió una presentación de fotos y volvió a encontrar HTTP 409 al analizar magnets. También se corrigieron los hallazgos de verificación OAuth de Google: portada detrás del login, política insuficiente y dominio sin verificar.

## Diagnóstico y cambios

- La inspección de solo lectura previa del índice de Jellyfin encontró 71,890 entradas clasificadas como `Movie`, pero solo cinco con pistas `MediaStreams` indexadas. La validación anterior dependía de esas pistas aunque Google Drive podía contener un archivo de video válido cuyo análisis todavía no aparecía en la base.
- `public/media-eligibility.js` ahora permite reproducir formatos de video y audio reconocidos por extensión cuando aún no existen pistas indexadas, mantiene carpetas/contendedores navegables y descarta archivos binarios o imágenes de disco sin formato multimedia. El gateway añade una extensión segura al DTO sin revelar el `Path` local.
- La vista Fotografías añade selección de bibliotecas, navegación por carpetas, mosaicos paginados, visor y secuencia automática cada cuatro segundos. La autorización de miniaturas sigue sujeta al mismo usuario de Jellyfin.
- El cliente de qBittorrent acepta altas HTTP 202 pendientes, reintenta lista de archivos HTTP 404 y prioridades HTTP 409 mientras qBittorrent obtiene metadatos; 20 solicitudes concurrentes del mismo hash comparten una sola alta. La lógica no modifica un torrent ajeno existente.
- La portada pública se sirve en `/`, la aplicación con inicio de sesión en `/app` y la política completa en `/privacy`. La portada explica la función y el alcance de Drive sin exigir sesión. El panel del administrador añade un aviso de privacidad junto al vínculo OAuth.
- Se añadió `scripts/duckdns-google-verification.ps1` y `docs/GOOGLE-VERIFICATION.md`. El script pide el valor TXT de Google y el token DuckDNS de forma interactiva, no guarda ni imprime el token, publica el registro TXT y espera una consulta DNS. No se ejecutó porque requiere el token privado del titular y el nuevo valor que emite Search Console.

## Pruebas y publicación

| Prueba | Resultado |
|---|---|
| `node --check` en los módulos modificados | APROBADA |
| Parseo de los scripts PowerShell de publicación y TXT | APROBADO |
| Suite completa, después de corregir una aserción de prueba que releía un cuerpo ya consumido | 50 tests: 47 aprobados, 0 fallidos, 3 omitidos opcionales |
| Repetición secuencial de la suite completa | 5 de 5 corridas: cada una con 47 aprobados, 0 fallidos y 3 omitidos |
| Publicación code-only a `devops@192.168.1.250` | APROBADA: transferencia 312 KiB, respaldo del código, reconstrucción exclusiva de `gateway`, sin transferir configuración/token OAuth ni activar montaje |
| Health check del gateway después de recrearlo | APROBADO: `{"status":"ok"}` |
| Vhost HTTPS de `.34`, probado desde `.250` con SNI `jrplexps.duckdns.org` | APROBADO: `/`, `/privacy`, `/app`, `/info.css` y `/healthz` devolvieron HTTP 200 y `ssl_verify_result=0` |
| Contenido sin autenticación | APROBADO: portada, política, formulario de login y salud se respondieron sin cookie; marcadores de portada/política/login presentes |
| HTTPS desde esta estación Windows | NO CONCLUYENTE: la conexión fue rechazada localmente antes de llegar al dominio; el chequeo desde `.250` al vhost del proxy sí pasó |

## Resultados pendientes y límites

- La cuenta y el montaje Drive fueron comprobados en evidencia de producción anterior y se conservaron en esta publicación. Falta volver a entrar en la interfaz con sesión autorizada para confirmar que aparecen todos los videos del catálogo; no se usó un nombre ni contenido real de Drive en la suite.
- Producción no tenía una biblioteca `photos` indexada al inicio. La galería pasa pruebas de autorización/helper, pero el administrador todavía debe crear la biblioteca `Fotos de Google Drive`, esperar a que Jellyfin la indexe y abrirla para confirmar carpetas y secuencia con fotos reales.
- Se probó qBittorrent con simulaciones de Web API para los estados 202/404/409; no se agregó el magnet de VisionQuest ni otro magnet real, y no se contactó un swarm. Por ello no se afirma reproducción torrent real.
- La ruta pública y la política responden correctamente, pero Google aún no reconoce la propiedad del dominio. Un Owner/Editor del proyecto de Google Cloud debe verificar `jrplexps.duckdns.org` en Search Console mediante DNS TXT y después enviar la revisión. La propiedad del sitio no se puede acreditar solo porque el HTTPS responda. Google describe los requisitos en [verificación OAuth](https://support.google.com/cloud/answer/13464321?hl=es), [requisitos de portada](https://support.google.com/cloud/answer/13807376?hl=es) y [verificación de dominio](https://support.google.com/cloud/answer/13804266?hl=es); DuckDNS documenta su [API TXT](https://www.duckdns.org/spec.jsp).
- qBittorrent documenta que las altas pueden quedar pendientes y que una respuesta 409 indica altas fallidas en ese request; sus endpoints de archivos/prioridades dependen de que existan metadatos. Ver [WebUI API](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-5.0%29) y [cambios del Web API](https://github.com/qbittorrent/qBittorrent/blob/master/WebAPI_Changelog.md). Las pruebas cubren esos estados simulados, no disponibilidad de pares.
- No se realizaron cambios a nginx `.34`; se verificó el vhost existente según el acceso aprobado previamente. La actualización no reinició el host ni recreó Jellyfin/qBittorrent.

## Decisión

**Correcciones de código y publicación: APROBADAS por pruebas locales y comprobación HTTPS del vhost. Aceptación funcional completa: BLOQUEADA.** Faltan la validación de dominio/revisión en Google, la biblioteca de fotos real, la confirmación del catálogo con sesión y un swarm torrent autorizado. La decisión global Gauntlet continúa `BLOQUEADO`.
