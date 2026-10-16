# Nube y discos

Jellyfin lee `/media/local`, `/media/cloud` y `/media/downloads` en Linux/Compose. En instalaciones nativas usa rutas absolutas vistas por el proceso Jellyfin. Se deshabilita guardar metadatos junto al original; los volúmenes multimedia se montan read-only. La cuenta de servicio necesita lectura en cada archivo y acceso en sus directorios padre.

## Credenciales de nube

Instala rclone desde [su distribución oficial](https://rclone.org/install/). Mantén `rclone.conf` **fuera del repositorio**, por ejemplo `/home/jrplex/.config/jrplex/rclone.conf`, con directorio 0700 y archivo 0600. En Windows restringe las ACL a la cuenta de servicio y administradores; los modos POSIX no sustituyen ACL NTFS. Usa un gestor de contraseñas/Keychain/Credential Manager que entregue la contraseña a rclone. La contraseña del gestor debe guardarse separada de la configuración cifrada. No uses `echo contraseña`, una contraseña en argv, `.env`, historial, un script versionado o un archivo junto a la configuración.

Ejemplo macOS de consulta al Keychain ya provisionado: `/usr/bin/security find-generic-password -a jrplex -s jrplex-rclone -w`. El alta de la contraseña se hace en el gestor del sistema. En Linux el comando puede ser un helper local propietario 0700 que consulte un gestor del host. No se genera un helper con una contraseña incrustada.

```sh
node scripts/cloud.mjs --action init --config /home/jrplex/.config/jrplex/rclone.conf --password-command /home/jrplex/.local/bin/read-rclone-secret
node scripts/cloud.mjs --action config --config /home/jrplex/.config/jrplex/rclone.conf --password-command /home/jrplex/.local/bin/read-rclone-secret
node scripts/cloud.mjs --action check --config /home/jrplex/.config/jrplex/rclone.conf --password-command /home/jrplex/.local/bin/read-rclone-secret
```

`init` rechaza archivos existentes, cifra configuración vacía y comprueba descifrado. `config` abre el asistente oficial de OAuth/proveedor. Solicita los permisos mínimos del proveedor, preferiblemente lectura para reproducción. La configuración OAuth puede requerir renovar tokens y por ello el archivo debe poder escribirse por la cuenta rclone aunque el montaje multimedia sea read-only. El wrapper valida formato cifrado y rechaza configuración dentro del repositorio. No graba credenciales ni transcript de la sesión. `rclone obscure` por sí solo es ofuscación reversible y **no satisface** este requisito.

## Montar sin privilegios de contenedor

Prepara un directorio de montaje vacío y caché privada en el host. El ejemplo limita caché a 10 GiB y conserva 2 GiB libres; los límites VFS son objetivos y pueden superarse con archivos abiertos, por lo que también se debe vigilar disco/cuota. La caché contiene medios descifrados: permisos restringidos y cifrado del disco si se necesita protegerlos en reposo.

```sh
node scripts/cloud.mjs --action mount --config /home/jrplex/.config/jrplex/rclone.conf --password-command /home/jrplex/.local/bin/read-rclone-secret --remote nube:peliculas --mount /home/jrplex/media/cloud --cache /home/jrplex/.cache/jrplex-cloud --cache-size 10G
```

El comando permanece en primer plano. En Linux necesita FUSE disponible; en Windows, WinFsp. En macOS instala macFUSE/FUSE-T o, con rclone actual, usa `--action nfsmount` para la ruta NFS soportada. Los permisos y visibilidad de unidad Windows dependen de la identidad del proceso; rclone y Jellyfin deben ejecutarse con la misma cuenta. La compatibilidad de driver/montaje se verifica en cada sistema.

Establece `CLOUD_MEDIA` al punto real y arranca Jellyfin **después** del montaje. El Compose usa propagación `rslave` en Linux; no se concede `SYS_ADMIN`, `/dev/fuse` ni `privileged` a contenedores. Si usas rootless Docker, comprueba el mapeo de UID y lectura del montaje: no habilites `allow-other` global para resolverlo sin revisar permisos. Un montaje FUSE que desaparece no debe considerarse biblioteca vacía legítima: detén scans y recupera el montaje antes de continuar.

Antes de aprobar nube, registra sin secretos: proveedor y versión rclone, formato cifrado comprobado, medio remoto autorizado conocido, lectura/hash de ese archivo, catálogo tras scan, reproducción y búsqueda temporal desde la web, resultado tras reinicio del servicio y comportamiento ante caída del proveedor. Si no hay proveedor/credenciales reales, estas pruebas quedan **PENDIENTES**.
