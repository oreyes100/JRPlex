# Verificación HTML de Search Console — 2026-10-16

## Evidencia

- Se recibió el archivo de Google `google095fff9fd96bfc8c.html` desde Descargas y se colocó sin renombrar ni modificarlo en `public/`.
- El archivo local conserva 53 bytes; su SHA-256 coincide con el descargado. El contenido fue comprobado contra el patrón de verificación correspondiente al nombre, sin registrar el valor del token en esta evidencia.
- Se publicó mediante el modo de solo código. Solo se reconstruyó `jrplex-gateway`; el servicio informó `healthz` como `ok`. No se reemplazaron el cliente OAuth, el token de Drive ni el montaje.
- Desde el VPS se solicitó por HTTPS la ruta pública exacta a través del proxy Nginx existente. Resultado: HTTP 200, `TLS_VERIFY=0` y el SHA-256 del cuerpo coincidió con el archivo local. La ruta no requiere sesión.

## Alcance y pendiente

La prueba confirma que Search Console puede obtener el archivo de verificación de la propiedad de prefijo URL. No confirma que el usuario haya pulsado **Verificar** ni sustituye la propiedad Domain DNS que Google exige para la revisión OAuth. En la pantalla compartida, el siguiente paso es **Otros métodos de verificación → Proveedor de nombres de dominio → Asociar un registro DNS a Google**; después hay que publicar el TXT emitido por Google y verificar que la propiedad Domain quede marcada como verificada con una cuenta Owner/Editor del proyecto de Cloud.
