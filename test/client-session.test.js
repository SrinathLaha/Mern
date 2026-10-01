import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transpileModule, ModuleKind } from "typescript";

test("a delayed protected write cannot retry under a different login", async () => {
  const source = await readFile(
    new URL("../../frontend/src/lib/api/client.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext },
  });
  const client = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}#account-switch`
  );
  const originalFetch = globalThis.fetch;
  let release;
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  const writes = [];
  client.setAccessToken("account-A");
  globalThis.fetch = async (path, options) => {
    if (path === "/api/auth/login" || path === "/api/auth/refresh")
      return Response.json({
        success: true,
        data: { accessToken: "account-B", user: { id: "B" } },
      });
    writes.push(options.headers.Authorization);
    if (writes.length === 1) return delayed;
    return Response.json({ success: true, data: {} });
  };
  try {
    const saving = client.protectedRequest("/account/profile", {
      method: "PATCH",
      body: JSON.stringify({ name: "Account A" }),
    });
    const rejected = assert.rejects(saving, /sign-in changed/);
    await client.publicRequest("/auth/login", { method: "POST", body: "{}" });
    release(Response.json({ success: false }, { status: 401 }));
    await rejected;
    assert.deepEqual(writes, ["Bearer account-A"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("protected writes retain method and body after an expired access token refresh", async () => {
  const source = await readFile(
    new URL("../../frontend/src/lib/api/client.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext },
  });
  const client = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}#write-test`
  );
  const originalFetch = globalThis.fetch;
  const calls = [];
  client.setAccessToken("expired");
  globalThis.fetch = async (path, options) => {
    calls.push({ path, ...options });
    if (path === "/api/auth/refresh")
      return Response.json({ success: true, data: { accessToken: "fresh" } });
    if (options.headers.Authorization === "Bearer expired")
      return Response.json({ success: false }, { status: 401 });
    return Response.json({ success: true, data: { saved: true } });
  };
  try {
    const body = JSON.stringify({ name: "Asha Rao", phone: "9876543210" });
    assert.deepEqual(
      await client.protectedRequest("/account/profile", {
        method: "PATCH",
        body,
      }),
      { saved: true },
    );
    assert.equal(calls.length, 3);
    assert.equal(calls[2].method, "PATCH");
    assert.equal(calls[2].body, body);
    assert.equal(calls[2].headers.Authorization, "Bearer fresh");
    assert.equal(calls[2].headers["Content-Type"], "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("late initial refresh cannot overwrite a new login session", async () => {
  // Exercise the real frontend client. Only the network and browser lock are controlled.
  const source = await readFile(
    new URL("../../frontend/src/lib/api/client.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext },
  });
  const client = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
  const originalFetch = globalThis.fetch;
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  let releaseRefresh;
  let observedAuthorization;
  const initialRefresh = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  let lockQueue = Promise.resolve();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: (_key, task) => {
          const result = lockQueue.then(task);
          lockQueue = result.catch(() => {});
          return result;
        },
      },
    },
  });
  globalThis.fetch = async (path, options) => {
    if (path === "/api/auth/refresh") return initialRefresh;
    if (path === "/api/auth/login")
      return Response.json({
        success: true,
        data: { accessToken: "new-login-token", user: { id: "user" } },
      });
    observedAuthorization = options.headers.Authorization;
    return Response.json({ success: true, data: { user: { id: "user" } } });
  };
  try {
    const restore = client.refreshSession().catch(() => null);
    await new Promise((resolve) => setImmediate(resolve));
    // Use the public mutation interface the provider uses, then release stale refresh.
    const signingIn = client
      .publicRequest("/auth/login", { method: "POST", body: "{}" })
      .then((session) => client.setAccessToken(session.accessToken));
    await new Promise((resolve) => setImmediate(resolve));
    releaseRefresh(
      Response.json(
        { success: false, message: "Please sign in again." },
        { status: 401 },
      ),
    );
    await Promise.all([restore, signingIn]);
    await client.protectedRequest("/auth/me");
    assert.equal(observedAuthorization, "Bearer new-login-token");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalNavigator)
      Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});
