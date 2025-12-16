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

node_available=true
if ! command -v node >/dev/null 2>&1; then
  echo "Warning: node is not available; skipping content comparison and assuming read succeeded." >&2
  node_available=false
fi

timestamp="$(date -u +"%Y%m%d%H%M%S")"
doc_dir="tmp-${timestamp}"
doc_file="delete-test-${timestamp}.md"
doc_logical_path="${doc_dir}/${doc_file}"
doc_api_path="/d/${doc_logical_path}"

echo "Using temporary document path: ${doc_api_path}"

call_docstore() {
  local method="$1"
  local path="$2"
  local data="${3:-}"

  local bodyfile status
  bodyfile="$(mktemp)"
  local curl_opts=(-sS -o "$bodyfile" -w "%{http_code}" -X "$method" -H "Authorization: Bearer ${DOCSTORE_API_TOKEN}")
  if [[ -n "$data" ]]; then
    curl_opts+=(-H "Content-Type: application/json" -d "$data")
  fi

  status="$(curl "${curl_opts[@]}" "${DOCSTORE_WORKER_URL}${path}")"
  local body
  body="$(cat "$bodyfile")"
  rm -f "$bodyfile"

  if [[ "$status" != 2* ]]; then
    echo "Request ${method} ${path} failed with status ${status}" >&2
    echo "$body" >&2
    exit 1
  fi

  printf "%s" "$body"
}

echo "Creating document..."
initial_content="Initial delete test created at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
create_body="$(printf '{"content":"%s","message":"Create %s"}' "$initial_content" "$doc_logical_path")"
call_docstore "PUT" "$doc_api_path" "$create_body" > /dev/null
echo "Document created."

echo "Updating document..."
updated_content="Updated delete test at $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
update_body="$(printf '{"content":"%s","message":"Update %s"}' "$updated_content" "$doc_logical_path")"
call_docstore "PUT" "$doc_api_path" "$update_body" > /dev/null
echo "Document updated."

echo "Reading document for verification..."
read_body="$(call_docstore "GET" "$doc_api_path")"

if [[ "$node_available" == true ]]; then
  read_content="$(
    printf '%s' "$read_body" | node -e "const fs=require('fs');const data=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(data.content||'');"
  )"

  if [[ "$read_content" != "$updated_content" ]]; then
    echo "Content mismatch after update."
    echo "Expected: $updated_content"
    echo "Actual:   $read_content"
    exit 1
  fi
  echo "Read content matches updated content."
else
  echo "Read request succeeded; skipping content comparison because node is unavailable."
fi

echo "Deleting document..."
delete_body="$(printf '{"message":"Delete %s"}' "$doc_logical_path")"
call_docstore "DELETE" "$doc_api_path" "$delete_body" > /dev/null
echo "Document deleted."

echo "Delete workflow completed successfully."
