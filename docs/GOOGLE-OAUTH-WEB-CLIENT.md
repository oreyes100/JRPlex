# Crear el cliente OAuth Web de Google para JRPlex

Este paso se hace una sola vez en Google Cloud. Permite que el administrador pulse **Vincular Google Drive**, inicie sesión en la página oficial de Google y regrese a JRPlex. Los usuarios de JRPlex no entregan sus credenciales de Google; solo el administrador autoriza la cuenta de Drive que contiene los medios.

## Configuración

1. Abre [Google Cloud Console — Google Auth Platform](https://console.cloud.google.com/auth/overview) e inicia sesión con la cuenta propietaria del Drive. Crea un proyecto llamado `JRPlex` o selecciona uno que controles.
2. En **Branding**, usa `JRPlex` como nombre y configura un correo de soporte al que tengas acceso.
3. En **Audience**, elige **External** para autorizar una cuenta Google personal. Para una prueba puedes dejar el estado **Testing** y agregar esa cuenta en **Test users**. Google expira las autorizaciones de prueba y sus refresh tokens a los siete días cuando se solicitan permisos de Drive. Para una conexión permanente, publica el proyecto **In production**; para uso personal y menos de 100 usuarios se puede continuar sin verificación, pero Google puede mostrar una advertencia de aplicación no verificada. Si el sistema se distribuye a más usuarios, habrá que revisar los requisitos de verificación de Google.
4. En **Data Access**, agrega únicamente el permiso de solo lectura `https://www.googleapis.com/auth/drive.readonly`.
5. En [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com), confirma el proyecto correcto y pulsa **Enable**.
6. En **Clients**, pulsa **Create client** y selecciona **Web application**. En **Authorized redirect URIs**, agrega exactamente:

   `https://jrplexps.duckdns.org/api/google-drive/callback`

   Deja **Authorized JavaScript origins** vacío; el intercambio se realiza en el servidor. No agregues barras finales ni variantes HTTP: Google exige coincidencia exacta del URI.

7. Crea el cliente y descarga el JSON. Déjalo en `C:\Users\Administrador\Downloads\` por ahora. Ya confirmé que el archivo que pusiste es un cliente Web y que contiene el callback correcto; no abrí ni mostré el secreto. Para que JRPlex lo use, hay que transferirlo al VPS por SSH como se describe en [`deploy/GOOGLE-DRIVE.md`](../deploy/GOOGLE-DRIVE.md), que lo instala con permisos privados fuera del código.

Después de que el VPS tenga el cliente y la versión actualizada, el administrador abrirá JRPlex, entrará a **Administración → Bibliotecas → Contenido en la nube**, pulsará **Vincular Google Drive** y terminará en la página oficial de Google. El navegador vuelve automáticamente a JRPlex. Ninguna contraseña de Google se escribe en el panel ni en el chat.

La autorización y el retorno del navegador siguen el flujo de aplicación de servidor web descrito por Google. Referencias: [OAuth de servidor web](https://developers.google.com/identity/protocols/oauth2/web-server?hl=es-419), [modo de prueba y audiencia](https://support.google.com/cloud/answer/15549945?hl=es), [excepciones de verificación para uso personal](https://support.google.com/cloud/answer/13464323?hl=es).
