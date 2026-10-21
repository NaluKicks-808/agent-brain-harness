# agent-brain-harness installer for Windows (PowerShell 5.1 or newer).
#   irm https://raw.githubusercontent.com/NaluKicks-808/agent-brain-harness/main/install.ps1 | iex
#   git clone https://github.com/NaluKicks-808/agent-brain-harness; cd agent-brain-harness; .\install.ps1
# Flags (local run): --yes --dry-run --uninstall --dir PATH --no-path --claude-hook --no-claude-hook --no-brain
# Piped run: set the flags first, e.g.  $env:AGENT_BRAIN_HARNESS_ARGS = '--yes --dry-run'
# This file only finds Python 3.8+ and the source, then hands over to install.py.
# Not run locally (no Windows here): the first CI run on windows-latest is the test.
$ErrorActionPreference = 'Stop'
$repo = if ($env:AGENT_BRAIN_HARNESS_REPO) { $env:AGENT_BRAIN_HARNESS_REPO } else { 'https://github.com/NaluKicks-808/agent-brain-harness.git' }
$ref = if ($env:AGENT_BRAIN_HARNESS_REF) { $env:AGENT_BRAIN_HARNESS_REF } else { 'main' }

$flags = @($args)
if ($env:AGENT_BRAIN_HARNESS_ARGS) { $flags += ($env:AGENT_BRAIN_HARNESS_ARGS -split '\s+' | Where-Object { $_ }) }

function Fail($msg) { Write-Host "install: $msg" -ForegroundColor Red; exit 1 }

# 1. a Python that is 3.8 or newer
$py = $null
foreach ($name in @('py', 'python', 'python3')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) { continue }
    $probe = if ($name -eq 'py') { @('-3', '-c') } else { @('-c') }
    & $cmd.Source @probe 'import sys; sys.exit(sys.version_info < (3, 8))' 2>$null
    if ($LASTEXITCODE -eq 0) { $py = $cmd.Source; $pyArgs = if ($name -eq 'py') { @('-3') } else { @() }; break }
}
if (-not $py) { Fail 'Python 3.8 or newer is missing. Get it: winget install --id Python.Python.3.12 -e   (or python.org, tick "Add to PATH"). Then rerun.' }

# 2. the source: this folder (a clone) or a fresh shallow clone
$tmp = $null
$here = if ($PSScriptRoot) { $PSScriptRoot } else { $null }
if ($here -and (Test-Path (Join-Path $here 'harness.py')) -and (Test-Path (Join-Path $here 'install.py'))) {
    $src = $here
} else {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is missing, and it is needed to download the harness. Get it: winget install --id Git.Git -e. Then rerun.' }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('agent-brain-harness-' + [guid]::NewGuid().ToString('N'))
    Write-Host "Downloading $repo ($ref) ..."
    git clone -q --depth 1 --branch $ref $repo (Join-Path $tmp 'src')
    if ($LASTEXITCODE -ne 0) { Fail "could not download $repo" }
    $src = Join-Path $tmp 'src'
}

try {
    & $py @pyArgs (Join-Path $src 'install.py') --source $src @flags
    $code = $LASTEXITCODE
} finally {
    if ($tmp -and (Test-Path $tmp)) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}
if ($code -ne 0) { exit $code }
