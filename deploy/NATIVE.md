# Windows, macOS y Linux nativos

Instala Node.js 22 o posterior y Jellyfin desde sus paquetes oficiales. Jellyfin en Docker sobre Windows/macOS no es la ruta soportada de este proyecto. No es necesario instalar dependencias npm para el gateway. El cliente HLS que usa la web se distribuye como recurso local con atribución; verifica que los archivos `public/` estén completos en la copia que ejecutes.

```sh
node scripts/install.mjs --mode native
node scripts/preflight.mjs --mode native
```

La preparación crea `.env` sin secretos y directorios bajo `runtime/`, sin arrancar servidores. Revisa `JELLYFIN_URL=http://127.0.0.1:8096`, `PUBLIC_URL=http://127.0.0.1:8787`, `HOST=127.0.0.1` y las rutas de secretos. Instala/inicia Jellyfin como servidor nativo; mantén 8096 limitado a loopback/firewall local. No permitas una excepción automática de firewall a todas las redes si solo se necesita acceso por JRPlex.

Si Jellyfin acaba de instalarse, completa su asistente **antes** de publicar JRPlex. Puedes usar el CLI con las rutas absolutas que Jellyfin vea. Ejemplo Windows:

```powershell
node scripts/bootstrap.mjs --url http://127.0.0.1:8096 --username administrador --local-media 'D:\Peliculas'
```

Ejemplo macOS:

```sh
node scripts/bootstrap.mjs --url http://127.0.0.1:8096 --username administrador --local-media /Volumes/Media/Peliculas
```

La contraseña se introduce por stdin, sin eco. Un motor ya configurado se conserva; usa sus cuentas existentes. Para añadir biblioteca nube o descargas usa `--cloud-media`/`--downloads` con directorios reales, o la administración autenticada de la web. El proceso servidor necesita acceso al disco removible y su ruta puede cambiar tras reconectar; prueba el arranque tras reconexión del volumen.

Arranca JRPlex desde su carpeta:

```sh
node --env-file=.env server.mjs
```

En Windows también puedes ejecutar `deploy/windows/start-jrplex.ps1`, que comprueba la configuración y mantiene el proceso en primer plano. Abre `http://127.0.0.1:8787`; otro terminal sirve para pruebas:

```sh
node scripts/smoke.mjs --url http://127.0.0.1:8787 --local --username administrador --jellyfin-url http://127.0.0.1:8096
```

## Inicio persistente

- **Linux:** adapta `linux/jrplex.service.example` con cuenta no root, ruta Node y ruta de proyecto. Revisa el archivo antes de copiarlo a systemd; es una plantilla, no una instalación automática. `ProtectHome=true` exige que proyecto/secretos de servicio estén fuera de `/home`, o ajustar una excepción mínima revisada. El motor Jellyfin se instala con su propio servicio.
- **macOS:** adapta rutas absolutas de `macos/org.jrplex.gateway.plist.example` y cópialo al `~/Library/LaunchAgents/` de la cuenta de servicio. Valida con `plutil -lint` y regístralo con `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.jrplex.gateway.plist`. Un LaunchAgent de usuario solo funciona mientras esa sesión exista; servicio previo al login requiere un LaunchDaemon administrado y probado. El servidor Jellyfin debe configurarse para arrancar también.
- **Windows:** crea una tarea del Programador de tareas bajo la cuenta de servicio, con programa Node, argumentos `--env-file=C:\ruta\JRPlex\.env C:\ruta\JRPlex\server.mjs` y directorio inicial `C:\ruta\JRPlex`. Selecciona ejecución sin depender de una ventana visible y reinicio ante fallo. No guardes contraseñas dentro de un script; usa el almacenamiento de credenciales del sistema. La tarea necesita acceso al disco/nube bajo esa misma identidad. El alta no se hace automáticamente.

Para nube instala WinFsp/macFUSE/FUSE-T o usa `rclone nfsmount` según plataforma; sigue [STORAGE.md](STORAGE.md). Con discos/unidades Windows, las letras montadas en una sesión o como administrador pueden ser invisibles para otro servicio. Prueba identidad y permisos reales. Para torrents nativos sigue [TORRENTS.md](TORRENTS.md).

## HTTPS y red

Para acceso público cambia `PUBLIC_URL` al dominio HTTPS real y mantén gateway en loopback. Usa un proxy nativo: `Caddyfile.native.example` sirve como configuración a adaptar; no se instala ni modifica un proxy existente. DNS y entrada de red deben llegar a ese equipo. CGNAT, firewall o puertos ocupados requieren una solución de red acordada, no se eluden abriendo todos los puertos. Para acceso privado multiusuario también se puede emplear una red privada; su despliegue es una tarea de infraestructura separada.

Comprueba con navegador real y `scripts/smoke.mjs`, y repite tras reinicio del servicio. La sintaxis de los scripts común a sistemas no demuestra que macOS, Windows y todos los drivers se hayan probado: cada runtime sin ejecución permanece **PENDIENTE**.
