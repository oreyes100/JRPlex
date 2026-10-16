# Evidencia de autenticación qBittorrent y bloqueo OAuth — 2026-10-15

## Alcance

Hotfix de la etiqueta “No disponible” en Torrents y revisión de la petición de inicio de sesión directo de Google. No se modificó nginx. No se agregó ningún torrent ni se contactó el magnet de VisionQuest compartido por el usuario.

## Causa y corrección de qBittorrent

El contenedor `jrplex-qbittorrent-1` estaba `healthy`, pero el gateway no podía autenticarse. El API de qBittorrent 5.2.4 respondió HTTP 204, sin cuerpo, con la cookie de sesión `QBT_SID_8080`. JRPlex exigía la respuesta antigua HTTP 200/`Ok.` y una cookie con nombre `SID`, por eso ocultaba la causa y reportaba “No disponible”.

La corrección en `lib/torrents.mjs` acepta las respuestas compatibles 200/204, valida las cookies antiguas y nuevas y conserva el fallo como mensaje seguro. `server.mjs` comunica el diagnóstico controlado al panel de administración, que diferencia servicio sin configurar de servicio sin conexión. `public/app.js` explica también el timeout de metadatos/piezas cuando el swarm no responde.

## Verificaciones

| Prueba | Estado | Evidencia |
|---|---|---|
| Sintaxis de `server.mjs`, `lib/torrents.mjs`, `public/app.js` y `test/torrents.test.mjs` | APROBADA | `node --check` local |
| Suite en directorio temporal de VPS, antes de publicar | APROBADA | 34 pruebas; 33 aprobadas, 0 fallidas, 0 canceladas, 1 omitida opcional |
| Suite de la fuente publicada en `.250` | APROBADA | 34 pruebas; 33 aprobadas, 0 fallidas/canceladas, 1 omitida |
| qBittorrent 5.2.4 autenticado desde el código recién desplegado | APROBADA | `createTorrentClient(loadConfig()).health()` devolvió `live-qb-auth=ok`; no agregó magnets |
| Estado de gateway, Jellyfin y qBittorrent | APROBADA | Los tres `healthy`, reinicios 0; Jellyfin y qBittorrent conservaron sus IDs. Solo se recreó gateway |
| Sitio público y TLS | APROBADA | `https://jrplexps.duckdns.org/` respondió HTTP 200 y `tls_verify=0`; `/healthz` devolvió `{"status":"ok"}` |
| Prueba de magnet/swarm real | PENDIENTE | No se agregó ningún magnet; falta un swarm autorizado y la comprobación de borrado real |
| Suite local en Windows | BLOQUEADA | El runner no pudo iniciar procesos hijos por `spawn EPERM`; la suite completa sí pasó en Linux/VPS |

Se guardó una copia del código anterior en `/home/devops/.cache/jrplex-qb-authfix-backup-20261015T2047Z`. No se imprimieron ni copiaron credenciales. El magnet del usuario no se probó.

## OAuth web de Google

La comprobación de presencia de archivos privados encontró que el VPS aún no tiene un cliente Google OAuth Web ni Desktop configurado. No se leyeron sus contenidos. El usuario quiere que el administrador pulse un botón, vaya a Google y vuelva a JRPlex sin comandos o túnel. Para hacerlo se necesita un cliente OAuth Web registrado con `https://jrplexps.duckdns.org/api/google-drive/callback`; esta dependencia no se puede sustituir por credenciales de la cuenta Google. No hay consentimiento ni montaje `/media/cloud`.

El usuario recibió una pregunta de seguimiento para confirmar si puede preparar ese cliente o necesita ayuda. La ruta privada prevista es `/home/devops/.config/jrplex/google-web.json`. Hasta que se resuelva, OAuth web, token cifrado/montaje y reproducción de Drive quedan BLOQUEADOS. La contraseña de Google, client secret y tokens no deben compartirse por chat.
