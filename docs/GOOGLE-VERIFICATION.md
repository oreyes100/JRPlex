# Publicación pública y verificación de Google

JRPlex ofrece una portada pública en `https://jrplexps.duckdns.org/`, la aplicación privada en `/app` y la política en `https://jrplexps.duckdns.org/privacy`. Usa exactamente esas dos URL en Google Auth Platform: **App homepage** `https://jrplexps.duckdns.org/` y **Privacy policy** `https://jrplexps.duckdns.org/privacy`.

## La pantalla de Archivo HTML

Si Search Console muestra **Archivo HTML**, **Etiqueta HTML**, Analytics y Tag Manager, estás verificando una propiedad de **prefijo de URL**, normalmente `https://jrplexps.duckdns.org/`. Esa verificación sirve para Search Console, pero **no cumple el requisito de dominio de Google OAuth**. Google permite Archivo HTML para propiedades de prefijo URL, no para propiedades Domain; OAuth pide la verificación DNS de una propiedad Domain.

Para terminar únicamente la verificación del prefijo URL con Archivo HTML, descarga el archivo que Google te entrega y colócalo, sin renombrarlo ni editarlo, en `JRPlex/public/`. Tras publicar, debe responder en la URL exacta que indica Search Console, sin iniciar sesión. Conserva el archivo después de verificar. Esto no desbloquea la revisión de dominio OAuth.

## Verificar el dominio para OAuth desde la pantalla que tienes

No elijas **Archivo HTML** para este requisito de OAuth. En la misma pantalla que pegaste, abre **Otros métodos de verificación** y selecciona **Proveedor de nombres de dominio → Asociar un registro DNS a Google**. Google mostrará un TXT; esa es la opción que necesitas. Search Console documenta que verificar por DNS un prefijo de URL también verifica automáticamente la propiedad Domain correspondiente. Después de pulsar **Verificar**, confirma en el selector de propiedades que `jrplexps.duckdns.org` aparece como propiedad **Dominio** verificada.

Si prefieres crear directamente la propiedad Domain: vuelve a Search Console, abre el selector de propiedades (esquina superior izquierda), pulsa **+ Añadir propiedad**, elige la tarjeta **Dominio** y escribe solo `jrplexps.duckdns.org` (sin `https://`, ruta ni `/` final). Ambas rutas requieren el TXT DNS.

Hazlo con una cuenta que figure como **Owner o Editor** del proyecto de Google Cloud de JRPlex. Si la propiedad Domain no aparece verificada después del flujo DNS de la pantalla actual, usa la ruta directa de **Añadir propiedad → Dominio**.

## Publicar el TXT de DuckDNS

Cuando tengas el valor TXT emitido por Google y acceso al token privado de DuckDNS, desde PowerShell ejecuta `./JRPlex/scripts/duckdns-google-verification.ps1`. Pega el TXT cuando se solicite y escribe el token de DuckDNS en el campo oculto. El script actualiza solo TXT, no muestra ni guarda el token y consulta la propagación durante un minuto. Después, pulsa **Verificar** en la propiedad Domain de Search Console y conserva el TXT.

Al verificar, vuelve a Google Auth Platform y confirma el dominio autorizado, las URL públicas, el correo de asistencia y el alcance `drive.readonly`; luego responde a la solicitud de revisión o vuelve a enviarla según indique Google. La propiedad DNS acredita control del dominio, pero Google todavía decide la aprobación OAuth.

Fuentes oficiales: [añadir una propiedad y distinguir Domain de prefijo URL](https://support.google.com/webmasters/answer/34592?hl=es), [requisito DNS Domain para OAuth](https://support.google.com/cloud/answer/13804266?hl=es), [métodos de verificación de Search Console](https://support.google.com/webmasters/answer/9008080?hl=es), [requisitos de verificación OAuth](https://support.google.com/cloud/answer/13464321?hl=es), [requisitos de portada](https://support.google.com/cloud/answer/13807376?hl=es) y [API TXT de DuckDNS](https://www.duckdns.org/spec.jsp).
