import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transpileModule, ModuleKind } from "typescript";

const source = await readFile(
  new URL("../../frontend/src/lib/api/client.ts", import.meta.url),
  "utf8",
);
const { outputText } = transpileModule(source, {
  compilerOptions: { module: ModuleKind.ESNext },
});
let sequence = 0;
const loadClient = () =>
  import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}#storage-${sequence++}`
  );
const token = (user, session = "session") =>
  `header.${Buffer.from(JSON.stringify({ sub: user, sid: session })).toString("base64url")}.signature`;
const ok = (data) => Response.json({ success: true, data });

test("realtime authentication refreshes an expired token before exposing it", () =>
  environment(async () => {
    const client = await loadClient();
    client.setAccessToken("expired");
    globalThis.fetch = async (path, options) => {
      if (path === "/api/auth/refresh") return ok({ accessToken: "fresh" });
      return options.headers.Authorization === "Bearer expired"
        ? Response.json({ success: false }, { status: 401 })
        : ok({ user: { id: "customer" } });
    };
    assert.equal(await client.getRealtimeAccessToken(), "fresh");
  }));

test("realtime authentication rejects a token from a changed session", () =>
  environment(async () => {
    const client = await loadClient();
    client.setAccessToken("first");
    let release;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const result = client.getRealtimeAccessToken();
    const rejected = assert.rejects(result, /sign-in changed/);
    client.setAccessToken("second");
    release(ok({ user: { id: "first" } }));
    await rejected;
  }));
async function environment(run) {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  try {
    await run(storage, values);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow)
      Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  }
}

test("login stores only accessToken and a new page client uses it without refresh", () =>
  environment(async (storage, values) => {
    const accessToken = token("customer");
    globalThis.fetch = async () =>
      ok({ accessToken, user: { id: "customer" } });
    const first = await loadClient();
    await first.publicRequest("/auth/login", { method: "POST", body: "{}" });
    assert.equal(storage.getItem("accessToken"), accessToken);
    assert.deepEqual([...values.keys()], ["accessToken"]);
    const nextPage = await loadClient();
    const calls = [];
    globalThis.fetch = async (path, options) => {
      calls.push({ path, authorization: options.headers.Authorization });
      return ok({ user: { id: "customer" } });
    };
    await nextPage.protectedRequest("/auth/me");
    assert.deepEqual(calls, [
      { path: "/api/auth/me", authorization: `Bearer ${accessToken}` },
    ]);
  }));

test("expired stored token refreshes, persists replacement and retries the request", () =>
  environment(async (storage) => {
    const old = token("customer"),
      fresh = token("customer") + "fresh";
    storage.setItem("accessToken", old);
    const client = await loadClient();
    const calls = [];
    globalThis.fetch = async (path, options) => {
      calls.push(path);
      if (path === "/api/auth/refresh")
        return ok({ accessToken: fresh, user: { id: "customer" } });
      if (options.headers.Authorization === `Bearer ${old}`)
        return Response.json({ success: false }, { status: 401 });
      return ok({ saved: true });
    };
    assert.deepEqual(
      await client.protectedRequest("/account/profile", {
        method: "PATCH",
        body: "{}",
      }),
      { saved: true },
    );
    assert.equal(storage.getItem("accessToken"), fresh);
    assert.deepEqual(calls, [
      "/api/account/profile",
      "/api/auth/refresh",
      "/api/account/profile",
    ]);
  }));

test("logout, reset and an invalid refresh remove stored access; transient errors preserve it", () =>
  environment(async (storage) => {
    for (const path of ["/auth/logout", "/auth/reset-password"]) {
      storage.setItem("accessToken", token("customer"));
      const client = await loadClient();
      globalThis.fetch = async () => ok(null);
      await client.publicRequest(path, { method: "POST", body: "{}" });
      assert.equal(storage.getItem("accessToken"), null);
    }
    storage.setItem("accessToken", token("customer"));
    const client = await loadClient();
    globalThis.fetch = async () => {
      throw new Error("offline");
    };
    await assert.rejects(client.refreshSession());
    assert.equal(storage.getItem("accessToken"), token("customer"));
    globalThis.fetch = async () =>
      Response.json({ success: false }, { status: 401 });
    await assert.rejects(client.refreshSession());
    assert.equal(storage.getItem("accessToken"), null);
  }));

test("storage account changes reject old writes while same-session rotation keeps requests valid", () =>
  environment(async (storage) => {
    for (const changedAccount of [false, true]) {
      storage.setItem("accessToken", token("A"));
      const client = await loadClient();
      let release;
      globalThis.fetch = () =>
        new Promise((resolve) => {
          release = resolve;
        });
      const pending = client.protectedRequest("/account/profile", {
        method: "PATCH",
        body: "{}",
      });
      const result = pending.then(
        () => "saved",
        (error) => error.message,
      );
      storage.setItem(
        "accessToken",
        changedAccount ? token("B") : token("A") + "rotated",
      );
      client.restoreAccessToken();
      release(ok({ saved: true }));
      if (changedAccount) assert.match(await result, /sign-in changed/);
      else assert.equal(await result, "saved");
      assert.equal(
        storage.getItem("accessToken"),
        changedAccount ? token("B") : token("A") + "rotated",
      );
    }
  }));

test("blocked localStorage does not prevent in-memory authentication", () =>
  environment(async (storage) => {
    storage.getItem =
      storage.setItem =
      storage.removeItem =
        () => {
          throw new Error("Storage blocked");
        };
    const client = await loadClient();
    globalThis.fetch = async (path, options) =>
      path === "/api/auth/login"
        ? ok({ accessToken: token("A"), user: { id: "A" } })
        : ok({ authorization: options.headers.Authorization });
    await client.publicRequest("/auth/login", { method: "POST", body: "{}" });
    assert.deepEqual(await client.protectedRequest("/auth/me"), {
      authorization: `Bearer ${token("A")}`,
    });
  }));
