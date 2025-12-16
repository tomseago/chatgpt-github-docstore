import assert from "assert";
import worker, { buildRepoPath, putFile, logicalPathFromGitPath, toBase64, fromBase64 } from "../src/worker.js";

async function testBuildRepoPath() {
  const env = { DOCS_BASE_DIR: "docs" };
  assert.strictEqual(buildRepoPath(env, "ftl/canon.md"), "docs/ftl/canon.md");
  assert.strictEqual(buildRepoPath(env, "/ftl/canon.md"), "docs/ftl/canon.md");
  assert.strictEqual(buildRepoPath(env, ""), "docs");
  assert.strictEqual(buildRepoPath(env, "/"), "docs");
  // Paths already containing the base dir should not be double-prefixed
  assert.strictEqual(buildRepoPath(env, "docs/ftl/canon.md"), "docs/ftl/canon.md");
  assert.strictEqual(buildRepoPath(env, "/docs/ftl/canon.md"), "docs/ftl/canon.md");
  assert.strictEqual(buildRepoPath(env, "docs"), "docs");

  const env2 = { DOCS_BASE_DIR: "docs/" };
  assert.strictEqual(buildRepoPath(env2, "notes/test.md"), "docs/notes/test.md");
  assert.strictEqual(buildRepoPath(env2, "docs/notes/test.md"), "docs/notes/test.md");
}

async function testLogicalPathFromGitPath() {
  const env = { DOCS_BASE_DIR: "docs" };

  // Exact base dir should map to empty logical path
  assert.strictEqual(logicalPathFromGitPath(env, "docs"), "");

  // Paths under the base dir should have the prefix stripped
  assert.strictEqual(logicalPathFromGitPath(env, "docs/ftl/canon.md"), "ftl/canon.md");
  assert.strictEqual(logicalPathFromGitPath(env, "docs/notes"), "notes");
  assert.strictEqual(logicalPathFromGitPath(env, "docs/notes/test.md"), "notes/test.md");

  // Paths outside the base dir should be returned unchanged
  assert.strictEqual(logicalPathFromGitPath(env, "other/thing.md"), "other/thing.md");

  const env2 = { DOCS_BASE_DIR: "docs/" };
  // Trailing slash on DOCS_BASE_DIR should behave the same logically
  assert.strictEqual(logicalPathFromGitPath(env2, "docs/ftl/canon.md"), "ftl/canon.md");

  // Additional check: logicalPathFromGitPath does not add trailing slash itself
  // The trailing slash behavior is handled in the Worker mapping logic
  const logicalPath = logicalPathFromGitPath(env, "docs/ftl");
  assert.strictEqual(logicalPath, "ftl");
}

async function testBase64UnicodeRoundTrip() {
  const original = "Emoji 😘 and 漢字";
  const encoded = toBase64(original);
  assert.ok(typeof encoded === "string" && encoded.length > 0, "Expected non-empty base64 string");
  const decoded = fromBase64(encoded);
  assert.strictEqual(decoded, original, "Expected decoded string to match original with emoji and CJK");
}

async function testPutFileCreatesOn404() {
  const env = {
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_BRANCH: "main",
    DOCS_BASE_DIR: "docs",
    GITHUB_TOKEN: "fake-token"
  };

  let lastRequest = null;

  global.fetch = async (url, init) => {
    const u = new URL(url);
    // Simulate 404 on initial GET to check existence
    if (init.method === "GET" && u.pathname.includes("/contents/")) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ message: "Not Found" })
      };
    }

    // Simulate successful PUT for create
    if (init.method === "PUT" && u.pathname.includes("/contents/")) {
      lastRequest = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          content: { path: "docs/test.md", name: "test.md", sha: "sha123" },
          commit: { sha: "commitsha", message: "Create docs/test.md" }
        })
      };
    }

    return {
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ message: "Unexpected call in test" })
    };
  };

  const result = await putFile(env, "test.md", "Hello world", "Create test.md");
  // Basic shape checks
  assert.strictEqual(result.content.path, "docs/test.md");
  assert.strictEqual(result.commit.message, "Create docs/test.md");

  // Validate that the Worker constructed the correct GitHub URL and payload
  assert.ok(lastRequest, "Expected PUT request to GitHub");
  assert.ok(lastRequest.url.startsWith("https://api.github.com/repos/owner/repo/contents/"), "Unexpected GitHub URL");
  assert.ok(lastRequest.url.includes("docs%2Ftest.md"), "Expected path-encoded docs/test.md in URL");

  const body = JSON.parse(lastRequest.init.body);
  assert.strictEqual(body.branch, "main");
  assert.strictEqual(body.message, "Create test.md");
  assert.ok(typeof body.content === "string" && body.content.length > 0, "Expected base64 content string");
}

async function testWorkerPutResponsePathNormalized() {
  const env = {
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_BRANCH: "main",
    DOCS_BASE_DIR: "docs",
    DOCSTORE_API_TOKEN: "api-token",
    GITHUB_TOKEN: "fake-token"
  };

  global.fetch = async (url, init) => {
    const u = new URL(url);

    if (init.method === "GET" && u.pathname.includes("/contents/")) {
      return {
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ message: "Not Found" })
      };
    }

    if (init.method === "PUT" && u.pathname.includes("/contents/")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          content: { path: "docs/test.md", name: "test.md", sha: "sha123" },
          commit: { sha: "commitsha", message: "Create docs/test.md" }
        })
      };
    }

    return {
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ message: "Unexpected call in test" })
    };
  };

  const body = { content: "Hello world", message: "Create test.md" };
  const req = new Request("https://example.com/d/test.md", {
    method: "PUT",
    headers: {
      "Authorization": "Bearer api-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const res = await worker.fetch(req, env);
  assert.strictEqual(res.status, 200);
  const json = await res.json();

  // Ensure paths returned to the client are logical (no base dir prefix)
  assert.strictEqual(json.path, "test.md");
  assert.strictEqual(json.name, "test.md");
  assert.ok(json.commit && json.commit.sha, "Expected commit info in response");
}

async function testWorkerPostDeletePathNormalized() {
  const env = {
    GITHUB_OWNER: "owner",
    GITHUB_REPO: "repo",
    GITHUB_BRANCH: "main",
    DOCS_BASE_DIR: "docs",
    DOCSTORE_API_TOKEN: "api-token",
    GITHUB_TOKEN: "fake-token"
  };

  global.fetch = async (url, init) => {
    const u = new URL(url);

    if (init.method === "GET" && u.pathname.includes("/contents/")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          type: "file",
          path: "docs/test.md",
          name: "test.md",
          sha: "sha-file"
        })
      };
    }

    if (init.method === "DELETE" && u.pathname.includes("/contents/")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          commit: { sha: "commitsha", message: "Delete docs/test.md" }
        })
      };
    }

    return {
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ message: "Unexpected call in test" })
    };
  };

  const req = new Request("https://example.com/delete", {
    method: "POST",
    headers: {
      "Authorization": "Bearer api-token",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ path: "/docs/test.md", message: "Delete test" })
  });

  const res = await worker.fetch(req, env);
  assert.strictEqual(res.status, 200);
  const json = await res.json();

  // Ensure paths returned to the client are logical (no base dir prefix)
  assert.strictEqual(json.path, "test.md");
  assert.ok(json.commit && json.commit.sha === "commitsha");
}

async function testEchoReturnsRequestDetails() {
  const env = {
    DOCSTORE_API_TOKEN: "api-token"
  };

  const req = new Request("https://example.com/echo?foo=bar", {
    method: "POST",
    headers: {
      "Authorization": "Bearer api-token",
      "Content-Type": "application/json",
      "X-Test": "yes"
    },
    body: JSON.stringify({ hello: "world" })
  });

  const res = await worker.fetch(req, env);
  assert.strictEqual(res.status, 200);
  const json = await res.json();

  assert.strictEqual(json.method, "POST");
  assert.strictEqual(json.pathname, "/echo");
  assert.strictEqual(json.query.foo, "bar");
  assert.strictEqual(json.headers["x-test"], "yes");
  assert.ok(json.body.includes('"hello":"world"'), "Echo body should include posted JSON");
}

async function run() {
  try {
    await testBase64UnicodeRoundTrip();
    console.log("✓ base64 Unicode round-trip tests passed");

    await testLogicalPathFromGitPath();
    console.log("✓ logicalPathFromGitPath tests passed");

    await testBuildRepoPath();
    console.log("✓ buildRepoPath tests passed");

    await testPutFileCreatesOn404();
    console.log("✓ putFile create-on-404 tests passed");

    await testWorkerPutResponsePathNormalized();
    console.log("✓ worker PUT response path normalization tests passed");

    await testWorkerPostDeletePathNormalized();
    console.log("✓ worker POST /delete path normalization tests passed");

    await testEchoReturnsRequestDetails();
    console.log("✓ echo endpoint tests passed");

    console.log("All tests passed");
    process.exit(0);
  } catch (err) {
    console.error("Test failed:", err);
    process.exit(1);
  }
}

run();
