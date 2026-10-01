import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecoveryJobs } from "../src/jobs/recovery.jobs.js";

test("recovery queue bounds work before account lookup and drains accepted jobs on close", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const delivered = [];
  const jobs = createRecoveryJobs(
    async (email) => {
      await held;
      delivered.push(email);
    },
    { concurrency: 1, capacity: 2 },
  );
  assert.equal(jobs.enqueue("first@example.test"), true);
  assert.equal(jobs.enqueue("second@example.test"), true);
  assert.equal(jobs.enqueue("third@example.test"), false);
  const closing = jobs.close();
  assert.equal(jobs.enqueue("late@example.test"), false);
  release();
  await closing;
  assert.deepEqual(delivered, ["first@example.test", "second@example.test"]);
});

test("same-email jobs stay in request order while a different email can progress", async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = [];
  const delivered = [];
  let occurrence = 0;
  const jobs = createRecoveryJobs(async (email) => {
    const label =
      email === "same@example.test" ? `same-${++occurrence}` : "other";
    started.push(label);
    if (label === "same-1") await held;
    delivered.push(label);
  });
  jobs.enqueue("same@example.test");
  jobs.enqueue("same@example.test");
  jobs.enqueue("other@example.test");
  await new Promise((resolve) => setImmediate(resolve));
  const beforeRelease = [...started];
  release();
  await jobs.idle();
  assert.deepEqual(beforeRelease, ["same-1", "other"]);
  assert.ok(delivered.indexOf("same-1") < delivered.indexOf("same-2"));
});
