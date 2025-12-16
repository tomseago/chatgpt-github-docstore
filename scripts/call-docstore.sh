#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
env_file="$repo_root/env.local"
# Load optional defaults from env.local only when vars are missing; explicit env values win.
if [[ -f "$env_file" && ( -z "${DOCSTORE_WORKER_URL:-}" || -z "${DOCSTORE_API_TOKEN:-}" ) ]]; then
  . "$env_file"
fi

if [[ -z "${DOCSTORE_WORKER_URL:-}" ]]; then
  echo "DOCSTORE_WORKER_URL environment variable is not set" >&2
  exit 1
fi

if [[ -z "${DOCSTORE_API_TOKEN:-}" ]]; then
  echo "DOCSTORE_API_TOKEN environment variable is not set" >&2
  exit 1
fi

METHOD="${1:-GET}"
FPATH="${2:-/}"
DATA="${3:-}"

if [[ "$METHOD" == "GET" || "$METHOD" == "DELETE" ]]; then
  curl -i -X "$METHOD"         -H "Authorization: Bearer ${DOCSTORE_API_TOKEN}"         "${DOCSTORE_WORKER_URL}${FPATH}"
else
  curl -i -X "$METHOD"         -H "Authorization: Bearer ${DOCSTORE_API_TOKEN}"         -H "Content-Type: application/json"         -d "${DATA}"         "${DOCSTORE_WORKER_URL}${FPATH}"
fi
