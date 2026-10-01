import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";

const moduleUrl = new URL("../../scripts/dev-ports.mjs", import.meta.url);
test("development launcher skips occupied ports and keeps its frontend/API settings paired", async () => {
  const { reservePort, developmentSettings } = await import(moduleUrl.href);
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  const start = occupied.address().port;
  let first;
  let second;
  try {
    first = await reservePort(start, "127.0.0.1");
    second = await reservePort(first.port, "127.0.0.1");
    assert.ok(first.port > start);
    assert.ok(second.port > first.port);
    const settings = developmentSettings(first.port, second.port);
    assert.equal(settings.api.FRONTEND_URL, `http://localhost:${first.port}`);
    assert.equal(settings.api.PORT, String(second.port));
    assert.equal(settings.web.API_ORIGIN, `http://127.0.0.1:${second.port}`);
    assert.equal(settings.web.FRONTEND_ORIGIN, settings.api.FRONTEND_URL);
    assert.equal(settings.web.NEXT_DIST_DIR, `.next-dev/${first.port}`);
    await first.release();
    const reusable = await reservePort(first.port, "127.0.0.1");
    assert.equal(reusable.port, first.port);
    await reusable.release();
  } finally {
    await first?.release();
    await second?.release();
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test("development port selection rejects invalid ranges", async () => {
  const { reservePort } = await import(moduleUrl.href);
  for (const port of [0, -1, 65536, "bad", 3000.5])
    await assert.rejects(reservePort(port), /integer from 1 to 65535/);
});
