# Corrección local — magnets y carpetas de Google Drive

Fecha: 2026-10-16, America/Mexico_City. Alcance: código local y aceptación funcional controlada. No se desplegó esta revisión ni se modificó ninguna biblioteca real.

## Problemas y correcciones

- El streaming abría el archivo antes de que qBittorrent verificara la primera pieza; en un magnet nuevo el archivo podía no existir. Ahora espera antes de resolver/abrir la ruta. La regresión crea el archivo únicamente al recibir piezas verificadas.
- Un torrent multifichero sin carpeta raíz intentaba abrir el directorio content_path como un archivo. Ahora resuelve el archivo elegido respecto a save_path y conserva el confinamiento por realpath. Admite el sufijo temporal .!qB y rangos de vídeos todavía sin tamaño físico completo.
- Las sesiones podían caducar durante una transmisión en espera. Las transmisiones activas se conservan; el estado consultado por el reproductor mantiene la sesión. La espera sin piezas se limita a 60 segundos. Se priorizan piezas iniciales/finales para metadatos MP4 y se declara Content-Length también en GET completo.
- El navegador ocultaba detalles del error y sobrescribía fallos con una invitación genérica a pulsar play. Ahora consulta un endpoint administrativo de estado, muestra pares/velocidad y conserva errores de almacenamiento, falta de piezas y reproducción; puede reintentar sin eliminar su propia sesión. Se cancela el flujo previo al cambiar de archivo.
- Fotos de Drive se registraba automáticamente en /media/cloud. Ahora los accesos de películas, fotos y música preparan el formulario y abren Drive; cada carpeta se navega o se escribe, se revisa y se guarda explícitamente. Fotografías conserva EnablePhotos. Las bibliotecas existentes permanecen sin modificar.

## Verificación vigente

Node 24.19.0 (el Node 20 del shell no cumple engines del proyecto). La primera ejecución sin escalación no pudo abrir puertos loopback; la ejecución autorizada completa sí pasó. Un fallo inicial de selector en el script de navegador se corrigió y se repitió la aceptación.

| Prueba | Resultado | Evidencia |
|---|---|---|
| Suite completa Node, 64 pruebas | 63 aprobadas, 0 fallidas, 1 omitida opcional (rclone CLI) | .gauntlet/magnet-drive/tests.txt |
| Archivo diferido, multifichero plano, .!qB, lectura parcial, timeout, almacenamiento, cancelación y symlinks | Aprobados | tests.txt, test/torrents.test.mjs |
| Estado administrativo sin acceso anónimo ni usuarios ordinarios | Aprobado | tests.txt, test/gateway.test.mjs |
| MKV sintético → FFmpeg real → MP4 H.264/AAC; decodificación completa | Aprobado; 72/72 cuadros | tests.txt |
| Chrome real: magnet con qB simulado, vídeo sintético y archivo creado después | currentTime avanza >0.25 s | browser.txt |
| Chrome: error persistente de disco, reintento y eliminación al detener | Aprobados; sin errores JavaScript | browser.txt |
| Chrome: elegir y guardar carpetas anidadas separadas para movies/photos/music | Aprobado; ninguna biblioteca automática en la raíz | browser.txt y drive.png |
| Sintaxis, diff y autorrevisión | Aprobados para archivos de esta corrección | review.txt |

Comandos: `node --test test/*.test.mjs` con el runtime Node 24; `JRP_PLAYWRIGHT_MODULE=<módulo Playwright local> node .gauntlet/magnet-drive/browser-check.mjs`. Las herramientas y rutas concretas constan en el registro audit.json.

## Decisión y límites

APROBADO para la corrección y aceptación funcional local: requisitos R1–R3 cubiertos, sin críticos/mayores abiertos. No es una aprobación de funcionamiento en producción. Un swarm real, el magnet específico del usuario, las rutas reales de Drive y la publicación de esta revisión no se comprobaron; no se afirmó reproducción con peers externos. La única omisión de la suite es una comprobación opcional de rclone no relacionada con estos cambios.

El registro reproducible está en .gauntlet/magnet-drive/audit.json. Se preservó el cambio preexistente de public/styles.css.
