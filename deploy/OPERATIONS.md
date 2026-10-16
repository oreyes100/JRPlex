# Operación, respaldo y recuperación

No se necesita acceso de la aplicación al socket Docker, al disco completo ni a credenciales SSH/DNS. Solo el operador ejecuta comandos de mantenimiento. Los perfiles Compose son optativos y los datos son bind mounts; `down` no borra sus directorios. No uses `down -v`, `prune`, `reset --hard` o borrados recursivos como rutina de recuperación.

## Salud y espacio

- Gateway: `/healthz` solo verifica que el proceso HTTP responde. La prueba `scripts/smoke.mjs` valida además login, sesión, catálogo, CSRF, cierre y opcionalmente rangos contra un motor real.
- Motor: `/health` comprueba HTTP y base de datos. Da margen durante migraciones/arranque; el Compose aplica 180 segundos iniciales. Un proceso saludable no demuestra que un disco o la nube estén montados.
- Controla disco libre en configuración, caché de transcodificación, caché rclone e incompletos/completos. La imagen se limita en privilegios y número de procesos, pero el presupuesto de CPU/memoria y concurrencia debe ajustarse a la capacidad real del VPS.
- No captures URLs completas de medios en access logs ni publiques los logs del cliente torrent. Configuración qBittorrent, SQLite Jellyfin y backups pueden incluir secretos, historial o hashes de contraseña.

## Respaldo consistente

Antes de actualizar, registra la versión de fuente de JRPlex y los digests de imágenes realmente ejecutadas. Los resultados de `docker compose images` y `docker image inspect --format '{{index .RepoDigests 0}}' IMAGEN` no contienen contraseñas; no adjuntes `docker inspect` completo ni `docker compose config` completo si se incorporaron otras configuraciones sensibles.

1. Detén gateway y motor Jellyfin, y qBittorrent si estaba activado. No cierres un motor que está migrando a la fuerza. Para Compose usa `docker compose --profile public --profile torrents stop`; para nativos usa los controles de cada servicio.
2. Copia a un destino privado la carpeta `runtime/jellyfin/config`, configuración qBittorrent, datos Caddy y una copia de `.env`. Incluye los archivos de credenciales de servicio solo dentro de un backup cifrado. Los medios y las descargas completas requieren su política de backup propia; la caché no suele necesitar copiarse.
3. La configuración rclone cifrada y su contraseña/gestor se respaldan **por separado**, fuera del repo. Perder la contraseña hace irrecuperable esa configuración. Las credenciales OAuth pueden requerir nueva autorización incluso tras restaurar el archivo.
4. Cifra la copia con una herramienta revisada y una clave separada; comprueba lectura/integridad sin mostrar secretos. Conserva fecha, versión y hash del archivo cifrado en el registro de operaciones.
5. Arranca únicamente los perfiles que se usaban y ejecuta smoke. Las sesiones JRPlex están en memoria: los usuarios deberán iniciar sesión de nuevo tras reiniciar el gateway.

El procedimiento depende de los directorios reales de `.env`; no respaldes únicamente `./runtime` si cambiaste `JRP_DATA_DIR`. La copia de una base SQLite en uso no se da por consistente por el mero hecho de que el comando de copia termine.

## Restauración verificable

Restaura primero en **otra carpeta, otro nombre Compose y puertos loopback libres**, sin tráfico público. Copia el backup a directorios nuevos vacíos, restaura propietarios/permisos de la cuenta de servicio y usa las mismas versiones/digests que lo produjeron. Evita arrancar dos motores sobre la misma base SQLite o dos clientes torrent sobre sus mismos datos. Nunca extraigas un archivo de backup no inspeccionado sobre la raíz del sistema.

Comprueba cierre del asistente, login, usuario ordinario, bibliotecas, medios locales/nube, reproducción con búsqueda y cierre de sesión. Solo tras aprobar la prueba de restauración puede cambiarse el tráfico al entorno recuperado. Conserva el original para rollback. Una actualización puede migrar el esquema; volver a una imagen anterior sin restaurar el backup previo puede fallar o corromper datos.

## Actualizar y retirar

Fija releases o digests; revisa changelog y avisos oficiales, respalda de forma consistente y prueba en una copia aislada antes de recrear servicios. No hay actualizador desatendido que cambie versiones mientras se reproduce contenido. Después repite pruebas afectadas y registra resultados reales en Gauntlet.

Para retirar el servicio, detén los perfiles, desconecta solo su ruta/subdominio del proxy y conserva configuración/medios y backup. Revoca OAuth y credenciales que ya no se utilicen mediante sus proveedores. La desinstalación no debe borrar discos externos, archivos de nube ni servicios ajenos.

## Aceptación pendiente por entorno

Sin ejecución real no se consideran aprobados: pull/arranque Compose, escritura en estado bajo UID no root, caché/transcodificación, montaje FUSE/NFS/WinFsp, nube con credenciales, torrent finalizado, reproducción en cada navegador/sistema, restauración y publicación DNS+TLS exterior. Los tests de software con dobles de prueba no sustituyen estas verificaciones.
