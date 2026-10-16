# Registro de publicación de JRPlex

Destino: `devops@192.168.1.250`; URL pública `https://jrplexps.duckdns.org`; VPS Ubuntu 24.04. El subdominio resuelve a `207.248.113.8`. La aplicación corre en `.250`; el acceso público termina TLS en nginx del edge `.34` (`192.168.1.34`).

## Recorrido de conexión

```text
Navegador
  └─ HTTPS :443 / HTTP :80 → 301 HTTPS
       nginx edge 192.168.1.34
         └─ HTTPS :443, SNI jrplexps.duckdns.org
              nginx backend 192.168.1.250
                └─ HTTP loopback :8787
                     contenedor jrplex-gateway
                       └─ red privada de Docker → Jellyfin :8096
```

El edge valida el certificado TLS interno de `.250` mediante `/etc/nginx/ssl/jrplexps.duckdns.org/backend-pinned.crt` y `proxy_ssl_verify on`; el certificado público de backend tiene huella SHA-256 `2A:1E:41:B3:83:91:56:E9:9B:1C:E2:B0:39:9C:C1:C9:D1:93:97:27:50:C4:15:E5:68:65:2E:FC:5E:03:78:8C`. Su llave privada permanece en `.250`. El navegador recibe el certificado público de `jrplexps.duckdns.org`, emitido por ZeroSSL ECC y con vencimiento registrado para el 13 de enero de 2027; el registro indica renovación automática existente. No se desactivó la validación TLS del proxy.

## Evidencia de producción aportada por el operador

El 15 de octubre de 2026 el operador ejecutó la emisión/instalación del certificado y recargó nginx en el edge. Sus salidas adjuntas registran:

| Comprobación | Resultado registrado | Fuente |
|---|---|---|
| `nginx -t` en el edge | Correcto | Log proporcionado por el operador |
| Instalación del full chain y recarga | Correcta | Log de ACME proporcionado por el operador |
| `http://jrplexps.duckdns.org` | 301 a HTTPS | Tabla de pruebas del operador |
| `https://jrplexps.duckdns.org/` | 200, `ssl_verify_result:0` | Tabla de pruebas del operador |
| HTTPS local del edge | 200 | Log del operador |
| Verificación TLS edge → backend | Activada y con pin cuya huella coincide | Log/configuración descritos por el operador |
| Otros vhosts nginx | `cecytem33`, `freellm` y panel responden 200 tras el cambio | Tabla de regresión del operador |

Esta evidencia es el registro proporcionado por el operador, no una nueva inspección independiente del edge en esta sesión. No se volvió a emitir el certificado ni se modificó el proxy: el operador informa que está en producción. La aplicación no debe iniciar Caddy en los puertos públicos 80/443, que ya pertenecen a nginx.

## Mantenimiento del pin TLS

Si se regenera `backend.crt` en `.250`, nginx en `.34` rechazará el upstream hasta actualizar su copia pública `backend-pinned.crt`. Conserva la llave privada en `.250`; transfiere solo el certificado público, compara su huella en ambos hosts, valida el contexto con `nginx -t` y recarga nginx únicamente después de que la verificación coincida. No uses `proxy_ssl_verify off`.

## Retirada reversible

Deshabilita solo la vhost `jrplexps.duckdns.org` del edge, ejecuta `nginx -t` y recarga nginx si la prueba pasa. En `.250`, retira solo la vhost JRPlex y la aplicación después de conservar datos y configuración. No borres volúmenes ni configuraciones de otros servicios.
