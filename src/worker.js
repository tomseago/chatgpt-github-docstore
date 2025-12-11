const GITHUB_API_BASE = "https://api.github.com";

// Base64 helpers that work in both Cloudflare Workers and Node (for tests)
function toBase64(str) {
  if (typeof btoa === "function") {
    return btoa(str);
  } else if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf8").toString("base64");
  } else {
    throw new Error("No base64 encoder available for toBase64");
  }
}

function fromBase64(str) {
  if (typeof atob === "function") {
    return atob(str);
  } else if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "base64").toString("utf8");
  } else {
    throw new Error("No base64 decoder available for fromBase64");
  }
}

export async function githubRequest(method, path, env, body) {
  const url = `${GITHUB_API_BASE}${path}`;
  const headers = {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "cloudflare-docstore-worker"
  };

  const init = {
    method,
    headers,
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  if (!res.ok) {
    const message = (json && json.message) ? json.message : `GitHub API error ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    err.githubBody = json;
    throw err;
  }

  return json;
}

export function normalizeBaseDir(env) {
  const base = env.DOCS_BASE_DIR || "docs";
  return base.replace(/\/+$/, ""); // strip trailing slash
}

export function buildRepoPath(env, docPath) {
  const base = normalizeBaseDir(env);
  if (!docPath || docPath === "/") {
    return base;
  }
  const cleaned = docPath.replace(/^\/+/, "");
  return `${base}/${cleaned}`;
}

export async function getFile(env, docPath) {
  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = env;
  const repoPath = buildRepoPath(env, docPath);
  const apiPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(repoPath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

  return githubRequest("GET", apiPath, env);
}

export async function putFile(env, docPath, content, commitMessage) {
  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = env;
  const repoPath = buildRepoPath(env, docPath);
  const apiPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(repoPath)}`;

  let existingSha = null;
  try {
    const current = await getFile(env, docPath);
    existingSha = current.sha;
  } catch (err) {
    if (err.status !== 404) {
      throw err;
    }
  }

  const body = {
    message: commitMessage || (existingSha ? `Update ${repoPath}` : `Create ${repoPath}`),
    content: toBase64(content),
    branch: GITHUB_BRANCH
  };

  if (existingSha) {
    body.sha = existingSha;
  }

  return githubRequest("PUT", apiPath, env, body);
}

export async function deleteFile(env, docPath, commitMessage) {
  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = env;
  const repoPath = buildRepoPath(env, docPath);
  const apiPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(repoPath)}`;

  const current = await getFile(env, docPath);

  const body = {
    message: commitMessage || `Delete ${repoPath}`,
    sha: current.sha,
    branch: GITHUB_BRANCH
  };

  return githubRequest("DELETE", apiPath, env, body);
}

export async function listDocs(env, dirPath) {
  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH } = env;
  const repoPath = buildRepoPath(env, dirPath || "");
  const apiPath = `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(repoPath)}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

  const res = await githubRequest("GET", apiPath, env);
  if (!Array.isArray(res)) {
    return [res];
  }
  return res;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function notFound(message = "Not found") {
  return jsonResponse({ error: message }, 404);
}

function badRequest(message = "Bad request") {
  return jsonResponse({ error: message }, 400);
}

function checkAuth(request, env) {
  const path = new URL(request.url).pathname;
  // Allow unauthenticated health check on root path
  if (path === "/" && request.method === "GET") {
    return { ok: true };
  }

  const token = env.DOCSTORE_API_TOKEN;
  if (!token) {
    return { ok: false, status: 500, message: "DOCSTORE_API_TOKEN is not configured" };
  }
  const authHeader = request.headers.get("Authorization") || "";
  const expected = `Bearer ${token}`;
  if (authHeader !== expected) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  return { ok: true };
}

export default {
  async fetch(request, env, ctx) {
    try {
      const auth = checkAuth(request, env);
      if (!auth.ok) {
        return jsonResponse({ error: auth.message }, auth.status);
      }

      const url = new URL(request.url);
      const { pathname, searchParams } = url;

      // Health check (auth already allowed above)
      if (pathname === "/" && request.method === "GET") {
        return jsonResponse({ status: "ok" });
      }

      if (pathname === "/docs" && request.method === "GET") {
        const dir = searchParams.get("dir") || "";
        const items = await listDocs(env, dir);
        const mapped = items.map(item => ({
          name: item.name,
          path: item.path,
          type: item.type,
        }));
        return jsonResponse({ items: mapped });
      }

      if (pathname.startsWith("/docs/")) {
        const docPath = decodeURIComponent(pathname.substring("/docs/".length));

        if (request.method === "GET") {
          try {
            const file = await getFile(env, docPath);
            if (file.type !== "file") {
              return badRequest("Requested path is not a file");
            }
            const content = fromBase64(file.content);
            return jsonResponse({
              path: file.path,
              name: file.name,
              sha: file.sha,
              content
            });
          } catch (err) {
            if (err.status === 404) {
              return notFound("Document not found");
            }
            console.error("GET /docs error", err);
            return jsonResponse({ error: err.message || "Internal error" }, 500);
          }
        }

        if (request.method === "PUT") {
          let body;
          try {
            body = await request.json();
          } catch {
            return badRequest("Expected JSON body");
          }
          if (typeof body.content !== "string") {
            return badRequest("Field 'content' (string) is required");
          }
          const commitMessage = typeof body.message === "string" ? body.message : undefined;

          try {
            const result = await putFile(env, docPath, body.content, commitMessage);
            return jsonResponse({
              path: result.content.path,
              name: result.content.name,
              sha: result.content.sha,
              commit: {
                sha: result.commit.sha,
                message: result.commit.message
              }
            }, 200);
          } catch (err) {
            console.error("PUT /docs error", err);
            if (err.status === 404) {
              return notFound("Repository or branch not found");
            }
            return jsonResponse({ error: err.message || "Internal error" }, 500);
          }
        }

        if (request.method === "DELETE") {
          let body;
          try {
            body = await request.json();
          } catch {
            body = {};
          }
          const commitMessage = typeof body.message === "string" ? body.message : undefined;

          try {
            const result = await deleteFile(env, docPath, commitMessage);
            return jsonResponse({
              path: docPath,
              commit: {
                sha: result.commit.sha,
                message: result.commit.message
              }
            });
          } catch (err) {
            console.error("DELETE /docs error", err);
            if (err.status === 404) {
              return notFound("Document not found");
            }
            return jsonResponse({ error: err.message || "Internal error" }, 500);
          }
        }

        return jsonResponse({ error: "Method not allowed" }, 405);
      }

      return notFound();
    } catch (err) {
      console.error("Top-level error", err);
      return jsonResponse({ error: "Unexpected error", detail: err.message || String(err) }, 500);
    }
  }
};
