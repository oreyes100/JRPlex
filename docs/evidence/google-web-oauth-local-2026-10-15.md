# JRPlex — OAuth Web de Google, estado local — 2026-10-15

## Alcance y versión

Esta evidencia cubre el cambio local que simplifica el vínculo de Drive a un botón de inicio de sesión de Google y conecta el token cifrado con un montador rclone read-only. El árbol aún no está publicado en `192.168.1.250`; no modifica nginx ni la instancia desplegada.

## Credencial local

El usuario dejó el JSON en Descargas. Una comprobación local imprimió solo estos resultados booleanos: archivo presente, cliente Web, ID con formato Google, secreto presente y callback exacto `https://jrplexps.duckdns.org/api/google-drive/callback`. No se imprimieron, copiaron al repositorio ni adjuntaron los valores del ID o secreto.

## Implementación y controles

- `POST /api/admin/google-drive/connect` requiere sesión administrativa y CSRF. Google recibe `drive.readonly`, `access_type=offline`, `prompt=consent` y `response_mode=form_post`.
- El callback valida state aleatorio de un solo uso, intercambia el código en servidor y redirige a una URL limpia. El código no aparece en la URL de retorno ni en el `Location` final.
- El token persistente usa AES-256-GCM. La clave de 32 bytes, el JSON del cliente y el archivo cifrado quedan en rutas externas al árbol; la clave se guarda en un archivo 0600 en otra carpeta privada. El contenedor recibe cliente/clave read-only y un directorio persistente para token cifrado.
- `google-drive-mount.mjs` configura rclone por variables de entorno de proceso, filtra variables heredadas y fuerza `drive.readonly`, `--read-only` y límites de caché. No escribe un archivo de rclone con secretos.
- La UI mantiene estados distintos para cuenta vinculada, ruta registrada y montaje/reproducción pendientes. El callback de éxito no afirma que un archivo remoto ya funciona.

## Verificaciones ejecutadas

Los tests se ejecutaron directamente por archivo, porque el runner `node --test` no puede crear procesos hijos en el sandbox Windows. Resultado agregado: **41 tests, 38 aprobados, 0 fallidos y 3 omitidos**. Se omitieron dos pruebas del preparador Linux-only por ejecutarse en Windows y una prueba opcional que requiere el binario real de rclone. El detalle de las suites OAuth (3/3), gateway (22/22), entorno/argumentos rclone (1/1) y rclone CLI anterior (8 aprobadas, 1 omitida) se puede repetir desde `JRPlex/test/` con `node <archivo.test.mjs>`.

`node --check` pasó para 25 archivos JavaScript. El JSON local pasó la comprobación de estructura y callback sin mostrar valores. Docker Compose no está instalado en este equipo; tampoco hay parser YAML disponible. WSL rechazó el acceso. Por ello no se validó `docker compose config` ni se ejecutó el montador FUSE.

## Pendiente y decisión

No se transfirió el JSON ni la nueva versión al VPS. El publicador PowerShell está preparado y su AST pasa; la prueba SSH no interactiva recibió `Permission denied (publickey,password)`, pues este perfil no tiene una llave disponible. El destino remoto es `/home/devops/.config/jrplex/google-web.json`; al ejecutar el publicador, OpenSSH puede pedir autenticación interactiva. Después faltan el consentimiento real en Google, validar el servicio rclone/FUSE, escanear una carpeta autorizada y reproducir/buscar un archivo real. La clave queda como archivo privado separado; integración con un gestor externo del sistema operativo y revisión independiente siguen pendientes.

No se usó el magnet de ejemplo ni se contactó un swarm. Decisión Gauntlet de esta iteración: **BLOQUEADO** por publicación y verificaciones reales pendientes; las pruebas locales aprobadas no prueban producción.
