# Google Drive por inicio de sesión web

El administrador pulsa **Vincular Google Drive**, inicia sesión en Google y autoriza el alcance de solo lectura; Google devuelve al navegador a JRPlex. No se pide la contraseña de Google en JRPlex. El callback usa `response_mode=form_post`; el código de autorización no viaja en la URL que registran los access logs habituales. El request incluye `prompt=consent`. Google documenta que debe mostrar consentimiento en cada solicitud que incluya ese parámetro; el callback y la lectura exitosa prueban el permiso efectivo, pero no qué pantalla alcanzó a ver el usuario.

## Preparación única del VPS

El JSON está en Descargas local; el destino privado en el VPS es `/home/devops/.config/jrplex/google-web.json`. Desde PowerShell en la raíz del repositorio, ejecuta el publicador preparado:

```powershell
.\JRPlex\deploy\publish-google-drive.ps1
```

Si hay varios clientes OAuth en Descargas, indica el correcto con `-ClientJson 'C:\ruta\exacta\client_secret_....json'`. El publicador valida el JSON sin mostrar sus valores, lo transfiere por SCP, guarda un respaldo del código y runtime permanece fuera del paquete. Si el mismo cliente ya está en el VPS, solo continúa cuando el archivo coincide exactamente; nunca lo sobrescribe con otro. El preparador valida el tipo **Web** y callback exacto `https://jrplexps.duckdns.org/api/google-drive/callback`; crea la clave AES privada en `/home/devops/.local/share/jrplex/secrets/google-drive.key` y el estado en `/home/devops/.local/share/jrplex/google-drive`. Solo reconstruye el gateway y comprueba `/healthz`; conserva `.env` y `runtime/`. El publicador usa OpenSSH de Windows y puede solicitar la contraseña SSH en la terminal; escríbela solo allí, nunca en el chat. Limpia la copia temporal del VPS incluso si la publicación falla.

Para publicar solo una nueva versión del código cuando el cliente OAuth y el montaje ya existen, ejecuta el publicador sin transferir ni preparar credenciales:

```powershell
.\JRPlex\deploy\publish-google-drive.ps1 -CodeOnly
```

Este modo no busca ni lee el JSON OAuth local; conserva los secretos, tokens, `.env`, montaje y servicios multimedia, y reconstruye únicamente `gateway`.

Después de vincular Google en el navegador, vuelve a ejecutar el publicador con `-EnableCloudMount` para instalar y activar la unidad FUSE, por ejemplo `./JRPlex/deploy/publish-google-drive.ps1 -EnableCloudMount`. El servicio monta en el host y comparte FUSE con Jellyfin. El gateway no recibe el volumen FUSE; solo lee un marcador de estado escrito por systemd después de verificar el montaje.

Recrea solo el gateway con los montajes secretos:

```sh
cd /home/devops/JRPlex
docker compose -f compose.yaml -f deploy/compose.google-drive.yaml config --quiet
docker compose -f compose.yaml -f deploy/compose.google-drive.yaml up -d --build --no-deps gateway
```

Entra como administrador, abre **Administración → Bibliotecas → Contenido en la nube** y pulsa **Vincular Google Drive**. Termina el acceso en la página oficial de Google. El refresh token se guarda cifrado AES-256-GCM; la clave está en un archivo distinto y el gateway solo ve el cliente y la clave como archivos de solo lectura. El volumen multimedia se monta en Jellyfin; no expongas los archivos OAuth por nginx.

## Montar Drive en solo lectura

Instala rclone y FUSE desde sus fuentes oficiales. Tras completar OAuth, inicia el montador en primer plano para validar el primer acceso. Requiere que `/home/devops/JRPlex/runtime/media/cloud` exista y esté vacío:

```sh
cd /home/devops/JRPlex
node scripts/google-drive-mount.mjs \
  --rclone /home/devops/JRPlex/runtime/tools/rclone-v1.75.2-linux-amd64/rclone \
  --mount /home/devops/JRPlex/runtime/media/cloud \
  --cache /home/devops/.cache/jrplex/google-drive
```

El helper descifra el refresh token en memoria y configura el remoto `gdrive:` para rclone mediante variables de entorno del proceso. Impone `drive.readonly`, `--read-only` y caché temporal limitada. Solo reenvía errores de rclone al registro de systemd, no los secretos ni el entorno de proceso. No escribe un `rclone.conf` en claro. La clave AES es un archivo privado independiente; resguárdala separada del token cifrado.

Para mantenerlo tras reinicios, comprueba que `JRP_UID` y `JRP_GID` en `.env` coincidan con `id -u devops` y `id -g devops`. La unidad de systemd espera a que `mountpoint` confirme FUSE y luego escribe el marcador `active`; lo elimina al detenerse. No habilites `--allow-other`; el UID del montador y Jellyfin deben coincidir. El volumen `/media/cloud` se comparte con Jellyfin con propagación `rslave`; el gateway no se monta sobre el árbol FUSE.

Con el montaje activo, pulsa **Preparar ruta /media/cloud** y registra la biblioteca. “Ruta registrada” solo significa que la ruta está configurada; el estado de montaje viene del marcador systemd y la reproducción se confirma aparte. Antes de autorizar usuarios, comprueba `mountpoint`, lista un archivo de vídeo autorizado, fuerza un escaneo de biblioteca y reproduce/busca en el navegador.

## Límites

- `drive.readonly` cubre todo el contenido visible en esa cuenta Google. Para reducir exposición, usa una cuenta dedicada que solo tenga acceso a la carpeta de medios.
- Si la interfaz de Google solo parece iniciar sesión, verifica por separado el estado de conexión y la reproducción de un archivo. La app solicita `prompt=consent`, pero el backend no puede acreditar qué pantalla vio el usuario.
- Una carpeta vacía, un refresh token o una ruta registrada no prueban reproducción. Cuota, latencia, archivos grandes y formatos deben probarse con un vídeo real autorizado.
- El flujo web y el montador descritos aquí son para Linux/VPS. Windows/macOS requieren probar el gestor de credenciales, el driver FUSE y la identidad de sus servicios por separado.
- La desconexión o revocación en Google puede invalidar el token. Después de volver a vincular, reinicia el servicio de montaje.

Fuentes oficiales: [OAuth de servidor web de Google](https://developers.google.com/identity/protocols/oauth2/web-server), [modos de respuesta OAuth admitidos por Google](https://developers.google.com/identity/openid-connect/reference), [Drive en rclone](https://rclone.org/drive/), [configuración de rclone por entorno](https://rclone.org/docs/#environment-variables), [rclone mount](https://rclone.org/commands/rclone_mount/).
