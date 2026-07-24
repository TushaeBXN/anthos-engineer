Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
Push-Location "$PSScriptRoot/.."

Write-Host "==> ruff format"
uv run ruff format --check anthos_engineer/

Write-Host "==> ruff check"
uv run ruff check anthos_engineer/

Write-Host "==> pytest"
uv run pytest -v --tb=short

Write-Host "All checks passed."
Pop-Location
