# Evidencia de Google Drive en producción — 2026-10-15

## Alcance

Verificación de la conexión Google Drive de JRPlex en `devops@192.168.1.250`, después de que el propietario completó el flujo desde el navegador. Se registran resultados funcionales sin incluir correo, nombres de archivo, identificadores OAuth, secretos, tokens ni rutas privadas de la nube.

## Evidencia

| Requisito | Resultado observado |
|---|---|
| OAuth y privilegio | El estado del gateway reportó cuenta Google vinculada. El token utilizable incluye el scope `https://www.googleapis.com/auth/drive.readonly`; rclone pudo consultar metadatos de Drive y abrir el medio de prueba. El refresh token se almacena cifrado AES-256-GCM fuera del repositorio, con una clave privada separada. |
| Montaje | `jrplex-google-drive.service` está `active`; `mountpoint` confirmó el mount del host. FUSE informa `fuse.rclone` y opciones `ro,nosuid,nodev`; el marcador de estado contiene `active`. |
| Servicios | `jrplex-gateway`, `jrplex-jellyfin` y `jrplex-qbittorrent` reportaron `Up`/`healthy` en la consulta posterior; no se reinició el host. |
| Índice de nube | La biblioteca `Google Drive` existe en Jellyfin y el vídeo remoto de prueba quedó indexado. El contenedor verificado era MP4, H.264/AAC, tamaño 196,797,912 bytes y duración 153.002667 s. No se registra su nombre ni ubicación. |
| Reproducción por rango | JRPlex respondió `206 Partial Content`, `Content-Type: video/mp4`, `Content-Range: bytes 0-65535/196797912`; se leyeron 65,536 bytes desde Drive a través del servidor. No se descargó el archivo completo para esta prueba. |
| Suite VPS | `node --test --test-reporter=spec test/*.test.mjs`: 43 tests, 42 aprobados, 0 fallidos, 1 omitido (comprobación opcional del CLI real). |

## Consentimiento visible

El propietario informó que inició sesión en Google y regresó a JRPlex, pero no distinguió una pantalla separada de autorización. El servidor demuestra que Google entregó un grant efectivo con `drive.readonly` y que los datos remotos se pudieron leer; el servidor no puede demostrar qué texto o botones vio el usuario. El generador de autorización de JRPlex envía `prompt=consent`. Google documenta que este parámetro debe mostrar la pantalla de consentimiento en cada solicitud de autorización. Por tanto, el permiso backend quedó verificado, pero la experiencia visual reportada no.

Google Drive no entrega la contraseña a JRPlex. `drive.readonly` permite leer el Drive visible para la cuenta vinculada; una cuenta separada con acceso solo a la carpeta multimedia reduce el alcance.

## Límites de esta evidencia

- La CUA de esta sesión no pudo inspeccionar el navegador autenticado; la ausencia de la pantalla proviene del reporte del propietario.
- El chequeo HTTPS repetido desde esta estación falló antes de llegar al dominio porque su proxy local en `127.0.0.1:443` rechazó la conexión. Un chequeo anterior en esta sesión ya había obtenido HTTP 200 con validación TLS correcta y el operador mantiene el vhost nginx publicado.
- No se probó swarm torrent, Windows/macOS, restauración ni revisión independiente en este registro.
- Esta evidencia acredita el acceso efectivo y reproducción por rango, no la percepción humana de la pantalla Google.

## Resultado

**Google Drive: APROBADO técnicamente.** Scope de solo lectura, cifrado, mount read-only, indexación y lectura de vídeo real quedaron verificados en producción. La observación de consentimiento visual queda explícita; el Gauntlet global de JRPlex continúa BLOQUEADO por requisitos de aceptación ajenos y pendientes indicados en [`../GAUNTLET.md`](../GAUNTLET.md).
