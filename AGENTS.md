# Repository Guidelines

## Project Structure & Modules
- `src/worker.js` contains the Cloudflare Worker and helper utilities (`buildRepoPath`, `putFile`, base64 helpers).
- `test/github.test.js` holds Node tests that stub `fetch` to validate GitHub interactions.
- `scripts/call-docstore.sh` is a curl helper for hitting a deployed worker.
- `wrangler.toml` defines the worker entrypoint plus GitHub/docstore config vars; secrets are set via `wrangler secret`.
- `openapi.yaml` exposes the Action schema; update it when the HTTP surface changes.

## Build, Test, and Development Commands
- `npm install` — prepare the Node test environment (no external deps today, but locks versions).
- `npm test` — runs `test/github.test.js` with Node’s `assert`; expected to pass before PRs.
- `npx wrangler dev` — local Worker sandbox; set `GITHUB_*`, `DOCS_BASE_DIR`, and `DOCSTORE_API_TOKEN` secrets first.
- `npx wrangler deploy` — publish to Cloudflare; uses `wrangler.toml` and stored secrets.
- `./scripts/call-docstore.sh GET "/"` — quick sanity check against a deployed worker; set `DOCSTORE_WORKER_URL` and `DOCSTORE_API_TOKEN`.

## Coding Style & Naming
- JavaScript ES modules, 2-space indentation, semicolons optional but match existing style (current files omit them).
- Prefer small, pure helpers for path logic; keep request handlers thin and reuse shared utilities.
- Use descriptive names: `docPath` for logical paths, `repoPath` for GitHub paths, `env` for config.
- Avoid hard-coding secrets or owners; always read from `env` and `wrangler.toml`.

## Testing Guidelines
- Add or extend tests in `test/github.test.js`; stub `global.fetch` for GitHub flows.
- Cover new branches (404 handling, auth checks, content transforms) when touching `worker.js`.
- Keep tests deterministic and fast; no live GitHub calls.
- Run `npm test` before committing; include notable outputs or failures in PR notes.

## Commit & Pull Request Guidelines
- Commits: imperative subject lines (`Add listDocs error handling`), keep them focused; include context if changing API surface.
- PRs: summarize behavior changes, list testing performed (`npm test`, manual curl), and link issues. Include before/after examples for API or schema changes (paths, payloads).
- Avoid committing secrets or tokens; verify `wrangler.toml` changes don’t expose sensitive values.

## Security & Configuration Tips
- Required secrets: `GITHUB_TOKEN` (repo scope) and `DOCSTORE_API_TOKEN`; set via `wrangler secret put ...`.
- Keep `DOCS_BASE_DIR` stable; changes affect path mappings—update tests and docs together.
- When altering GitHub calls, ensure `User-Agent` and `Accept` headers remain set and handle non-2xx with clear error messages.
