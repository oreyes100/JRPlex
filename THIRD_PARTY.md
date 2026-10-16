# Atribuciones y fuentes

JRPlex es un proyecto independiente que integra servidores de terceros; no es Plex, un producto oficial Jellyfin ni una modificación de su motor. No se copian código, marca, interfaz ni activos propietarios de Plex. Las dependencias conservan sus respectivas licencias, avisos y código fuente disponible en sus repositorios. Una referencia de licencia aquí no reemplaza el texto legal que acompaña a cada distribución.

| Componente | Licencia y fuente | Uso |
|---|---|---|
| Jellyfin Server/Web | [GPL-2.0, repositorio](https://github.com/jellyfin/jellyfin), [licencia](https://github.com/jellyfin/jellyfin/blob/master/LICENSE) | Motor y API independientes; imagen oficial o instalación nativa, sin modificar código en esta entrega |
| qBittorrent | [GPL-2.0-or-later con excepción OpenSSL en fuentes](https://github.com/qbittorrent/qBittorrent/blob/release-5.2.4/src/base/utils/password.cpp), [repositorio](https://github.com/qbittorrent/qBittorrent) | Descargas opcionales mediante API privada |
| LinuxServer qBittorrent container | [Imagen y código de construcción](https://github.com/linuxserver/docker-qbittorrent) | Empaquetado comunitario LSIO, no se presenta como imagen oficial qBittorrent |
| rclone | [MIT, repositorio](https://github.com/rclone/rclone) | Conexión de almacenamiento en el host |
| Caddy | [Apache-2.0, repositorio](https://github.com/caddyserver/caddy) | Proxy HTTPS opcional |
| Node.js | [Licencia Node.js y dependencias](https://github.com/nodejs/node/blob/main/LICENSE) | Runtime del gateway y scripts |
| hls.js | [Apache-2.0, repositorio](https://github.com/video-dev/hls.js) | Reproducción HLS en navegador compatible, activo local y aviso de licencia en public/vendor cuando esté incorporado |

Si distribuyes imágenes/binarios o modificaciones de componentes copyleft, conserva sus avisos y cumple las obligaciones de entrega de fuente correspondientes; el gateway es un proceso separado que consume la API. Mantén el logotipo JRPlex propio y atribución de interoperabilidad según la [política de marca Jellyfin](https://jellyfin.org/docs/general/contributing/branding/).

## Versiones documentadas el 2026-10-15

- Jellyfin: [release v12.2](https://github.com/jellyfin/jellyfin/releases/tag/v12.2).
- Caddy: [release v2.11.7](https://github.com/caddyserver/caddy/releases/tag/v2.11.7).
- Imagen LSIO qBittorrent: [5.2.4_v2.0.15-ls480](https://github.com/linuxserver/docker-qbittorrent/releases/tag/5.2.4_v2.0.15-ls480).

Las etiquetas de registro y digests deben confirmarse con `preflight --images` y el despliegue real. No se afirma que se hayan descargado o arrancado estos contenedores sin evidencia del host destino.

## Documentación primaria de arquitectura y operación

- [Jellyfin contenedores y límites Windows/macOS](https://jellyfin.org/docs/general/installation/container/), [Windows](https://jellyfin.org/docs/general/installation/windows/), [macOS](https://jellyfin.org/docs/general/installation/macos/).
- [Jellyfin health](https://jellyfin.org/docs/general/post-install/networking/advanced/monitoring/), [reverse proxy y protección de logs](https://jellyfin.org/docs/general/post-install/networking/reverse-proxy/), [Caddy](https://jellyfin.org/docs/general/post-install/networking/reverse-proxy/caddy/).
- [API Startup v12.2](https://github.com/jellyfin/jellyfin/blob/v12.2/Jellyfin.Api/Controllers/StartupController.cs), [usuarios](https://github.com/jellyfin/jellyfin/blob/v12.2/Jellyfin.Api/Controllers/UserController.cs), [bibliotecas](https://github.com/jellyfin/jellyfin/blob/v12.2/Jellyfin.Api/Controllers/LibraryStructureController.cs), [PlaybackInfo](https://github.com/jellyfin/jellyfin/blob/v12.2/Jellyfin.Api/Controllers/MediaInfoController.cs).
- [rclone montaje y caché](https://rclone.org/commands/rclone_mount/), [cifrado de configuración](https://rclone.org/docs/#configuration-encryption), [check de cifrado](https://rclone.org/commands/rclone_config_encryption_check/), [obscure no equivale a cifrado seguro](https://rclone.org/commands/rclone_obscure/).
- [qBittorrent API 5.x](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-5.0%29), [PBKDF2](https://github.com/qbittorrent/qBittorrent/blob/release-5.2.4/src/base/utils/password.cpp), [LSIO configuración](https://docs.linuxserver.io/images/docker-qbittorrent/), [LSIO non-root y /run](https://docs.linuxserver.io/misc/non-root/).
- [Caddy HTTPS y requisitos DNS/red](https://caddyserver.com/docs/quick-starts/https).
