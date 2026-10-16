$ErrorActionPreference = 'Stop'
$domain = 'jrplexps'
$hostname = 'jrplexps.duckdns.org'

Write-Host 'Copia el valor TXT que te dio Google Search Console (google-site-verification=...).'
$verificationValue = (Read-Host 'Valor TXT de Google').Trim()
if (-not $verificationValue.StartsWith('google-site-verification=', [StringComparison]::Ordinal)) {
  throw 'El valor no parece ser el registro google-site-verification de Search Console.'
}

$secureToken = Read-Host 'Token de DuckDNS (entrada oculta; no se guardará)' -AsSecureString
$tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer) }

try {
  $uri = 'https://www.duckdns.org/update?domains={0}&token={1}&txt={2}' -f `
    [Uri]::EscapeDataString($domain), [Uri]::EscapeDataString($token), [Uri]::EscapeDataString($verificationValue)
  $response = Invoke-WebRequest -Uri $uri -Method Get -TimeoutSec 30 -UseBasicParsing -ErrorAction Stop
  if ($response.Content.Trim() -ne 'OK') { throw 'DuckDNS no confirmó la actualización del registro.' }
}
catch { throw 'No se pudo actualizar DuckDNS. Revisa el subdominio y el token de forma privada, y vuelve a intentar.' }
finally { $token = $null; $uri = $null; $secureToken.Dispose() }

Write-Host 'DuckDNS confirmó la actualización. Consultando propagación DNS…'
for ($attempt = 1; $attempt -le 12; $attempt++) {
  try {
    $published = @(Resolve-DnsName -Name $hostname -Type TXT -DnsOnly -ErrorAction Stop | Where-Object QueryType -eq 'TXT' | ForEach-Object Strings)
    if ($published -contains $verificationValue) {
      Write-Host 'Registro TXT visible en DNS. Ahora pulsa Verificar en Google Search Console.'
      exit 0
    }
  } catch {}
  if ($attempt -lt 12) { Start-Sleep -Seconds 5 }
}
Write-Host 'DuckDNS aceptó el registro, pero todavía no se ve en esta consulta DNS. Espera la propagación y pulsa Verificar en Search Console más tarde.'
exit 2
