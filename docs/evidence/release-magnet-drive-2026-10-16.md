# Publicación — magnets y rutas Drive

Fecha: 2026-10-16, America/Mexico_City. Autorización: commit, push a oreyes100/JRPlex y despliegue a producción solicitados por el propietario en este chat. No registrar credenciales.

## Misión y límites

Publicar la corrección ya validada y reconstruir únicamente el gateway. Conservar configuración, secretos, autorizaciones OAuth, montajes, biblioteca, Jellyfin, qBittorrent y proxy. El cambio preexistente de styles.css contiene solo diferencias CRLF y queda fuera del commit.

## Wargame y criterios

| Caso | Resultado exigido |
|---|---|
| Magnet sin archivo creado todavía | Esperar una pieza verificada antes de abrir |
| Multifichero plano y nombre .!qB | Leer solo el vídeo elegido dentro de caché |
| Swarm sin piezas / fallo de disco | Error persistente y reintento sin borrar la sesión |
| MKV | Conversión real a MP4 H.264/AAC decodificable |
| Drive películas/fotos/música | Selección y guardado de subcarpetas independientes |
| Producción | Revisión exacta, gateway saludable, mismos motores/montaje, HTTPS y assets correctos |

Las primeras cinco filas se cubren con test/torrents.test.mjs, test/gateway.test.mjs y la prueba Chrome controlada de .gauntlet/magnet-drive/browser-check.mjs. El backend de peers se simula; no se afirma un swarm real.

## Puertas de publicación

- [ ] Confirmar destino por host, proyecto, contenedores, URL configurada y salud.
- [ ] Regresión y auditoría local; excluir credenciales y archivos de ejecución.
- [ ] Commit y push verificados contra la referencia remota.
- [ ] Respaldo privado de código y etiqueta de imagen previa.
- [ ] Instalar exclusivamente archivos rastreados y reconstruir solo gateway.
- [ ] Comparar hashes del contenedor con el commit, comprobar salud/HTTPS y función controlada.
- [ ] Registrar resultado y eliminar archivos temporales de autenticación.

## Reversión

Si falla la construcción, conservar el contenedor anterior. Si falla salud o verificación tras recrear, restaurar el código respaldado y recrear solo gateway con la imagen anterior etiquetada; no modificar datos de runtime. La ruta concreta del respaldo y el identificador de imagen se registrarán después de comprobar el VPS.

## Resultado

Preparación en curso; este documento se actualizará con la evidencia real del despliegue. La aceptación local previa consta en magnet-drive-fix-2026-10-16.md.
