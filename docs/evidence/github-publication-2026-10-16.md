# Evidencia de preparación para GitHub — 2026-10-16

## Alcance y criterios

Objetivo: publicar el proyecto JRPlex en un repositorio GitHub llamado `JRplex`.

| ID | Criterio de aceptación | Estado | Evidencia |
|---|---|---|---|
| GH-01 | Existe `oreyes100/JRplex` con visibilidad privada | BLOQUEADA | La cuenta conectada es `oreyes100`; la consulta del repositorio respondió 404 y la búsqueda no encontró uno existente. |
| GH-02 | El repositorio contiene solo el proyecto, sin secretos ni datos de ejecución | APROBADA localmente | Repositorio Git separado en `JRPlex`; 80 archivos en el primer commit. `.env`, `runtime/`, `.cache/` y archivos de credenciales quedan ignorados. Barrido de firmas comunes de tokens y claves privadas: sin coincidencias. |
| GH-03 | La versión preparada pasa pruebas del proyecto | APROBADA | Node.js v26.11.1; ejecutados directamente los 8 archivos de prueba: 52 aprobadas, 3 omitidas, 0 fallidas. El ejecutor agrupado de Node no pudo crear procesos (`spawn EPERM`); la ejecución individual evitó esa limitación. |
| GH-04 | El commit aparece en GitHub y puede clonarse | PENDIENTE | El commit local `36a68db` existe en `main`; no se realizó `push`. |

## Limitaciones y decisión

No hay un repositorio remoto creado. En esta sesión no está disponible GitHub CLI, la conexión GitHub expone herramientas de lectura pero no creación de repositorios y no hay navegador conectado para completar esa creación. La autenticación Git local tampoco proporcionó una credencial utilizable durante la comprobación no interactiva. El proyecto permanece preparado en un repositorio local independiente.

Se eligió visibilidad privada por defecto porque los documentos de operación describen infraestructura del servidor. No se publicó ningún archivo ni dato a GitHub. La publicación queda **BLOQUEADA** hasta que exista el repositorio privado vacío `oreyes100/JRplex` y Git pueda autenticarse para enviar el commit.
