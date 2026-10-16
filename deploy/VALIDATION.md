# Evidencia del paquete de despliegue

Fecha: 2026-10-15. Entorno ejecutado: Windows/PowerShell, Node.js v26.11.1. Revisión de este paquete realizada por el agente responsable de despliegue; no se presenta como auditoría independiente de sus propios cambios. El registro Gauntlet global está en `../docs/GAUNTLET.md`.

| Verificación | Método ejecutado | Resultado |
|---|---|---|
| Sintaxis JavaScript | `node --check` sobre los siete archivos `scripts/*.mjs` | APROBADA |
| Ayuda CLI y dry-run | `--help` de cada CLI y `install --mode native --dry-run` | APROBADA |
| Preparación nativa Windows | `node scripts/install.mjs --mode native` | APROBADA: creó `.env` sin credenciales, diez directorios y placeholders vacíos; no inició servicios |
| Preflight nativo | `node scripts/preflight.mjs --mode native` | APROBADA para configuración/rutas/Node; pruebas funcionales explícitamente pendientes |
| Idempotencia | Segunda preparación nativa y comparación SHA256 del `.env` existente | APROBADA: conservado sin cambios |
| Backend privado | Ejecución de `privateBackend` con tres orígenes privados válidos y cuatro casos de origen público/credenciales/esquema/ruta rechazados | APROBADA: siete casos |
| Configuración nube fuera Git | CLI cloud con ruta dentro de este repositorio | APROBADA: rechazó antes de ejecutar rclone |
| TLS público requerido | CLI smoke con origen HTTP público | APROBADA: rechazó antes de conectar |
| Sintaxis PowerShell | Parser de PowerShell sobre `windows/start-jrplex.ps1` | APROBADA; no ejecuta el servidor |
| XML LaunchAgent | `plistlib` de Python sobre plantilla macOS | APROBADA; no demuestra ejecución macOS |
| Exclusión Git | `git check-ignore JRPlex/.env JRPlex/runtime/secrets/qb-password JRPlex/.cache/` desde la raíz del repositorio | APROBADA |
| Contenedores y manifests | No existe Docker en el PATH de este entorno | BLOQUEADA: aún no se verifica etiqueta, digest, `compose config`, pull ni arranque |
| Caddy/TLS real | Sin Caddy/DNS/destino seleccionado en esta verificación | PENDIENTE |
| Bootstrap Jellyfin real | El script usa contrato oficial de API v12.2; no existe motor de prueba aquí | PENDIENTE |
| Nube real y montaje | Sin rclone, driver ni credenciales de proveedor en esta verificación | PENDIENTE |
| qBittorrent/PBKDF2 e importación | Configuración contrastada con fuentes 5.2.4; cliente no arrancado | PENDIENTE |
| Restauración y compatibilidad por sistema | Procedimiento y plantillas presentes; ensayo no ejecutado | PENDIENTE |

Durante revisión se corrigieron listas YAML `tmpfs` con comas para que cada montaje sea una cadena completa, se alinearon entrypoint y healthcheck con `server.mjs`/`/healthz`, y se contrastaron claves qBittorrent con el tag 5.2.4 (PBKDF2, directorios, cola activa, CSRF/Host y port forwarding apagado). La corrección estática no equivale a una prueba Compose real.

Este paquete no declara APROBADO el despliegue general. La aceptación exige las comprobaciones pendientes del producto completo, incluyendo publicación exterior, reproducción y aislamiento con usuarios reales.
