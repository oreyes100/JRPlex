# JRPlex TV 1.0.0 · Fire OS

Receptor Android nativo para enviar el vídeo que ya se reproduce en JRPlex. No usa WebView, Silk, Google Play Services ni Fling. ExoPlayer/Media3 reproduce MP4/WebM y HLS con el mando y una MediaSession. API mínima 23 (Android 6); los modelos Fire TV con Vega OS necesitan otra implementación y no aceptan esta APK.

## Instalar y usar

Descarga `jrplex-firetv-1.0.0.apk` desde [la versión publicada](https://github.com/oreyes100/JRPlex/releases/tag/firetv-v1.0.0), o abre `https://jrplexps.duckdns.org/firetv` con Downloader en Fire TV. Permite instalar desde esa aplicación en la configuración de tu Fire TV. No requiere acceso root. La instalación en un dispositivo por ADB se hace con autorización de depuración del propietario:

```sh
adb connect IP_DE_TU_FIRE_TV:5555
adb install -r jrplex-firetv-1.0.0.apk
adb shell am start -n org.jrplex.tv/.ReceiverActivity
```

Abre **JRPlex TV**, después **Enviar a TV** en el reproductor del móvil/computadora y copia el código. El código caduca en cinco minutos y se renueva solo; una vez enlazada, la pantalla está disponible durante la sesión del emisor. La TV puede estar en otra red siempre que alcance el servidor HTTPS. El mando controla reproducción, pausa y búsqueda; Atrás confirma detener y volver al dispositivo emisor. Salir a inicio libera vídeo, decoder y enlace. Al abrir de nuevo hay que vincular otra vez. Una interrupción de red muestra el problema y reintenta con espera creciente; si se pierde el control por 15 segundos, detiene el vídeo. Los torrents convertidos no permiten búsqueda y arrancan desde el principio.

El servidor predeterminado es `https://jrplexps.duckdns.org`; **Cambiar servidor** permite otro origen HTTPS, sin rutas. Solo esa dirección se guarda en preferencias privadas. La app no pide ni guarda contraseñas, cookies, tokens Jellyfin o credenciales Drive. El secreto de vinculación y la capacidad limitada al vídeo están en memoria. No hay servicio en segundo plano, analítica ni permisos de almacenamiento, micrófono o ubicación. `allowBackup=false`. TLS utiliza el almacén de confianza del sistema; no se omite la verificación de certificados. El control usa `start/poll/end` con Origin y la capacidad del receptor. Los medios solo se aceptan del mismo servidor bajo el enlace temporal `/cast/media/` recibido.

## Compilar y verificar

Necesita JDK 17 y Android SDK 36; Gradle 8.14.3 y AGP 8.13.0 están fijados. Las dependencias se descargan de Google Maven y Maven Central. Configura `ANDROID_HOME` o tu archivo **local** `local.properties`. No guardes rutas personales ni claves en Git.

```sh
cd apps/firetv
./gradlew testDebugUnitTest lintDebug assembleDebug
```

La APK de desarrollo queda en `app/build/outputs/apk/debug/app-debug.apk`. Robolectric comprueba el protocolo, validación de URL/expiración, estado, enlace, reintento, comandos duplicados, mando y liberación al salir; el reproductor está simulado en esas pruebas. La suite Node del repositorio verifica autorización, revocación de transferencias y el endpoint nativo de desconexión. Esto no sustituye la prueba de decodificación, audio/foco, mando y suspensión en un Fire TV físico; esa validación no se ha realizado.

Para una APK de distribución usa un keystore persistente propio. Define `JRP_TV_KEYSTORE` (ruta absoluta), `JRP_TV_STORE_PASSWORD` y `JRP_TV_KEY_PASSWORD`; alias `jrplex-tv`. Después ejecuta `./gradlew assembleRelease`. Sin esas variables el release es **sin firmar**. Nunca publiques el keystore ni sus contraseñas. Conserva una copia segura: las actualizaciones requieren la misma firma y un `versionCode` mayor. La clave de esta primera distribución se conserva fuera de Git bajo `secrets/firetv/`; el certificado público y SHA-256 de la APK se adjuntan a la versión. No se ha enviado a Amazon Appstore.

Fuentes: [Fire OS y versiones](https://developer.amazon.com/docs/fire-tv/fire-os-overview.html), [app de TV y manifiesto](https://developer.android.com/training/tv/get-started/create), [Media3](https://developer.android.com/media/media3/exoplayer/hello-world), [Vega](https://developer.amazon.com/apps-and-games/blogs/2026/07/guide-to-building-for-fire-tv-on-vega-os).
