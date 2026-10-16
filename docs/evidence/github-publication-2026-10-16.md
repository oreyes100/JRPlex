# Evidencia de preparación para GitHub — 2026-10-16

## Alcance y criterios

Objetivo: publicar el proyecto JRPlex en un repositorio GitHub llamado `JRplex`.

| ID | Criterio de aceptación | Estado | Evidencia |
|---|---|---|---|
| GH-01 | Existe `oreyes100/JRPlex` y la conexión tiene permiso para publicar | APROBADA | El repositorio existe, está vacío (`size: 0`) y la conexión informa permisos `admin` y `push`. Su visibilidad actual es **pública**. |
| GH-02 | El repositorio contiene solo el proyecto, sin secretos ni datos de ejecución | APROBADA localmente | Repositorio Git separado en `JRPlex`; 80 archivos en el primer commit. `.env`, `runtime/`, `.cache/` y archivos de credenciales quedan ignorados. Barrido de firmas comunes de tokens y claves privadas: sin coincidencias. |
| GH-03 | La versión preparada pasa pruebas del proyecto | APROBADA | Node.js v26.11.1; ejecutados directamente los 8 archivos de prueba: 52 aprobadas, 3 omitidas, 0 fallidas. El ejecutor agrupado de Node no pudo crear procesos (`spawn EPERM`); la ejecución individual evitó esa limitación. |
| GH-04 | El commit aparece en GitHub y puede clonarse | PENDIENTE | El commit local `dfbd66d` existe en `main`; no se ha transmitido contenido a GitHub. |

## Limitaciones y decisión

La conexión GitHub tiene permisos para escribir en el repositorio recién creado, por lo que se puede cargar el commit mediante la API de GitHub. El repositorio está vacío y es **público**. La revisión del proyecto encontró referencias de red interna y arquitectura del VPS/proxy en documentos de despliegue y evidencias; publicar expondría esos detalles.

Se había solicitado preparar un repositorio privado por defecto. No se publicó ningún archivo ni dato a GitHub. La publicación está **BLOQUEADA** hasta que el usuario confirme la exposición pública de esos detalles o cambie el repositorio a privado.
