# DocStore Middleware – Cloudflare Worker + GitHub

This repository contains a Cloudflare Worker that exposes a small JSON API for a **document store** backed by a **GitHub repository**. It is designed to act as middleware between tools (for example, a ChatGPT Custom GPT Action) and a canonical document repository stored in Git.

The Worker offers a stable HTTP surface for **create / read / update / delete (CRUD)** operations on text documents (typically Markdown) while persisting every change as a real Git commit in a GitHub repo. Authentication is enforced with a simple **Bearer token** so only authorized clients can use the docstore.

---

## Goals and Design Rationale

The Worker is intended to solve the following problems:

1. **Persistent, canonical storage**  
   LLM interactions often generate or edit documents (worldbuilding canon, outlines, notes, specs). Storing these only inside a chat or UI-specific file store is fragile. Instead, this Worker treats a GitHub repository as the **source of truth**, with normal Git history, branches, and tooling.

2. **Simple, tool-friendly HTTP API**  
   The Worker exposes a minimal, action-friendly API with just a few endpoints under the Worker’s document API (/, /{path}). This keeps integration easy for tools like ChatGPT Actions, scripts, or other services.

3. **Separation of concerns**  
   - Cloudflare Worker handles HTTP, simple auth, and translation of logical doc paths to GitHub API calls.  
   - GitHub handles persistence, history, access control, and backup.  
   - The client (e.g., LLM) focuses on content generation and editing.

4. **Human-friendly document structure**  
   Documents are regular files under a configurable base directory in the repo (e.g. `docs/ftl/canon.md`, `docs/course/outline.md`). You can browse and edit them with any Git tool.

5. **API-level access controls via Bearer token**  
   The Worker enforces a simple **Bearer token** (`Authorization: Bearer <token>`) stored as a Cloudflare secret. This prevents casual or accidental use of the docstore API by unauthorized clients.

---

## High-Level Architecture

- **Client** (e.g. ChatGPT Custom GPT, CLI script, other service)  
  Calls the Worker’s document API (/, /{path}) with JSON payloads and an Authorization header.

- **Cloudflare Worker (this repo)**  
  - Validates the Bearer token (`DOCSTORE_API_TOKEN` secret).  
  - Maps logical document paths to file paths in a GitHub repo under a base directory (e.g. `docs/`).  
  - Uses the GitHub REST API to:
    - Read files (`GET /repos/{owner}/{repo}/contents/...`)  
    - Create or update files via base64 content (`PUT /repos/{owner}/{repo}/contents/...`)  
    - Delete files (`DELETE /repos/{owner}/{repo}/contents/...`)  
    - List directory contents (`GET /repos/{owner}/{repo}/contents/...` when it is a directory)

- **GitHub Repository (backing store)**  
  - Holds all documents as regular files.  
  - Tracks changes through commits on a branch (e.g. `main`).  
  - Can be used directly by humans (IDE, Git CLI, GitHub web UI).

---

## API Summary

Base URL will look like:

```text
https://YOUR-WORKER-NAME.YOUR-ACCOUNT.workers.dev
```

All endpoints except `/health` require:

```http
Authorization: Bearer DOCSTORE_API_TOKEN
```

### Health check

```http
GET /health
```

Returns a simple JSON payload; does **not** require auth and is intended as a basic liveness check.

### List documents in a directory

```http
GET /
```

- Lists names and paths (files and subdirectories) under the root docs directory. Directory entries in the response will have a `type` of `"dir"` and their `path` will end with a trailing slash (for example, `"ftl/"`).

```http
GET /ftl/
```

- Lists the contents of the `ftl` directory. As with the root listing, directory entries will be reported with trailing slashes in `path` and `type: "dir"`.

### Get a document

```http
GET /ftl/canon.md
```

Returns JSON including the raw `content` field (e.g. Markdown).

### Create or update (upsert) a document

```http
PUT /ftl/canon.md
Content-Type: application/json

{
  "content": "# FTL Canon\n\nUpdated content...",
  "message": "Update FTL canon after adding station list"
}
```

- If the file does not exist, it is created.
- If the file exists, it is updated.
- A commit is created on the configured branch in GitHub.

### Delete a document

```http
DELETE /ftl/canon.md
Content-Type: application/json

{
  "message": "Remove obsolete FTL canon draft"
}
```

Removes the file from the GitHub repo and creates a commit with the specified message.

---

## Authentication Model

The Worker enforces a simple shared-secret Bearer token:

- Cloudflare secret: `DOCSTORE_API_TOKEN`
- Clients must send:
  - `Authorization: Bearer <DOCSTORE_API_TOKEN>`

All endpoints except `/health` require auth and requests without a valid token receive `401 Unauthorized`.  
The health check (`GET /health`) remains unauthenticated for ease of monitoring.

---

## Repository Layout

This middleware repo has the following structure:

```text
.
├── README.md
├── wrangler.toml
├── src
│   └── worker.js
├── test
│   └── github.test.js
├── scripts
│   └── call-docstore.sh
├── openapi.yaml
├── package.json
└── .gitignore
```

- `src/worker.js` – Cloudflare Worker implementation.  
- `wrangler.toml` – Worker configuration (entrypoint, vars).  
- `scripts/call-docstore.sh` – Convenience script to call the deployed Worker via curl.  
- `test/github.test.js` – Node-based unit test that exercises the GitHub integration logic.  
- `openapi.yaml` – OpenAPI schema describing the document API surface (suitable for use as a ChatGPT Action definition).  
- `package.json` – Minimal Node configuration to run tests.  
- `.gitignore` – Standard ignore rules.

---

## GitHub Integration Details

The Worker uses the GitHub REST API v3:

- **Base URL**: `https://api.github.com`
- Each document is mapped to a file path inside the repo:
  - Logical doc path: `ftl/canon.md`
  - Repo path: `DOCS_BASE_DIR/ftl/canon.md` (e.g. `docs/ftl/canon.md`)

Required environment configuration (via `wrangler.toml` and secrets):

- `GITHUB_OWNER` – Username or org owning the repo.  
- `GITHUB_REPO` – Repository name (e.g. `docstore`).  
- `GITHUB_BRANCH` – Branch name to commit to (e.g. `main`).  
- `DOCS_BASE_DIR` – Base directory inside the repo for documents (e.g. `docs`).  
- `GITHUB_TOKEN` – Secret GitHub Personal Access Token with `repo` (read/write) scope.  
- `DOCSTORE_API_TOKEN` – Secret Bearer token for client access.

The Worker will:

- Use `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` to list or fetch files.  
- Use `PUT /repos/{owner}/{repo}/contents/{path}` to create or update files.  
- Use `DELETE /repos/{owner}/{repo}/contents/{path}` to delete files.

All file content is transmitted as base64-encoded text, per GitHub API requirements.

---

## Setting Up a New Worker Using This Repo

This section assumes:

- You want this repo to be the “middleware” between tools (e.g. ChatGPT) and GitHub.  
- You will deploy the Worker, then separately create the GitHub docstore repo it will talk to.

### 1. Create a new GitHub repository for the middleware

On GitHub:

1. Create a new repo, e.g. `docstore-middleware`.  
2. Clone it locally.

```bash
git clone git@github.com:YOUR-GITHUB-USER/docstore-middleware.git
cd docstore-middleware
```

3. Unzip the contents provided for this project into the repo directory and commit them:

```bash
# assuming docstore-middleware.zip has been downloaded
unzip /path/to/docstore-middleware.zip -d .
git add .
git commit -m "Initial commit: docstore middleware worker"
git push origin main
```

### 2. Install Wrangler (if not already installed)

```bash
npm install -g wrangler
# or
pnpm add -g wrangler
```

Login:

```bash
wrangler login
```

### 3. Configure `wrangler.toml`

Open `wrangler.toml` and set:

- `name` – A unique Worker name.  
- Optionally adjust `compatibility_date`.  
- Fill `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`, and `DOCS_BASE_DIR` under `[vars]`.

### 4. Create the backing docstore repo

Create the repository that will store the actual documents, e.g. `docstore` or `arcadia-docs`, and ensure it has at least one commit (e.g., add a `README.md`). Note the:

- Owner (user/org)  
- Repo name  
- Default branch (e.g. `main`)  

These must match your `wrangler.toml` vars.

### 5. Create a GitHub Personal Access Token

1. Go to GitHub → Settings → Developer settings → Personal access tokens.  
2. Create a classic PAT with at least:
   - `repo` scope for the target repo (or your whole account/org if you prefer).  
3. Copy the token.

Set it as a secret in your Worker:

```bash
wrangler secret put GITHUB_TOKEN
# paste the token when prompted
```

### 6. Set the DocStore API Bearer Token

Choose a random secret token for clients to use (for example, a UUID). Then:

```bash
wrangler secret put DOCSTORE_API_TOKEN
# paste your chosen bearer token
```

Clients must send:

```http
Authorization: Bearer YOUR-TOKEN-HERE
```

---

## Deploying the Worker

From the repo directory:

```bash
wrangler deploy
```

Wrangler will output the Worker’s URL, typically:

```text
https://YOUR-WORKER-NAME.YOUR-ACCOUNT.workers.dev
```

You can now use that URL with the `scripts/call-docstore.sh` script or any HTTP client.

---

## Using the Test Script (`scripts/call-docstore.sh`)

The `call-docstore.sh` script is a small helper to exercise the Worker after deployment.

### 1. Export environment variables

```bash
export DOCSTORE_WORKER_URL="https://YOUR-WORKER-NAME.YOUR-ACCOUNT.workers.dev"
export DOCSTORE_API_TOKEN="YOUR-BEARER-TOKEN"
```

### 2. Example calls

- **List root docs directory:**

  ```bash
  ./scripts/call-docstore.sh GET "/"
  ```

- **List a subdirectory (e.g. `ftl`):**

  ```bash
  ./scripts/call-docstore.sh GET "/ftl/"
  ```

- **Create or update a document:**

  ```bash
  ./scripts/call-docstore.sh PUT "/ftl/canon.md"         '{"content":"# FTL Canon\n\nHello from the docstore.","message":"Create initial canon"}'
  ```

- **Get that document:**

  ```bash
  ./scripts/call-docstore.sh GET "/ftl/canon.md"
  ```

- **Delete that document:**

  ```bash
  ./scripts/call-docstore.sh DELETE "/ftl/canon.md"         '{"message":"Remove test doc"}'
  ```

---

## Running Unit Tests (Node)

This repo includes a minimal Node-based unit test that exercises the GitHub-related logic in `src/worker.js` (without actually calling GitHub). It does this by:

- Importing helper functions from `src/worker.js`.  
- Stubbing `global.fetch` to simulate GitHub API responses.  
- Verifying that:
  - Paths are constructed correctly.  
  - Base64 encoding behaves as expected.  
  - The correct HTTP method and payload are used.

### 1. Install Node dependencies

There are no external libraries, but you should run:

```bash
npm install
```

(This will create `package-lock.json` if it does not exist.)

### 2. Run the tests

```bash
npm test
```

On success, you should see console output indicating all tests passed. The script exits with a non-zero status if any assertion fails.

---

## Using This Worker as Middleware for a ChatGPT Custom GPT Action

To use this Worker as a backend for a ChatGPT Custom GPT:

1. Deploy the Worker and confirm it works via the test script.  
2. Use the `openapi.yaml` file in this repo as the API schema when configuring a Custom GPT “Action”.  
3. Set the server URL in the Action configuration to your Worker’s URL.  
4. In the GPT’s instructions, encourage it to:
   - Use logical paths like `ftl/canon.md`, `course/outline.md`, etc.  
   - Treat `content` fields as Markdown.  
   - Provide meaningful commit messages for changes.

Once configured, the GPT can:

- Create and update rich text documents in the GitHub-backed docstore.  
- Retrieve documents later to modify or reference them.  
- Use the docstore across multiple sessions and workflows.

---

## Notes and Future Extensions

Possible enhancements:

- Version listing (exposing commit history per document).  
- Branch selection per request (instead of a fixed branch).  
- Soft-deletes or archiving instead of hard deletes.  
- Additional metadata files or a manifest to track doc relationships.  
- Support for binary assets (currently focused on text).

For now, this repository provides a focused, pragmatic starting point: a small, auditable middleware layer that gives tools like ChatGPT stable, Git-backed document persistence via a simple HTTP API.
