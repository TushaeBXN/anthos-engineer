#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> ruff format"
uv run ruff format --check anthos_engineer/

echo "==> ruff check"
uv run ruff check anthos_engineer/

echo "==> pytest"
uv run pytest -v --tb=short

echo "All checks passed."
