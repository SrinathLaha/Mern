import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transpileModule, ModuleKind } from "typescript";

test("polling proxy only forwards same-origin bounded requests and does not leak cookies", async () => {
  const source = await readFile(
    new URL(
      "../../frontend/src/app/api/realtime/socket.io/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const { outputText } = transpileModule(source, {
    compilerOptions: { module: ModuleKind.ESNext },
  });
  const proxy = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response("socket-packet", {
      headers: {
        "Content-Type": "text/plain",
        "Set-Cookie": "should-not-forward=1",
      },
    });
  };
  const req = (headers = {}, method = "GET", body) =>
    new Request(
      "http://localhost:3000/api/realtime/socket.io?EIO=4&transport=polling",
      {
        method,
        headers: {
          Host: "localhost:3000",
          "Sec-Fetch-Site": "same-origin",
          ...headers,
        },
        body,
      },
    );
  try {
    const response = await proxy.GET(req({ Cookie: "refresh=private" }));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "socket-packet");
    assert.equal(calls[0].options.headers.Origin, "http://localhost:3000");
    assert.equal(calls[0].options.headers.Cookie, undefined);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(
      (await proxy.GET(req({ Origin: "https://evil.test" }))).status,
      403,
    );
    assert.equal(
      (await proxy.GET(req({ "Sec-Fetch-Site": "cross-site" }))).status,
      403,
    );
    assert.equal((await proxy.GET(req({ Host: "evil.test" }))).status, 403);
    assert.equal(
      (
        await proxy.POST(
          req({ Origin: "http://localhost:3000" }, "POST", "x".repeat(17000)),
        )
      ).status,
      413,
    );
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
