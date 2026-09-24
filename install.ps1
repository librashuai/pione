# Install this personal extension into Pi's user extensions directory.
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'extensions/pione'
if (-not (Test-Path -LiteralPath (Join-Path $source 'index.ts'))) {
    throw "Extension source not found: $source"
}

$agentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $HOME '.pi/agent' }
$extensionsDir = Join-Path $agentDir 'extensions'
$destination = Join-Path $extensionsDir 'pione'
New-Item -ItemType Directory -Path $extensionsDir -Force | Out-Null

# This folder belongs exclusively to this plugin; replace it on every deployment.
if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
}
Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
Write-Host "Installed Pione extension at: $destination"
Write-Host 'Run /reload in Pi (or restart Pi), then use /fresh-show-turn.'
