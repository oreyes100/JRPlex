$ErrorActionPreference = 'Stop'
$JRPlexRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$JRPlexEnv = Join-Path $JRPlexRoot '.env'
if (-not (Test-Path -LiteralPath $JRPlexEnv -PathType Leaf)) {
    throw 'Primero ejecuta node scripts/install.mjs --mode native y revisa .env.'
}
Push-Location -LiteralPath $JRPlexRoot
try {
    & node '--env-file=.env' 'server.mjs'
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
