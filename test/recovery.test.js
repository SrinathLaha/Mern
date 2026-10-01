import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../src/app.js";
import { requestPasswordReset } from "../src/services/recovery.service.js";

const id = randomUUID().replaceAll("-", "");
const databaseName = `marketplace_test_${id}`;
const outbox = path.resolve(`../work/recovery-test-${id}`);
const config = {
  nodeEnv: "test",
  recoveryLimit: 1000,
  frontendOrigin: "http://localhost:3000",
  jwtSecret: "test-only-secret-that-is-at-least-48-characters-long",
  mail: { mode: "local", outbox, from: "noreply@example.test" },
};
let app;
const customer = {
  name: "Asha Sharma",
  email: "recovery@example.test",
  phone: "9876543210",
  password: "Original password 123!",
  accountType: "customer",
};
const replacement = "A different secure passphrase!";
const post = (route, body, target = app) =>
  request(target)
    .post(`/api/auth/${route}`)
    .set("Origin", config.frontendOrigin)
    .send(body);
const users = () => mongoose.connection.collection("users");
const me = (token) =>
  request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
const resetBody = (token) => ({
  token,
  password: replacement,
  confirmPassword: replacement,
});
async function forgot() {
  const previous = new Set(await readdir(outbox));
  await post("forgot-password", { email: "  RECOVERY@example.test  " }).expect(
    202,
  );
  await app.locals.recoveryJobs.idle();
  const files = (await readdir(outbox)).filter((file) => !previous.has(file));
  assert.equal(files.length, 1);
  const html = await readFile(path.join(outbox, files[0]), "utf8");
  const match = html.match(
    /http:\/\/localhost:3000\/reset-password#token=([a-f0-9]{64})/,
  );
  assert.ok(
    match,
    "local email contains a usable reset link on the configured origin",
  );
  return match[1];
}
before(async () => {
  await mkdir(outbox, { recursive: true });
  await mongoose.connect(
    process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017",
    { dbName: databaseName, serverSelectionTimeoutMS: 5000 },
  );
  app = createApp(config);
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
});
beforeEach(async () => {
  if (app.locals.recoveryJobs) await app.locals.recoveryJobs.idle();
  await users().deleteMany({});
  await mongoose.connection.collection("sessions").deleteMany({});
  await post("register", customer).expect(201);
});
after(async () => {
  if (app?.locals.recoveryJobs) await app.locals.recoveryJobs.idle();
  if (
    mongoose.connection.name === databaseName &&
    /^marketplace_test_[a-f0-9]{32}$/.test(databaseName)
  )
    await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
test("forgot password gives identical responses for existing, missing and suspended accounts", async () => {
  const found = await post("forgot-password", { email: customer.email }).expect(
    202,
  );
  await app.locals.recoveryJobs.idle();
  const count = (await readdir(outbox)).length;
  const missing = await post("forgot-password", {
    email: "missing@example.test",
  }).expect(202);
  await users().updateOne(
    { email: customer.email },
    { $set: { status: "suspended" } },
  );
  const suspended = await post("forgot-password", {
    email: customer.email,
  }).expect(202);
  await app.locals.recoveryJobs.idle();
  assert.deepEqual(found.body, missing.body);
  assert.deepEqual(found.body, suspended.body);
  assert.equal((await readdir(outbox)).length, count);
  assert.equal(found.body.data, null);
});
test("local email contains token while MongoDB and safe profile expose no raw secret", async () => {
  const token = await forgot();
  const user = await users().findOne({ email: customer.email });
  assert.equal(
    user.passwordResetHash,
    createHash("sha256").update(token).digest("hex"),
  );
  assert.ok(user.passwordResetExpiresAt > new Date());
  assert.ok(
    user.passwordResetExpiresAt <= new Date(Date.now() + 15 * 60 * 1000),
  );
  assert.ok(!JSON.stringify(user).includes(token));
  const login = await post("login", {
    email: customer.email,
    password: customer.password,
  }).expect(200);
  const profile = await me(login.body.data.accessToken).expect(200);
  assert.equal(profile.body.data.user.passwordResetHash, undefined);
  assert.equal(profile.body.data.user.credentialVersion, undefined);
});
test("reset changes password and immediately invalidates every old access and refresh session", async () => {
  const first = await post("login", {
    email: customer.email,
    password: customer.password,
  }).expect(200);
  const second = await post("login", {
    email: customer.email,
    password: customer.password,
  }).expect(200);
  const token = await forgot();
  const result = await post("reset-password", resetBody(token)).expect(200);
  assert.equal(result.body.data, null);
  assert.match(result.headers["set-cookie"][0], /Expires=Thu, 01 Jan 1970/);
  for (const login of [first, second]) {
    await me(login.body.data.accessToken).expect(401);
    await post("refresh", {})
      .set("Cookie", login.headers["set-cookie"][0].split(";")[0])
      .expect(401);
  }
  await post("login", {
    email: customer.email,
    password: customer.password,
  }).expect(401);
  const next = await post("login", {
    email: customer.email,
    password: replacement,
  }).expect(200);
  await me(next.body.data.accessToken).expect(200);
  await post("reset-password", resetBody(token)).expect(400);
});
test("only the newest link works and expired tokens are rejected without changing password", async () => {
  const old = await forgot();
  const latest = await forgot();
  await post("reset-password", resetBody(old)).expect(400);
  await users().updateOne(
    { email: customer.email },
    { $set: { passwordResetExpiresAt: new Date(0) } },
  );
  await post("reset-password", resetBody(latest)).expect(400);
  await post("login", {
    email: customer.email,
    password: customer.password,
  }).expect(200);
});
test("one concurrent reset wins and an old credential session inserted after reset is rejected", async () => {
  const login = await post("login", {
    email: customer.email,
    password: customer.password,
  }).expect(200);
  const sessions = mongoose.connection.collection("sessions");
  const oldSession = await sessions.findOne({});
  const token = await forgot();
  const responses = await Promise.all([
    post("reset-password", resetBody(token)),
    post("reset-password", resetBody(token)),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 400],
  );
  await sessions.deleteOne({ _id: oldSession._id });
  await sessions.insertOne(oldSession);
  await me(login.body.data.accessToken).expect(401);
  await post("refresh", {})
    .set("Cookie", login.headers["set-cookie"][0].split(";")[0])
    .expect(401);
});
test("recovery rejects bad input, mismatched confirmation, extra privileges and foreign origins", async () => {
  for (const body of [
    { email: "bad" },
    { email: customer.email, role: "admin" },
  ])
    await post("forgot-password", body).expect(422);
  const token = await forgot();
  for (const body of [
    resetBody("bad"),
    { ...resetBody(token), password: "short" },
    { ...resetBody(token), confirmPassword: "not matching" },
    { ...resetBody(token), role: "admin" },
  ])
    await post("reset-password", body).expect(422);
  for (const route of ["forgot-password", "reset-password"])
    await request(app)
      .post(`/api/auth/${route}`)
      .set("Origin", "https://evil.example")
      .send({})
      .expect(403);
  await post("reset-password", resetBody(token)).expect(200);
});
test("recovery limits count successful requests and isolate different email addresses", async () => {
  const limited = createApp({ ...config, recoveryLimit: 1 });
  await post(
    "forgot-password",
    { email: "nobody@example.test" },
    limited,
  ).expect(202);
  await post(
    "forgot-password",
    { email: " NOBODY@example.test " },
    limited,
  ).expect(429);
  await post(
    "forgot-password",
    { email: "another@example.test" },
    limited,
  ).expect(202);
  await post("reset-password", resetBody("a".repeat(64)), limited).expect(400);
  const response = await post(
    "reset-password",
    resetBody("a".repeat(64)),
    limited,
  ).expect(429);
  assert.ok(response.headers["retry-after"]);
  await limited.locals.recoveryJobs.idle();
});

test("delivery failure clears only its own token and never a newer usable link", async () => {
  const failed = {
    sendPasswordReset: async () => {
      throw new Error("smtp-private-detail");
    },
  };
  await assert.rejects(
    requestPasswordReset(customer.email, config, failed),
    (error) => !error.message.includes("smtp-private-detail"),
  );
  assert.equal(
    (await users().findOne({ email: customer.email })).passwordResetHash,
    undefined,
  );
  let release;
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const pending = requestPasswordReset(customer.email, config, {
    sendPasswordReset: async () => {
      started();
      await held;
      throw new Error("old delivery failed");
    },
  });
  const rejected = assert.rejects(pending, /delivery failed/);
  await waiting;
  const newerToken = await forgot();
  release();
  await rejected;
  await post("reset-password", resetBody(newerToken)).expect(200);
});

test("legacy users and sessions with no credential version can recover and lose their old sessions", async () => {
  await users().updateOne(
    { email: customer.email },
    { $unset: { credentialVersion: "" } },
  );
  const login = await post("login", {
    email: customer.email,
    password: customer.password,
  }).expect(200);
  await mongoose.connection
    .collection("sessions")
    .updateMany({}, { $unset: { credentialVersion: "" } });
  await me(login.body.data.accessToken).expect(200);
  const token = await forgot();
  await post("reset-password", resetBody(token)).expect(200);
  await me(login.body.data.accessToken).expect(401);
});
