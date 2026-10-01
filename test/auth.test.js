import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../src/app.js";

const databaseName = `marketplace_test_${randomUUID().replaceAll("-", "")}`;
const config = {
  nodeEnv: "test",
  frontendOrigin: "http://localhost:3000",
  jwtSecret: "test-only-secret-that-is-at-least-48-characters-long",
  authLimit: 1000,
};
let app;
const customer = {
  name: "Asha Sharma",
  email: "asha@example.test",
  phone: "+91 9876543210",
  password: "My long example password!",
  accountType: "customer",
};
const post = (path, body, cookie) => {
  const call = request(app)
    .post(`/api/auth/${path}`)
    .set("Origin", config.frontendOrigin);
  if (cookie) call.set("Cookie", cookie);
  return call.send(body ?? {});
};
const cookieOf = (response) => response.headers["set-cookie"][0].split(";")[0];
const me = (token) =>
  request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
async function signIn(overrides = {}) {
  await post("register", { ...customer, ...overrides }).expect(201);
  return post("login", {
    email: customer.email,
    password: customer.password,
  }).expect(200);
}
before(async () => {
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
  await mongoose.connection.collection("users").deleteMany({});
  await mongoose.connection.collection("sessions").deleteMany({});
});
after(async () => {
  if (
    mongoose.connection.name === databaseName &&
    databaseName.startsWith("marketplace_test_")
  )
    await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("health route reports a connected database and API availability", async () => {
  const response = await request(app).get("/api/health").expect(200);
  assert.equal(response.body.data.database, "connected");
  assert.ok(response.headers["x-request-id"]);
});
test("registration normalizes email and never exposes password material", async () => {
  const response = await post("register", {
    ...customer,
    email: "  ASHA@example.test  ",
  }).expect(201);
  assert.equal(response.body.data.user.email, customer.email);
  assert.equal(response.body.data.user.role, "customer");
  assert.equal(response.body.data.user.passwordHash, undefined);
  const user = await mongoose.connection
    .collection("users")
    .findOne({ email: customer.email });
  assert.notEqual(user.passwordHash, customer.password);
  assert.match(user.passwordHash, /^scrypt\$/);
});
test("simultaneous duplicate email registration creates exactly one user", async () => {
  const results = await Promise.all([
    post("register", customer),
    post("register", customer),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(
    await mongoose.connection.collection("users").countDocuments({}),
    1,
  );
});
test("registration rejects privilege injection, invalid email and weak password", async () => {
  for (const body of [
    { ...customer, role: "admin" },
    { ...customer, accountType: "admin" },
    { ...customer, sellerStatus: "approved" },
    { ...customer, email: "bad" },
    { ...customer, password: "short" },
  ]) {
    await post("register", body).expect(422);
  }
  assert.equal(
    await mongoose.connection.collection("users").countDocuments({}),
    0,
  );
});
test("seller registration requires a store and always starts pending", async () => {
  await post("register", { ...customer, accountType: "seller" }).expect(422);
  const response = await post("register", {
    ...customer,
    accountType: "seller",
    storeName: "Asha Studio",
  }).expect(201);
  assert.equal(response.body.data.user.sellerStatus, "pending");
});
test("login uses an HttpOnly cookie and protected API returns the safe current user", async () => {
  const response = await signIn();
  assert.match(response.headers["set-cookie"][0], /HttpOnly/);
  assert.match(response.headers["set-cookie"][0], /SameSite=Lax/);
  assert.match(response.headers["set-cookie"][0], /Path=\/api\/auth/);
  const current = await me(response.body.data.accessToken).expect(200);
  assert.equal(current.body.data.user.name, customer.name);
  assert.equal(current.body.data.user.passwordHash, undefined);
});
test("wrong password and nonexistent email return identical credential errors", async () => {
  await post("register", customer).expect(201);
  const wrong = await post("login", {
    email: customer.email,
    password: "incorrect password",
  }).expect(401);
  const missing = await post("login", {
    email: "missing@example.test",
    password: "incorrect password",
  }).expect(401);
  assert.equal(wrong.body.message, missing.body.message);
});
test("refresh rotates cookie; reuse revokes the family and its access tokens", async () => {
  const login = await signIn();
  const oldCookie = cookieOf(login);
  const refreshed = await post("refresh", {}, oldCookie).expect(200);
  assert.notEqual(cookieOf(refreshed), oldCookie);
  await me(refreshed.body.data.accessToken).expect(200);
  await post("refresh", {}, oldCookie).expect(401);
  await me(refreshed.body.data.accessToken).expect(401);
  await post("refresh", {}, cookieOf(refreshed)).expect(401);
});
test("a guessed refresh secret does not revoke the legitimate session", async () => {
  const login = await signIn();
  const cookie = cookieOf(login);
  const guessed = cookie.replace(/\.[a-f0-9]{64}$/, `.${"0".repeat(64)}`);
  assert.notEqual(guessed, cookie);
  await post("refresh", {}, guessed).expect(401);
  await post("refresh", {}, cookie).expect(200);
});
test("logout revokes access immediately and clears refresh cookie", async () => {
  const login = await signIn();
  const result = await post("logout", {}, cookieOf(login)).expect(200);
  assert.match(result.headers["set-cookie"][0], /Expires=Thu, 01 Jan 1970/);
  await me(login.body.data.accessToken).expect(401);
  await post("refresh", {}, cookieOf(login)).expect(401);
});
test("pending seller cannot use selling tools; customer cannot use admin tools", async () => {
  const seller = await signIn({
    accountType: "seller",
    storeName: "Asha Studio",
  });
  await request(app)
    .get("/api/seller/access")
    .set("Authorization", `Bearer ${seller.body.data.accessToken}`)
    .expect(403);
  await request(app)
    .get("/api/admin/access")
    .set("Authorization", `Bearer ${seller.body.data.accessToken}`)
    .expect(403);
});
test("suspended account and expired session cannot authenticate", async () => {
  const login = await signIn();
  await mongoose.connection
    .collection("users")
    .updateOne({ email: customer.email }, { $set: { status: "suspended" } });
  await me(login.body.data.accessToken).expect(401);
  await post("refresh", {}, cookieOf(login)).expect(401);
  await mongoose.connection
    .collection("users")
    .updateOne({ email: customer.email }, { $set: { status: "active" } });
  await mongoose.connection
    .collection("sessions")
    .updateMany({}, { $set: { expiresAt: new Date(0) } });
  await me(login.body.data.accessToken).expect(401);
});
test("missing or foreign Origin rejects cookie-changing requests", async () => {
  for (const endpoint of ["register", "login", "refresh", "logout"]) {
    await request(app).post(`/api/auth/${endpoint}`).send(customer).expect(403);
    await request(app)
      .post(`/api/auth/${endpoint}`)
      .set("Origin", "https://attacker.example")
      .send(customer)
      .expect(403);
  }
});
test("missing and invalid access tokens are 401; unknown routes are JSON 404", async () => {
  await request(app).get("/api/auth/me").expect(401);
  await me("invalid").expect(401);
  const result = await request(app).get("/api/unknown").expect(404);
  assert.equal(result.body.success, false);
});
test("malformed JSON and oversized bodies have safe errors", async () => {
  const invalid = await request(app)
    .post("/api/auth/login")
    .set("Origin", config.frontendOrigin)
    .set("Content-Type", "application/json")
    .send("{bad")
    .expect(400);
  assert.equal(invalid.body.success, false);
  assert.equal(invalid.body.stack, undefined);
  await post("login", {
    email: "a".repeat(20000),
    password: "password",
  }).expect(413);
});
test("auth endpoints apply a rate limit with a retry hint", async () => {
  const limited = createApp({ ...config, authLimit: 1 });
  await request(limited)
    .post("/api/auth/login")
    .set("Origin", config.frontendOrigin)
    .send({})
    .expect(422);
  const response = await request(limited)
    .post("/api/auth/login")
    .set("Origin", config.frontendOrigin)
    .send({})
    .expect(429);
  assert.ok(response.headers["retry-after"]);
});
test("credential limits isolate accounts behind the same proxy without trusting forged IP headers", async () => {
  const limited = createApp({ ...config, authLimit: 1 });
  const attempt = (email) =>
    request(limited)
      .post("/api/auth/login")
      .set("Origin", config.frontendOrigin)
      .set("X-Forwarded-For", "198.51.100.12")
      .send({ email, password: "not-a-valid-password" });
  await attempt("first@example.test").expect(401);
  await attempt("first@example.test").expect(429);
  await attempt("second@example.test").expect(401);
});
test("transport backstop never prevents signing out", async () => {
  const login = await signIn();
  const limited = createApp({ ...config, transportLimit: 1 });
  await request(limited)
    .post("/api/auth/login")
    .set("Origin", config.frontendOrigin)
    .send({})
    .expect(422);
  await request(limited)
    .post("/api/auth/login")
    .set("Origin", config.frontendOrigin)
    .send({})
    .expect(429);
  await request(limited)
    .post("/api/auth/logout")
    .set("Origin", config.frontendOrigin)
    .set("Cookie", cookieOf(login))
    .send({})
    .expect(200);
  await me(login.body.data.accessToken).expect(401);
});
