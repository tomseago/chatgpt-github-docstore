import { normalizeBaseDir } from "./utils.js";

async function checkAuth(request, env) {
  const { pathname, method } = new URL(request.url);

  // Allow unauthenticated access only for health check at /health GET
  if (pathname === "/health" && method === "GET") {
    return true;
  }

  // All other routes require a valid Bearer token
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }
  const token = authHeader.substring("Bearer ".length);
  return token === env.DOCSTORE_API_TOKEN;
}

function logicalPathFromGitPath(env, gitPath) {
  const base = normalizeBaseDir(env);
  if (gitPath === base) {
    return "";
  }
  if (gitPath.startsWith(base + "/")) {
    return gitPath.substring(base.length + 1);
  }
  return gitPath;
}

async function listDocs(env, dir) {
  const baseDir = normalizeBaseDir(env);
  const path = dir ? `${baseDir}/${dir}` : baseDir;
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (!resp.ok) {
    throw new Error(`GitHub API error: ${resp.status}`);
  }

  const items = await resp.json();

  if (!Array.isArray(items)) {
    throw new Error("Expected directory listing to be an array");
  }

  return items.map((item) => ({
    name: item.name,
    path: logicalPathFromGitPath(env, item.path),
    type: item.type,
  }));
}

async function getDoc(env, docPath) {
  const baseDir = normalizeBaseDir(env);
  const path = `${baseDir}/${docPath}`;
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}?ref=${env.GITHUB_BRANCH}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  if (resp.status === 404) {
    return null;
  }

  if (!resp.ok) {
    throw new Error(`GitHub API error: ${resp.status}`);
  }

  const file = await resp.json();
  const content = atob(file.content.replace(/\n/g, ""));

  return {
    path: logicalPathFromGitPath(env, file.path),
    content,
    sha: file.sha,
  };
}

async function putDoc(env, docPath, content, message, sha = null) {
  const baseDir = normalizeBaseDir(env);
  const path = `${baseDir}/${docPath}`;
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;

  const body = {
    message,
    content: btoa(content),
    branch: env.GITHUB_BRANCH,
  };
  if (sha) {
    body.sha = sha;
  }

  const resp = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`GitHub API error: ${resp.status}`);
  }

  return await resp.json();
}

async function deleteDoc(env, docPath, message, sha) {
  const baseDir = normalizeBaseDir(env);
  const path = `${baseDir}/${docPath}`;
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`;

  const body = {
    message,
    sha,
    branch: env.GITHUB_BRANCH,
  };

  const resp = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`GitHub API error: ${resp.status}`);
  }

  return await resp.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname, method } = url;

    // Check authentication
    const authorized = await checkAuth(request, env);
    if (!authorized) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }

    // Health check at /health
    if (pathname === "/health" && method === "GET") {
      return new Response(
        JSON.stringify({ status: "ok" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // List documents at root "/"
    if (pathname === "/" && method === "GET") {
      try {
        const docs = await listDocs(env, "");
        return new Response(
          JSON.stringify(docs),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: e.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
    }

    // All other paths treated as document paths
    if (pathname !== "/health") {
      const docPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;

      if (method === "GET") {
        try {
          const doc = await getDoc(env, docPath);
          if (!doc) {
            return new Response(
              JSON.stringify({ error: "Not found" }),
              { status: 404, headers: { "Content-Type": "application/json" } }
            );
          }
          return new Response(
            JSON.stringify(doc),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } catch (e) {
          return new Response(
            JSON.stringify({ error: e.message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      if (method === "PUT") {
        try {
          const data = await request.json();
          if (!data.content || !data.message) {
            return new Response(
              JSON.stringify({ error: "Missing content or message" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
          // Check if file exists to get sha
          let sha = null;
          try {
            const existing = await getDoc(env, docPath);
            if (existing) {
              sha = existing.sha;
            }
          } catch {}

          const result = await putDoc(env, docPath, data.content, data.message, sha);
          return new Response(
            JSON.stringify({ commit: result.commit }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } catch (e) {
          return new Response(
            JSON.stringify({ error: e.message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      if (method === "DELETE") {
        try {
          const data = await request.json();
          if (!data.message) {
            return new Response(
              JSON.stringify({ error: "Missing message" }),
              { status: 400, headers: { "Content-Type": "application/json" } }
            );
          }
          // Need sha of existing file to delete
          const existing = await getDoc(env, docPath);
          if (!existing) {
            return new Response(
              JSON.stringify({ error: "Not found" }),
              { status: 404, headers: { "Content-Type": "application/json" } }
            );
          }
          const result = await deleteDoc(env, docPath, data.message, existing.sha);
          return new Response(
            JSON.stringify({ commit: result.commit }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        } catch (e) {
          return new Response(
            JSON.stringify({ error: e.message }),
            { status: 500, headers: { "Content-Type": "application/json" } }
          );
        }
      }

      return new Response(
        JSON.stringify({ error: "Method not allowed" }),
        { status: 405, headers: { "Content-Type": "application/json" } }
      );
    }

    // If no route matched
    return new Response(
      JSON.stringify({ error: "Not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  },
};
