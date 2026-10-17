# Enviar un vídeo a TV

Mientras se reproduce un título de la biblioteca o un vídeo de torrent, abre **Enviar a TV** debajo del reproductor.

## Chromecast, Google TV y televisores con Google Cast

1. Abre JRPlex por HTTPS en un navegador Chrome compatible con Google Cast. Mantén el emisor y el Chromecast en la misma red local.
2. Pulsa **Chromecast / Google TV** y elige el dispositivo en el selector del navegador.
3. Cuando el receptor confirme la carga, el vídeo local se pausa. Desde JRPlex puedes pausar, continuar, cambiar la posición y volver al dispositivo original.

El SDK oficial se carga desde Google solo cuando abres el panel de envío. Se utiliza el receptor multimedia predeterminado, sin registrar una aplicación personalizada. El televisor debe poder acceder al `PUBLIC_URL` HTTPS de JRPlex y confiar en su certificado. Chrome en iOS no admite el Web Sender; usa la vinculación por código desde ese dispositivo.

## Fire TV / Firestick y televisores con navegador

Para Fire TV con Fire OS se recomienda la **app nativa JRPlex TV**: [descarga e instalación](https://jrplexps.duckdns.org/firetv), [fuente y pruebas](../apps/firetv/README.md). Muestra el código al abrirse, renueva los códigos vencidos y permite usar el mando sin Silk. Los modelos Vega OS requieren otra app. La validación en un Fire TV físico está pendiente.

1. En Fire TV abre **Silk**; en otra TV usa un navegador con soporte MP4/H264/AAC o HLS.
2. Visita `https://TU-DOMINIO/tv`. Puedes cambiar el nombre de la pantalla. Se muestra un código de seis dígitos que dura cinco minutos.
3. En el reproductor de tu móvil o computadora, introduce el código y pulsa **Vincular TV / Fire TV y enviar**.
4. Si la TV exige autorizar la reproducción automática, pulsa **Reproducir en esta pantalla** con el mando. El vídeo local continúa hasta que la TV confirma la reproducción.
5. Para los siguientes vídeos elige la pantalla en **Pantalla vinculada**. La página `/tv` debe permanecer abierta.

Este método no requiere Fling ni descubrimiento Fire TV desde el VPS. Amazon retiró el soporte de Fling en marzo de 2026; no se presenta esta función como una integración Matter Casting ni como control de la app nativa Jellyfin de Fire TV.

## Formatos y sesión

- Para biblioteca se solicita una fuente H264/AAC compatible o HLS preparado por Jellyfin. La posición se conserva cuando la fuente permite buscar.
- Los torrents usan el archivo ya seleccionado y las piezas verificadas existentes. Enviar no vuelve a añadir el torrent ni borra la caché. Si el servidor lo convierte al vuelo, el envío empieza desde el principio y no permite adelantar; se indica en el reproductor.
- Cerrar el reproductor, detener el envío o cerrar sesión revoca los enlaces y corta las transferencias activas. La pantalla vinculada puede recibir otro vídeo durante la sesión original. Un reinicio del gateway obliga a vincular otra vez.
- Las URLs del receptor son capacidades aleatorias, solo para el título seleccionado, con un máximo de seis horas y nunca más que la sesión de origen. No contienen tokens de Jellyfin o Google Drive. No compartas esos enlaces ni registres sus rutas completas en el proxy.
- CORS se permite exclusivamente en los enlaces multimedia de capacidad, con GET/HEAD/OPTIONS; el resto de la API mantiene cookie, origen y CSRF. Los usuarios solo controlan receptores vinculados a su propia sesión. El código y los intentos están limitados.

## Verificación

`npm test` cubre el acceso por vídeo, Range/HEAD/CORS, reescritura HLS, revocación activa, roles y vinculación. `scripts/casting-browser-regression.mjs`, con `JRP_PLAYWRIGHT_MODULE` apuntando a Playwright, prueba dos ventanas reales de Chrome: vídeo HLS/fMP4, bloqueo de autoplay, controles, retorno, cancelación y errores. El transporte Google Cast se simula en esa regresión: la aceptación física de Chromecast/Fire TV requiere disponer del dispositivo y su red.

Fuentes: [Google Cast Web Sender](https://developers.google.com/cast/docs/web_sender/integrate), [navegadores soportados](https://developers.google.com/cast/docs/web_sender), [formatos HLS](https://developers.google.com/cast/docs/media/streaming_protocols), [retirada de Amazon Fling](https://developer.amazon.com/docs/fling/integrating-amazon-fling-into-your-android-app.html).
