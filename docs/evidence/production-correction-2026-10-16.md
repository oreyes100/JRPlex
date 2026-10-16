# Corrección de reproducción y carpetas — 2026-10-16

**APROBADO para esta corrección:** verificaciones requeridas satisfactorias y ningún defecto crítico o mayor pendiente.

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

## Publicación

Revisión de aplicación: [754a916](https://github.com/oreyes100/JRPlex/commit/754a9162cfe618e48c4da10786af89fe0b4137f1). Commit y push completados. La imagen pasó otras 70 pruebas con cero fallos y una integración opcional omitida antes de reemplazar el gateway.

El sitio público sirve los archivos exactos del commit y responde saludablemente por HTTPS. Chrome confirmó los tres controles de mapeo, carpetas reales de Drive y el menú de Fotografías en móvil, sin errores API. El magnet original reprodujo fotogramas desde el sitio público; se detuvo y retiró su búfer.

La indexación y remapeo de vídeo/audio/fotos se comprobaron con la misma imagen de Jellyfin en una instancia temporal que solo contenía muestras. Las bibliotecas personales conservan sus rutas hasta que el administrador elija una carpeta. Una biblioteca que abarca todo Drive puede tardar en explorar; conviene limitarla primero mediante «Cambiar carpeta».

Autorrevisión y pruebas repetidas durante esta corrección; no se creó ninguna automatización recurrente. El registro operativo detallado y los respaldos permanecen privados.

Limpieza final comprobada: solo quedaron las tres bibliotecas y vistas originales; muestras, búfer torrent, instancia de prueba, túneles y archivos temporales retirados. La sesión de verificación se revocó y volvió a responder 401. Los tres servicios y el montaje permanecieron saludables.
