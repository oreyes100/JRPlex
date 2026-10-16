# Evidencia de la actualización Google Drive OAuth y torrent — 2026-10-15

## Alcance evaluado

Se simplificó el alta de Google Drive a tres pasos y un comando de servidor, conservando OAuth de solo lectura, configuración cifrada y gestor de credenciales separado. Se cambió el flujo torrent para seleccionar un vídeo y reproducir rangos conforme qBittorrent verifica piezas; la caché permanece temporal y se borra al detener o expirar la sesión. El VPS publica `https://jrplexps.duckdns.org`; nginx no se modificó en esta actualización.

## Integridad y pruebas

| Comprobación | Resultado | Evidencia |
|---|---|---|
| Paquete desplegado | APROBADA | SHA-256 `D4A605B1966CA060BDC5342000A966AA215DC5E902F57CED69197DCA7170633C`; la huella local coincidió con el archivo recibido en `.250`. El paquete tenía 49 entradas y excluyó `.env`, `runtime` y `.cache` |
| Sintaxis JavaScript | APROBADA | `node --check` sobre `server.mjs`, `public/app.js`, `lib/torrents.mjs` y `scripts/google-drive.mjs` |
| Suite local | APROBADA | `node --test test/*.test.mjs`: 32 pruebas, 31 aprobadas, 0 fallidas, 0 canceladas y 1 omitida (la prueba opcional de CLI rclone real) |
| Suite en VPS | APROBADA | Misma suite desde el código desplegado: 32 pruebas, 31 aprobadas, 0 fallidas, 0 canceladas y 1 omitida |
| Compose en VPS | APROBADA | `docker compose --env-file .env config --quiet` |
| Imagen del gateway | APROBADA | Reconstrucción de `jrplex-gateway` completada desde el Dockerfile del proyecto |
| Función torrent simulada | APROBADA | Espera una pieza no verificada, sirve el rango una vez verificado y elimina los archivos temporales al detener. No es una prueba de swarm real |

## Publicación

- `jrplex-gateway` terminó `running/healthy`; `/healthz` respondió `{"status":"ok"}`.
- `https://jrplexps.duckdns.org/` devolvió HTTP 200 con `ssl_verify_result=0`.
- El asset público `/app.js` contiene las secciones “Conectar Google Drive en 3 pasos” y “Reproducir desde torrent”. El navegador abrió el inicio de sesión público; no se inició sesión administrativa para revisar el panel visual.
- Jellyfin y qBittorrent permanecieron `running/healthy` y conservaron sus IDs de contenedor durante la actualización. nginx y los demás vhosts no se tocaron.
- Se guardó una copia privada del código previo en `/home/devops/.cache/jrplex-source-backup-20261015T193623Z`; no incluye el `.env` ni datos de medios.

## Pendiente o bloqueado

| Requisito | Estado y evidencia |
|---|---|
| OAuth real de Google Drive | BLOQUEADA: `node scripts/google-drive.mjs --action check` informó que no existe autorización de solo lectura completa |
| Montaje y reproducción de nube | BLOQUEADA: `runtime/media/cloud` no está montado; no hay vídeo real de Drive indexado o reproducido |
| Torrent real | PENDIENTE: qBittorrent está saludable, pero no se agregó un magnet ni se usó un swarm de prueba; falta confirmar transferencia progresiva y borrado real |
| Interfaz autenticada de administración | PENDIENTE: el servidor entrega el JS nuevo y el login público carga; no se usó una cuenta administradora en el navegador |
| Aceptación general | BLOQUEADA: faltan GA-01–GA-15 en todos los runtimes objetivo, Windows/macOS, restauración operativa y revisión independiente final |

## Corrección detectada durante la verificación

La ejecución de las pruebas en el VPS detectó que el temporizador que esperaba una pieza torrent estaba marcado como prescindible. Node cancelaba la prueba al terminar otros eventos. Se quitó `unref` de ese temporizador y se repitió la suite completa tanto localmente como en el VPS: ambas terminaron con 0 cancelaciones y 0 fallos. Dos verificaciones de publicación intermedias se revirtieron antes de cerrar el cambio; la última publicación pasó la salud del gateway y las verificaciones públicas registradas arriba.

**Decisión para la versión:** BLOQUEADO por las aceptaciones reales de nube/torrent y pruebas operativas pendientes; la publicación HTTPS y las verificaciones automatizadas enumeradas están aprobadas.
