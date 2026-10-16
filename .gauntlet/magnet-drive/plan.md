# Magnet y rutas Drive — 2026-10-16

Objetivo: reproducción progresiva de vídeo torrent y selección explícita de carpetas para películas, música y fotos.
R1: esperar piezas verificadas antes de abrir archivos aún inexistentes, resolver torrents multifichero y archivos .!qB; cancelar y limpiar sin falsos errores.
R2: mostrar progreso, errores de servidor y expiración/ausencia de peers de manera persistente; evitar cargas silenciosas.
R3: accesos Drive para películas, fotos y música preparan formulario y selector; nunca crean automáticamente bibliotecas en toda la raíz.
Verificación: pruebas de regresión, escenarios de archivos diferidos y multifichero, errores y estados, UI con backend simulado y FFmpeg real si está disponible.
Riesgo moderado: streaming y configuración de bibliotecas. Autorrevisión suficiente para cambios locales reversibles; no se requiere revisión independiente.
Capacidades observadas: Git, escritura local, Node 20 del shell (buscar runtime >=22), Python3 y FFmpeg; red y navegador sujetos a disponibilidad; producción sin credenciales comprobadas.
Terminación: cambios y verificaciones aplicables completas, evidencia archivada; limitaciones de swarm/producción explícitas.
