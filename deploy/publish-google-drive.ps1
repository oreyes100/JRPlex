param(
  [string]$ClientJson,
  [string]$SshTarget = 'devops@192.168.1.250',
  [string]$SshExe = (Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'),
  [string]$ScpExe = (Join-Path $env:WINDIR 'System32\OpenSSH\scp.exe'),
  [switch]$EnableCloudMount,
  [switch]$CodeOnly
)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$archive = Join-Path $env:TEMP ("jrplex-oauth-web-{0}.tar.gz" -f [guid]::NewGuid().ToString('N'))
$archiveName = Split-Path -Leaf $archive
$remoteStage = "/home/devops/.local/share/jrplex/stage-$PID-$([guid]::NewGuid().ToString('N'))"

try {
  if (-not (Test-Path -LiteralPath $SshExe -PathType Leaf) -or -not (Test-Path -LiteralPath $ScpExe -PathType Leaf)) {
    throw 'No se encontraron los clientes OpenSSH de Windows. Indica -SshExe y -ScpExe con sus rutas completas.'
  }
  $client = $null
  if (-not $CodeOnly) {
    if (-not $ClientJson) {
      $candidates = @(Get-ChildItem -LiteralPath (Join-Path $HOME 'Downloads') -Filter 'client_secret_*.json' -File)
      if ($candidates.Count -ne 1) { throw 'Indica -ClientJson con la ruta exacta del JSON OAuth si hay cero o varios en Descargas.' }
      $ClientJson = $candidates[0].FullName
    }
    $client = Get-Item -LiteralPath $ClientJson
    if ($client.Name -notmatch '^client_secret_[A-Za-z0-9-]+\.apps\.googleusercontent\.com\.json$') { throw 'El nombre del archivo no coincide con un cliente Google Web descargado.' }
    $credential = Get-Content -LiteralPath $client.FullName -Raw | ConvertFrom-Json
    $web = $credential.web
    if (-not $web -or -not $web.client_id.EndsWith('.apps.googleusercontent.com') -or -not $web.client_secret -or $web.redirect_uris -notcontains 'https://jrplexps.duckdns.org/api/google-drive/callback') {
      throw 'El JSON no es un cliente Web de JRPlex con callback exacto.'
    }
  }

  Write-Host '[1/4] Preparando transferencia privada…'
  $init = "install -d -m 700 /home/devops/.config/jrplex /home/devops/.local/share/jrplex/backups /home/devops/.local/share/jrplex/google-drive-mount $remoteStage"
  & $SshExe -tt -o ConnectTimeout=15 $SshTarget $init
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el directorio privado remoto por SSH.' }
  Write-Host 'Conexión SSH y staging preparados.'

  $includes = @('.dockerignore', '.gitignore', '.env.example', 'Dockerfile', 'package.json', 'server.mjs', 'lib', 'public', 'scripts', 'test', 'docs', 'deploy', 'README.md', 'THIRD_PARTY.md', 'compose.yaml')
  & tar.exe -czf $archive -C $project @includes
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo empaquetar la versión local de JRPlex.' }
  Write-Host 'Paquete local creado.'

  $destination = "${SshTarget}:$remoteStage/"
  Write-Host '[2/4] Copiando el paquete de JRPlex…'
  if ($CodeOnly) { & $ScpExe $archive $destination }
  else { & $ScpExe $archive $client.FullName $destination }
  if ($LASTEXITCODE -ne 0) { throw 'La transferencia SCP no terminó correctamente.' }

  $remote = @'
set -euo pipefail
stage='__STAGE__'
project='/home/devops/JRPlex'
client_name='__CLIENT_NAME__'
configure_client='__CONFIGURE_CLIENT__'
archive_name='__ARCHIVE_NAME__'
client_path='/home/devops/.config/jrplex/google-web.json'
cleanup() {
  rm -f -- "$stage/$archive_name"
  if test "$configure_client" = 'true'; then rm -f -- "$stage/$client_name"; fi
  rmdir -- "$stage" 2>/dev/null || true
}
trap cleanup EXIT
test -d "$stage"
if test "$configure_client" = 'true'; then
  if test -e "$client_path"; then
    cmp -s "$stage/$client_name" "$client_path" || { echo 'El cliente OAuth remoto ya existe y no coincide; no se sobrescribió.' >&2; exit 1; }
    rm -f -- "$stage/$client_name"
  else
    chmod 600 "$stage/$client_name"
    install -m 600 "$stage/$client_name" "$client_path"
  fi
fi
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="/home/devops/.local/share/jrplex/backups/google-web-$stamp.tar.gz"
tar -czf "$backup" -C "$project" .dockerignore .gitignore .env.example Dockerfile package.json server.mjs lib public scripts test docs deploy README.md THIRD_PARTY.md compose.yaml
tar --no-same-owner -xzf "$stage/$archive_name" -C "$project"
cd "$project"
if test "$configure_client" = 'true'; then node scripts/google-drive-prepare.mjs --client-file "$client_path"; fi
service_uid="$(id -u devops)"
service_gid="$(id -g devops)"
compose_uid="$(sed -n 's/^JRP_UID=//p' .env)"
compose_gid="$(sed -n 's/^JRP_GID=//p' .env)"
test "$service_uid" = "${compose_uid:-1000}" || { echo 'JRP_UID no coincide con el usuario devops.' >&2; exit 1; }
test "$service_gid" = "${compose_gid:-1000}" || { echo 'JRP_GID no coincide con el grupo devops.' >&2; exit 1; }
docker compose -f compose.yaml -f deploy/compose.google-drive.yaml config --quiet
docker compose -f compose.yaml -f deploy/compose.google-drive.yaml up -d --build --no-deps gateway
for attempt in $(seq 1 30); do
  if curl --fail --silent --max-time 3 http://127.0.0.1:8787/healthz; then break; fi
  if [ "$attempt" -eq 30 ]; then echo 'El gateway no respondió en healthz.' >&2; exit 1; fi
  sleep 1
done
__CLOUD_MOUNT__
'@
  if ($EnableCloudMount) {
    $remote = $remote.Replace('__CLOUD_MOUNT__', @'
sudo -n install -m 644 "$project/deploy/jrplex-google-drive.service.example" /etc/systemd/system/jrplex-google-drive.service
sudo -n systemctl daemon-reload
sudo -n systemctl enable jrplex-google-drive.service
sudo -n systemctl restart jrplex-google-drive.service
sudo -n systemctl is-active --quiet jrplex-google-drive.service
/usr/bin/mountpoint -q /home/devops/JRPlex/runtime/media/cloud
'@)
  } else {
    $remote = $remote.Replace('__CLOUD_MOUNT__', '')
  }
  $clientName = if ($client) { $client.Name } else { 'unused' }
  $configureClient = if ($client) { 'true' } else { 'false' }
  $remote = $remote.Replace('__STAGE__', $remoteStage).Replace('__CLIENT_NAME__', $clientName).Replace('__CONFIGURE_CLIENT__', $configureClient).Replace('__ARCHIVE_NAME__', $archiveName)
  Write-Host '[3/4] Instalando versión y reconstruyendo solo el gateway…'
  & $SshExe -tt -o ConnectTimeout=15 $SshTarget $remote
  if ($LASTEXITCODE -ne 0) { throw 'La actualización remota falló. El respaldo privado quedó en el VPS y los datos de runtime/.env se conservaron.' }

  Write-Host '[4/4] Publicación comprobada por healthz.'
  Write-Output 'JRPlex actualizado: solo se reconstruyó el gateway; el JSON y el token cifrado quedaron fuera del código.'
  if ($EnableCloudMount) {
    Write-Output 'Montaje Google Drive activo; se verificó como punto FUSE del host.'
  } else {
    Write-Output 'Siguiente paso: inicia sesión como administrador, abre Contenido en la nube y pulsa Vincular Google Drive.'
  }
} finally {
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
}
