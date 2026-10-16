# Reproducir vídeo desde un torrent

JRPlex usa qBittorrent como motor privado y transmite únicamente el vídeo elegido. No espera a que el torrent termine, no agrega las piezas a la biblioteca y no expone la WebUI de qBittorrent.

**Una reproducción de torrent siempre recibe temporalmente piezas en el servidor.** El cliente verifica esas piezas y el gateway solo las entrega después de su verificación. Si se reproduce el archivo entero, sus bytes pueden llegar completos durante la sesión; al detenerla o tras dos minutos sin actividad, JRPlex elimina el torrent y su caché temporal. Un reinicio del gateway limpia también los torrents temporales identificados por la etiqueta privada `jrplex-stream`. Las descargas anteriores con la etiqueta `jrplex` no se modifican.

Solo una cuenta administradora puede añadir enlaces `.torrent` o magnet. JRPlex elimina anuncios y URLs de pares proporcionados por el enlace para evitar que contenido no confiable mande a qBittorrent a direcciones privadas. El torrent necesita metadatos y pares disponibles; el formato y el códec deben poder reproducirse en el navegador. El panel no promete disponibilidad ni reproducción si el swarm no entrega las piezas.

## Activación

El perfil `torrents` está apagado por defecto. Antes de iniciarlo, prepara credenciales privadas:

```sh
node scripts/torrent-secrets.mjs --mode compose
```

Configura `QB_URL=http://qbittorrent:8080` en `.env` y valida/arranca los dos servicios:

```sh
node scripts/preflight.mjs --mode compose
docker compose --profile torrents up -d
```

qBittorrent guarda piezas en `DOWNLOADS_INCOMPLETE`; el gateway lee esa carpeta en solo lectura para servir rangos. Los puertos 8080 y 6881 no se publican directamente. La carpeta de incompletos debe tener espacio temporal suficiente para el vídeo y su caché. Si el VPS se queda sin espacio, detén las sesiones en JRPlex para que se borren.

En Windows o macOS, configura la WebUI de qBittorrent solo en loopback, autenticación local activa y el directorio de incompletos configurado en `.env`; usa `node scripts/torrent-secrets.mjs --mode native` para guardar las credenciales privadas del gateway. El ejecutable y la biblioteca multimedia deben usar la misma ruta física.

## Flujo de reproducción

1. El administrador pega el magnet o sube un archivo `.torrent` (máximo 1 MiB).
2. qBittorrent obtiene metadatos en pausa. JRPlex desactiva todos los archivos y muestra solo los vídeos compatibles.
3. Al elegir un vídeo, el gateway habilita ese archivo, activa prioridad secuencial y entrega rangos verificados conforme llegan sus piezas.
4. El botón **Detener y borrar búfer**, el fin del vídeo o dos minutos sin peticiones quitan el torrent y eliminan sus archivos temporales.

La ruta de streaming requiere sesión JRPlex y permiso de administrador; la URL usa un identificador aleatorio y no revela el hash del torrent. Los endpoints administrativos conservan CSRF y comprobación de origen.

## Verificación necesaria

Las pruebas automáticas usan un cliente API simulado y medios locales sintéticos para comprobar que solo se sirve una pieza verificada, que los rangos HTTP son correctos y que al detener se solicita `deleteFiles=true`. Para declarar la función operativa en un VPS, añade un torrent pequeño y autorizado en una prueba controlada, reproduce desde el principio y busca hacia adelante, detén la reproducción y confirma que el torrent desapareció y que sus archivos temporales se borraron. Esa prueba real aún está pendiente.

Referencia de la API usada: [qBittorrent WebUI API 5.0](https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-%28qBittorrent-5.0%29).
