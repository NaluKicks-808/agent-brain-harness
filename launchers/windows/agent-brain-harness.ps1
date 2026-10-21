# Windows wrapper: finds Python (py launcher or python) and runs harness.py with all arguments.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script = Join-Path $root 'harness.py'
$py = $null
foreach ($name in @('py', 'python', 'python3')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $py = $cmd.Source; break }
}
if (-not $py) {
    Write-Error 'Python 3.8+ not found. Install from python.org or the Microsoft Store.'
    exit 1
}
& $py $script @args
exit $LASTEXITCODE
