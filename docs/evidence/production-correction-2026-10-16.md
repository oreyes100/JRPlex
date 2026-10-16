# Corrección de reproducción y carpetas — 2026-10-16

## Casos de aceptación

| Caso | Resultado esperado |
|---|---|
| Magnet aportado con fuentes activas | Obtener metadatos y reproducir fotogramas en Chrome; detener y limpiar búfer |
| Tracker privado o resolución mixta | Descartar sin permitir conexiones a servicios privados |
| Carpetas y Fotografías | Peticiones a través del gateway autenticado y navegación visible en móvil |
| Selección de Drive | Controles visibles para películas, música y fotos; guardar únicamente la ruta elegida |
| Cambio de una biblioteca | Conservar identidad y permisos; restaurar referencias anteriores si falla la actualización |
| Música y fotos | Indexar muestras con Jellyfin real y abrirlas desde la interfaz |
| Montaje | Drive de solo lectura, accesible al servicio y root; denegado a otros usuarios |

## Correcciones

Se elimina el límite de un byte por segundo que detenía el intercambio de metadatos y se conservan trackers UDP públicos con direcciones verificadas. qBittorrent detiene la descarga al recibir metadatos hasta que se elija el vídeo.

Se corrigen las rutas de Carpetas y Fotografías. El selector de Drive queda al inicio de Bibliotecas y nube, con accesos desde las vistas. «Cambiar carpeta» limita una biblioteca existente sin recrearla. La exploración de la estructura se solicita después de guardar. Los álbumes musicales ya no quedan excluidos por un filtro de tipo de medio; las fotografías usan el tipo aceptado por Jellyfin.

El montaje usa permisos del kernel 0700/0600 para permitir al propietario y root leer Drive. Requiere `user_allow_other` en la configuración FUSE del servidor; este cambio fue autorizado expresamente. El servicio retira montajes desconectados al iniciar y detener.

## Verificación

Suite repetida: 70 pruebas aprobadas, cero fallos y una integración opcional omitida. Chrome pasó la navegación móvil, los tres selectores, reproducción sintética, errores y reintento. El magnet aportado reprodujo fotogramas en Chrome usando los servicios reales, incluida una repetición con todos sus trackers. La misma imagen de Jellyfin indexó vídeo, MP3 y JPG en una instancia aislada del servidor: Chrome comprobó las tres vistas y el cambio de carpeta mantuvo la identidad de la biblioteca y sustituyó el contenido indexado. La instancia usó exclusivamente muestras sintéticas, sin API simulada.

Las pruebas de red externa dependen de fuentes disponibles en ese momento. Las carpetas personales deben seleccionarse explícitamente; no se eligen automáticamente.
