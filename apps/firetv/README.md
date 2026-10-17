# JRPlex TV 2.1.0 · cliente autónomo Fire OS

La app abre y reproduce tu biblioteca con el mando: películas, series y temporadas, álbumes/pistas, fotos agrupadas por fecha, búsqueda, paginación y continuar donde lo dejaste. También ofrece orden por nombre, tipo y carpetas. El teléfono se usa para vincular la cuenta una vez; después puedes cerrarlo. Media3 reproduce el contenido desde el servidor, sin PC, Silk, WebView, Google Play Services ni Fling. Requiere API23+ (Fire OS6+); **Vega OS no admite esta APK**.

## Instalar o actualizar

[APK2.1.0 y firma](https://github.com/oreyes100/JRPlex/releases/tag/firetv-v2.1.0) · [Instalación desde Downloader](https://jrplexps.duckdns.org/firetv). Instala encima de la versión2.0.0 o anterior: mismo paquete `org.jrplex.tv`, misma clave de firma y `versionCode=3`. No hace falta desinstalar.

```sh
adb connect IP_DE_TU_FIRE_TV:5555
adb install -r jrplex-firetv-2.1.0.apk
adb shell am start -n org.jrplex.tv/.BrowseActivity
```

Abre **JRPlex TV** y escanea el QR con el teléfono. También puedes abrir `https://jrplexps.duckdns.org/activate` y escribir el código de ocho caracteres que aparece en la TV. Confirma la pantalla e introduce tus credenciales JRPlex **en el teléfono**; el gestor de contraseñas puede rellenarlas. Se crea un acceso independiente para la TV. El QR no contiene la contraseña ni el acceso de la cuenta. No necesita que el navegador del teléfono permanezca abierto ni que conserve su sesión.

Al abrir nuevamente la app o reiniciar el servidor se restaura el acceso de TV; dura 30 días. En **Cuenta → Desvincular esta TV** se revoca solo ese dispositivo. Cambiar servidor también elimina el acceso anterior. Cerrar sesión en la web no cierra la TV. Cambiar la contraseña de la cuenta desde JRPlex o desactivarla sí revoca sus accesos. El límite es20 TVs por cuenta.

Usa **Inicio, Continuar, Películas, Series, Música, Fotos, Buscar** con el mando. Las carpetas y temporadas se abren; los títulos permiten reproducir o continuar su avance. Atrás guarda el avance y vuelve a la biblioteca; ir al inicio de Fire TV detiene/revoca la transferencia y libera el decoder, conservando el acceso a la cuenta. Se registra el avance aproximadamente cada10segundos y al detener. La disponibilidad real del contenido depende de la biblioteca y permisos de esa cuenta.

La función opcional **Cuenta → Recibir un envío** conserva el receptor por código de seis dígitos para envíos del reproductor web. Es diferente del código de cuenta de ocho caracteres. Ese receptor termina al salir; los torrents convertidos no permiten búsqueda y se envían desde el principio.

## Privacidad y servidor

El servidor predeterminado es `https://jrplexps.duckdns.org`; puede cambiarse a otro origen HTTPS. La TV guarda una credencial aleatoria cifrada mediante Android Keystore/AES-GCM y vinculada al origen del servidor; no guarda contraseñas ni tokens de Jellyfin/Drive. Se deshabilitan backups y transferencias de las preferencias. No usa analítica ni permisos de archivos, micrófono o ubicación. Los medios se solicitan con capacidades temporales del título autorizado. Las peticiones de biblioteca usan `Authorization: Bearer` únicamente en la API limitada de TV, que no expone administración ni proxy arbitrario.

Configura `TV_STATE_DIR` en el gateway para conservar las cuentas al reiniciar. Compose monta `runtime/tv` en `/var/lib/jrplex/tv`; el instalador y la publicación deben crear ese directorio con UID/GID del servicio y modo0700. El gateway crea `devices.key` y `devices.enc` con modo0600; no los publiques ni los incluyas en archivos de código. El estado contiene un hash de la credencial TV y el token upstream cifrado AES-GCM. Conserva ambos archivos en el respaldo privado de ejecución. Sin `TV_STATE_DIR` el almacenamiento es solo memoria y un reinicio exige volver a vincular.

La página de activación conserva CSP y origen estricto. El código vence a los5minutos; la confirmación requiere credenciales válidas de JRPlex y límites por IP/cuenta/código. El servidor autentica un dispositivo Jellyfin específico para que el logout web no invalide la TV. La credencial solo se entrega al secreto privado de la solicitud de la TV; nunca aparece en el QR, URL, página de confirmación o logs.

## Build y verificación

JDK17, AndroidSDK36, Gradle8.14.3 con checksum y AGP8.13.0. Configura `ANDROID_HOME` o `local.properties` privado.

```sh
cd apps/firetv
./gradlew testDebugUnitTest lintDebug assembleDebug
```

Las pruebas JVM/Robolectric cubren QR real codificado/decodificado, cifrado y origen, biblioteca desde cuenta guardada sin emisor, reproducción/control/avance mediante doble de player y construcción/cierre de Media3 en API23/API28. Node verifica persistencia del servidor, autorización, vida independiente del navegador, revocación y el GUID real de Jellyfin con/sin guiones. Las regresiones Chrome verifican la activación y bytes/fotogramas reales de fixtures. Estas pruebas no sustituyen una prueba de decoder/audio/mando/suspensión en un Fire TV físico, aún no disponible.

Para distribución configura `JRP_TV_KEYSTORE`, `JRP_TV_STORE_PASSWORD`, `JRP_TV_KEY_PASSWORD` (alias `jrplex-tv`) y ejecuta `./gradlew --no-configuration-cache assembleRelease lintRelease`. La clave persistente de este proyecto permanece en `secrets/firetv/` fuera de Git. Respalda la clave y su contraseña: futuras actualizaciones necesitan la misma firma y un `versionCode` mayor. Sin esas variables el release es **sin firmar**. La versión publicada adjunta SHA256, certificado público y manifiesto. No se publica en Amazon Appstore.

Fuentes: [Fire OS](https://developer.amazon.com/docs/fire-tv/fire-os-overview.html), [Media3](https://developer.android.com/media/media3/exoplayer/hello-world), [Android Keystore](https://developer.android.com/reference/android/security/keystore/KeyGenParameterSpec), [ZXing](https://github.com/zxing/zxing).
