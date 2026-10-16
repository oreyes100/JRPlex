# Diagnóstico y corrección de falsos positivos de vídeo

**Fecha:** 2026-10-16 (America/Mexico_City)
**Versión:** JRPlex 0.1.0, gateway publicado en `.250`
**Defecto:** D15 / requisito R21 de [`../GAUNTLET.md`](../GAUNTLET.md)
**Revisor:** auto-revisión del agente; no hubo revisión independiente.

## Alcance y criterio

El usuario informó que varios títulos de Películas volvían a fallar al reproducirse y pidió diagnóstico causal, detalles de nombre/ruta en la ficha y regresiones repetidas, sin reducir indiscriminadamente la biblioteca.

Para los ejemplos identificados, el criterio fue: no ofrecer como película un archivo fuente que sea declaración TypeScript; mostrar el nombre de archivo y la ruta verdadera en el detalle de administrador; ocultar rutas internas a usuarios ordinarios; conservar archivos de vídeo válidos, incluido `.ts`.

## Evidencia de causa

Se cotejaron los dos IDs reportados en `BaseItems` de la base de datos de Jellyfin y sus errores de FFprobe/FFmpeg en el log de producción:

| Título mostrado | Ruta de origen registrada | Tamaño | Resultado de inspección |
|---|---|---:|---|
| Abs de Pan | `/media/cloud/DESCARGAS/Backup/Asistencias/node_modules/math-intrinsics/abs.d.ts` | 18 bytes | `MediaStreams` vacío; FFprobe no detectó ni streams ni formato; FFmpeg terminó con código 183 |
| Aprobadas en sexología - Report de colegialas nº 3 | `/media/cloud/DESCARGAS/Backup/Asistencias/node_modules/find-up/index.d.ts` | 3,676 bytes | `MediaStreams` vacío; FFprobe no detectó ni streams ni formato; FFmpeg terminó con código 183 |

La causa del falso positivo estaba en el análisis de extensión: `path.extname("abs.d.ts")` devuelve `.ts`. JRPlex acepta `.ts` porque es una extensión válida de MPEG transport stream cuando aún no hay pistas indexadas. Jellyfin había asignado además el tipo `Movie` a estos archivos de código, así que se mostraban con acción de reproducción aunque no fueran medios.

Esta evidencia confirma la causa de esos dos títulos. No prueba que cualquier otro error de reproducción de un vídeo auténtico tenga la misma causa.

## Corrección aplicada

- Se conserva el sufijo compuesto `.d.ts`, `.d.mts` o `.d.cts` como indicación específica; no se convierte en `.ts`.
- El validador excluye esas declaraciones incluso si Jellyfin deja pistas de vídeo obsoletas.
- Las cuentas administradoras ven esos falsos positivos marcados como **“No es vídeo · .d.ts”**, pueden abrir la ficha y consultar el nombre completo, ruta del servidor, tipo, contenedor, tamaño y pistas indexadas. No se ofrece reproducirlos.
- Las cuentas ordinarias no reciben las rutas del servidor. Las pruebas de gateway verifican esta diferencia también en `PlaybackInfo`.
- Se conserva `.ts` real y se mantienen las extensiones de vídeo admitidas, entre ellas MP4, MKV, MTS, M2TS, AVI, MOV, WebM y WMV. No se cambió el límite ni la paginación del catálogo.

## Verificación

| Comprobación | Estado | Resultado |
|---|---|---|
| Elegibilidad `.d.ts`, `.d.mts`, `.d.cts` | APROBADA | Excluidas con y sin metadatos de pistas; `.ts` se mantiene reproducible si Jellyfin todavía no indexó streams |
| Acceso a rutas por rol | APROBADA | Prueba de integración: administrador recibe ruta en `/Items` y `PlaybackInfo`; usuario ordinario no la recibe |
| Suite completa tras los cambios | APROBADA, repetida 5 veces | En cada ejecución: 53 pruebas, 50 aprobadas, 0 fallidas, 3 opcionales omitidas. Ejecutada localmente con Node `--test-isolation=none --test-concurrency=1` por limitación `spawn EPERM` del aislamiento predeterminado de Windows |
| Análisis de sintaxis | APROBADA | `node --check` en `server.mjs`, `lib/security.mjs`, `public/app.js` y `public/media-eligibility.js` |
| Despliegue | APROBADA | `publish-google-drive.ps1 -CodeOnly`: solo se reconstruyó el gateway; `/healthz` devolvió `{"status":"ok"}` |
| Vhost de producción desde `.250` hacia nginx `.34` | APROBADA | `/`, `/privacy`, `/app.js`, `google095fff9fd96bfc8c.html` y `/healthz`: HTTP 200, verificación TLS `0` en cada ruta |
| Activos servidos corresponden a la corrección | APROBADA | La respuesta pública de `/app.js` contiene la etiqueta `.d.ts`; `media-eligibility.js` contiene `isTypeScriptDeclaration` |
| Estado de servicios | APROBADA | `jrplex-gateway-1`, `jrplex-jellyfin-1` y `jrplex-qbittorrent-1` quedaron `running` |
| Reproducción visual de un vídeo auténtico con sesión de usuario | PENDIENTE | El navegador integrado agotó el tiempo al inspeccionar la pestaña. La evidencia de reproducción real anterior sigue en [`google-drive-live-playback-2026-10-15.md`](google-drive-live-playback-2026-10-15.md); no se presenta como prueba de esta sesión |

## Decisión

**APROBADO para D15:** los dos ejemplos reportados se identifican por sus rutas como declaraciones de código y dejan de ofrecer reproducción; el diagnóstico es visible para la cuenta administradora y no expone rutas a usuarios ordinarios. Se desplegó y verificó el código correctivo.
**BLOQUEADO para la aceptación visual general de reproducción:** falta reproducir desde una sesión autenticada un archivo de vídeo válido tras esta publicación. Esta limitación no cambia la causa demostrada de los dos ejemplos anteriores.
