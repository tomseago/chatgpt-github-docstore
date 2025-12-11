#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DOCSTORE_WORKER_URL:-}" ]]; then
  echo "DOCSTORE_WORKER_URL environment variable is not set" >&2
  exit 1
fi

if [[ -z "${DOCSTORE_API_TOKEN:-}" ]]; then
  echo "DOCSTORE_API_TOKEN environment variable is not set" >&2
  exit 1
fi

METHOD="${1:-GET}"
PATH="${2:-/docs}"
DATA="${3:-}"

if [[ "$METHOD" == "GET" || "$METHOD" == "DELETE" ]]; then
  curl -i -X "$METHOD"         -H "Authorization: Bearer ${DOCSTORE_API_TOKEN}"         "${DOCSTORE_WORKER_URL}${PATH}"
else
  curl -i -X "$METHOD"         -H "Authorization: Bearer ${DOCSTORE_API_TOKEN}"         -H "Content-Type: application/json"         -d "${DATA}"         "${DOCSTORE_WORKER_URL}${PATH}"
fi
