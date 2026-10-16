# JRPlex: publicación y estado de Google Drive — 2026-10-15

## Ruta nginx a la aplicación

El operador compartió logs del cambio hecho en nginx de `192.168.1.34`; se registran como evidencia aportada por el operador, no como inspección directa de esa máquina en esta sesión.

```text
Navegador → HTTP :80 (301 HTTPS) / HTTPS :443
           → nginx edge 192.168.1.34
           → HTTPS :443, SNI jrplexps.duckdns.org, con verificación TLS y backend.crt fijado
           → nginx backend 192.168.1.250
           → HTTP loopback :8787
           → contenedor jrplex-gateway → Jellyfin por la red privada Docker
```

Los logs aportados registran un certificado público ZeroSSL ECC instalado en el edge (válido hasta 2027-01-13), renovación automática y `nginx -t` correcto antes de recargar. El edge confía en el certificado público de backend `/etc/nginx/ssl/jrplexps.duckdns.org/backend-pinned.crt`, huella SHA-256 `2A:1E:41:B3:83:91:56:E9:9B:1C:E2:B0:39:9C:C1:C9:D1:93:97:27:50:C4:15:E5:68:65:2E:FC:5E:03:78:8C`; la llave TLS privada del backend permanece en `.250`. El operador reportó HTTP 301, HTTPS 200 con `ssl_verify_result:0` y pruebas 200 de otros vhosts tras el cambio.

Verificación adicional de esta sesión: Chrome abrió `https://jrplexps.duckdns.org/` con el login de JRPlex y sin advertencia TLS. Desde `.250`, curl al dominio respondió `http=200 verify=0`; `curl --cacert deploy/backend.crt --resolve jrplexps.duckdns.org:443:127.0.0.1 https://jrplexps.duckdns.org/healthz` respondió 200. La descarga del asset público `app.js` contiene la sección de vinculación OAuth. No se modificó nginx en esta sesión.

Al terminar las pruebas se recreó solo el contenedor Jellyfin con `compose.yaml` base para cerrar el puerto temporal de configuración. Resultado final: Jellyfin `running healthy`, puerto de loopback 8096 cerrado, gateway `/healthz` responde `{"status":"ok"}` y el dominio público sigue en HTTP 200 con `verify=0`. No se reinició el VPS.

## Estado de la sección de nube

- La página de administración ya muestra “Vincular cuenta Google Drive (OAuth)”, guía el consentimiento mediante rclone Desktop, copia el comando del servidor y el túnel SSH, acepta un ID de carpeta opcional y distingue “Ruta registrada” de OAuth/montaje/reproducción verificados.
- El asistente solicita `drive.readonly`, cifra `rclone.conf` antes de OAuth, suprime diagnósticos y tokens, y rechaza reemplazar un remoto `gdrive` existente. La prueba del parser rclone 1.75.2 pasó en el VPS.
- Comprobación privada en `.250`: `scripts/google-drive.mjs --action check` devuelve que no hay autorización Google Drive de solo lectura. No se mostró ni copió el contenido de la configuración.
- Comprobación privada del host: `pass` no está instalado/configurado; `runtime/media/cloud` no es un punto de montaje y no contiene archivos. Sin OAuth, cuenta remota, gestor separado, montaje, medio indexado ni reproducción cloud.
- Por eso la sección está publicada, pero Google Drive aún no está vinculado ni listo para usuarios. Falta que el propietario configure su cliente OAuth Desktop y el gestor privado del host, acepte la lectura solicitada y ejecute las pruebas reales de montaje y vídeo.

## Pruebas de aplicación relacionadas

El informe de integración sanitizado [`integration-final.json`](integration-final.json) registra 33 pruebas aprobadas, 0 fallidas y 7 pendientes contra Jellyfin 12.2.0 y un medio sintético del VPS. El pipeline real de HLS —incluyendo la ruta de reproducción en minúsculas, manifiestos, init y segmentos— pasó tras corregir la normalización del gateway. La suite remota adicional, con el binario real rclone 1.75.2, pasó 29/29.

qBittorrent figura `healthy` con 0 reinicios; no se completó una descarga torrent. La aceptación visual de la página de administración, el enlace real de Drive, la descarga torrent, Windows/macOS y restauración siguen pendientes.
