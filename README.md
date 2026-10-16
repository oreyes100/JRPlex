# JRPlex

Servidor multimedia privado con web propia, usuarios de Jellyfin, bibliotecas locales y nube mediante rclone, y entrada administrativa de magnets/archivos torrent mediante qBittorrent opcional. El gateway mantiene los tokens multimedia en el servidor y entrega al navegador una cookie de sesión opaca. Solo se incorpora a biblioteca el contenido de descargas finalizadas.

**Estado:** primera implementación en evaluación. La instalación o un chequeo sintáctico no prueban publicación, reproducción ni compatibilidad por plataforma. La decisión y evidencia de aceptación viven en [docs/GAUNTLET.md](docs/GAUNTLET.md). No se afirma equivalencia con todas las funciones o aplicaciones de Plex.

## Componentes y compatibilidad

| Componente | Linux / VPS | Windows / macOS |
|---|---|---|
| Web y gateway JRPlex | Node.js 22+, contenedor o nativo | Node.js 22+ nativo |
| Jellyfin | Imagen oficial, configuración persistente | Instalación oficial nativa; Docker no soportado aquí |
| rclone opcional | Montaje del host con FUSE | WinFsp en Windows; macFUSE/FUSE-T o `nfsmount` en macOS |
| qBittorrent opcional | Perfil `torrents`, API privada | App nativa y API en loopback |
| HTTPS público | Proxy existente o perfil Caddy `public` | Caddy/proxy nativo y DNS/entrada de red disponibles |

Se fijaron referencias de release Jellyfin 12.2, Caddy 2.11.7 y LSIO qBittorrent 5.2.4_v2.0.15-ls480 desde sus fuentes oficiales. La presencia de **cada etiqueta de imagen** y su digest se comprueba en el host destino; una referencia documental no sustituye un pull/arranque verificado. Consulte [atribuciones y fuentes](THIRD_PARTY.md).

## Preparar Linux / VPS

Usa una cuenta de servicio no root con Docker/Compose previamente instalado, acceso a sus archivos y una versión compatible de Node. No ejecutes instaladores de terceros a ciegas ni cambies servicios ajenos. El instalador de JRPlex solo crea archivos locales y nunca publica automáticamente.

```sh
node scripts/install.mjs --mode compose
```

Revisa `.env`: `PUBLIC_URL`, `CADDY_DOMAIN`, rutas de medios, espacio para caché y transcodificación. `LOCAL_MEDIA` puede apuntar a un disco local. Monta la nube **antes** de arrancar Jellyfin y haz que `CLOUD_MEDIA` señale el punto de montaje real. `DOWNLOADS_COMPLETE` y `DOWNLOADS_INCOMPLETE` deben ser directorios diferentes. Los puertos del motor y del cliente torrent no se publican en el perfil base; JRPlex escucha en `127.0.0.1:8787` del host.

```sh
node scripts/preflight.mjs --mode compose --images
docker compose build gateway
docker compose -f compose.yaml -f deploy/compose.setup.yaml up -d jellyfin
```

El override de setup abre Jellyfin **solo en loopback** del VPS. Desde el propio VPS o mediante un túnel SSH privado, completa el asistente con una contraseña única de al menos 16 caracteres. Nunca pases la contraseña en argumentos, `.env` ni historial.

```sh
node scripts/bootstrap.mjs --url http://127.0.0.1:8096 --username administrador --local-media /media/local --cloud-media /media/cloud --downloads /media/downloads
```

El script pide la contraseña sin eco, confirma identidad administrativa y cierre del asistente, crea solo las bibliotecas indicadas y rechaza un servidor ya configurado. Si se interrumpe después de fijar contraseña, repite con la misma cuenta; no hace un reset implícito. Los endpoints Startup utilizados siguen presentes en la versión investigada, algunos marcados como obsoletos: el bootstrap requiere prueba real de la versión que instales.

Retira el override recreando servicios con el archivo base antes de publicar. El volumen de datos permanece:

```sh
docker compose up -d --force-recreate jellyfin gateway
node scripts/smoke.mjs --url http://127.0.0.1:8787 --local --username administrador
```

Si `.env` ya usa el dominio HTTPS definitivo, añade `--origin https://tu-dominio` al smoke local. Este chequeo prueba el servicio real; las pruebas pendientes quedan indicadas. Para verificar rangos añade `--item ID_VIDEO_MP4_COMPATIBLE`; repite con usuario ordinario, `--expect-viewer` y `--restricted-item ID_DENEGADO`.

## Publicar HTTPS

Selecciona un VPS/subdominio concreto y verifica DNS A/AAAA, certificado y entrada 80/443. No actives Caddy si esos puertos pertenecen a otro proxy: conecta el proxy existente a `127.0.0.1:8787`, sin exponer Jellyfin. Caddy no lleva access logs para no guardar URLs multimedia sensibles.

Configura `PUBLIC_URL=https://tu-dominio` y `CADDY_DOMAIN=tu-dominio`, y reinicia el gateway para aplicar cookies Secure y control de origen. Solo tras completar bootstrap y pruebas internas, el perfil público independiente se inicia así:

```sh
docker compose --profile public up -d
node scripts/smoke.mjs --url https://tu-dominio --username administrador --item ID_VIDEO_MP4_COMPATIBLE
```

Prueba también desde una red exterior con navegador: acceso, reproducción, búsqueda temporal, audio/subtítulos y cierre de sesión. Confirma que `8096` y `8080` no son accesibles desde fuera. La publicación queda pendiente hasta tener esos resultados; no uses `--insecure` ni desactives validación TLS.

## Nube, torrents y operación

- [Almacenamiento nube y credenciales](deploy/STORAGE.md): configuración cifrada fuera del repositorio, gestor de contraseña separado y montaje read-only con caché acotada.
- [Vincular Google Drive con OAuth](deploy/GOOGLE-DRIVE.md): cliente OAuth propio, consentimiento de solo lectura, configuración cifrada, montaje de servidor y pruebas antes de compartir la biblioteca.
- [Reproducir desde torrent](deploy/TORRENTS.md): selección del vídeo, entrega progresiva de piezas verificadas y limpieza de caché temporal.
- [Enviar a TV, Fire TV y Chromecast](deploy/CASTING.md): botón durante la reproducción, Google Cast y receptor web `/tv` vinculado por código; pausa, búsqueda y regreso al dispositivo.
- [Windows y macOS nativos](deploy/NATIVE.md): mismo gateway, motor nativo y arranque del sistema.
- [Respaldo, restauración y mantenimiento](deploy/OPERATIONS.md): parada consistente, copia privada, verificación en entorno aislado y retirada reversible.

Para elegir las rutas de Drive, abre **Administración → Bibliotecas y nube** y pulsa **Elegir carpeta de películas/fotos/música de Drive**. Entra en la subcarpeta deseada, pulsa **Usar esta carpeta**, revisa nombre, contenido y ruta, y pulsa **Conectar biblioteca**. También puedes escribir la ruta completa que ve Jellyfin, por ejemplo `/media/cloud/Media/Musica`. Cada tipo de contenido se registra por separado; el contenido aparece al terminar su escaneo.

## Límites que se deben validar

JRPlex 0.1 no incluye aplicaciones propias para TV/móvil, DRM, catálogo comercial, TV/DVR, descargas offline ni federación con cuentas Plex. Codec, transcodificación por CPU/GPU, 4K, HDR y número de usuarios simultáneos dependen del host y requieren pruebas. Una fuente remota debe sostener el bitrate y permitir lectura por rangos; pueden existir costes del proveedor, límites de API y expiración de OAuth.

El gateway valida sesiones/administración y permisos de biblioteca, pero Jellyfin ve su IP interna: las restricciones de Jellyfin por **red/IP remota** necesitan diseño y pruebas adicionales antes de usarlas como control de acceso. No confíes en ellas como única barrera. La autenticación estándar no implica MFA; un administrador puede cambiar datos sensibles y debe usar una cuenta separada de la de reproducción.

No conectes directorios de configuración, secretos ni la raíz del sistema como bibliotecas. Usa solo contenido cuya distribución tengas autorizada; un magnet no garantiza disponibilidad, integridad del origen o reproducción inmediata.
