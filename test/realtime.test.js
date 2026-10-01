import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { io as connect } from "socket.io-client";
import { Order } from "../src/models/order.model.js";
import { accessToken } from "../src/utils/tokens.js";

import { attachRealtime } from "../src/realtime/realtime.js";
const databaseName = `marketplace_test_${randomUUID().replaceAll("-", "")}`;
const config = {
  nodeEnv: "test",
  frontendOrigin: "http://localhost:3000",
  jwtSecret: "test-only-secret-that-is-at-least-48-characters-long",
};
const db = (name) => mongoose.connection.collection(name);
const sockets = new Set();
const services = new Set();
const waitEvent = (emitter, event) =>
  once(emitter, event, { signal: AbortSignal.timeout(6000) });
const id = () => new mongoose.Types.ObjectId();

before(async () => {
  await mongoose.connect(
    process.env.TEST_MONGODB_URI ||
      "mongodb://127.0.0.1:27018/?replicaSet=marketplace-rs",
    { dbName: databaseName, serverSelectionTimeoutMS: 5000 },
  );
  await Order.init();
});
afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets.clear();
  for (const service of services) await service.close();
  services.clear();
});
after(async () => {
  if (
    mongoose.connection.name === databaseName &&
    /^marketplace_test_[a-f0-9]{32}$/.test(databaseName)
  )
    await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
async function account(role = "customer") {
  const userId = id(),
    sid = randomUUID();
  await db("users").insertOne({
    _id: userId,
    name: "Realtime account",
    email: `${userId}@example.test`,
    role,
    status: "active",
    sellerStatus: "approved",
    credentialVersion: 0,
  });
  await db("sessions").insertOne({
    _id: sid,
    userId,
    credentialVersion: 0,
    expiresAt: new Date(Date.now() + 3600000),
    revokedAt: null,
  });
  return { id: userId, sid, token: accessToken(userId, sid, config.jwtSecret) };
}
async function order(customer, sellers = []) {
  const orderId = id();
  await db("orders").insertOne({
    _id: orderId,
    customerId: customer.id,
    quoteId: id(),
    idempotencyKey: randomUUID(),
    status: "paid",
    groups: sellers.map((seller) => ({
      sellerId: String(seller.id),
      items: [{ title: "Private item" }],
    })),
  });
  return String(orderId);
}
async function start(options = {}) {
  assert.equal(
    typeof attachRealtime,
    "function",
    "realtime transport lifecycle is implemented",
  );
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  let stream;
  const ready = new Promise((resolve) => {
    options.watchOrders ??= () => {
      stream = Order.watch([], { maxAwaitTimeMS: 100 });
      stream.once("resumeTokenChanged", resolve);
      return stream;
    };
  });
  const service = attachRealtime(server, config, options);
  services.add(service);
  server.listen(0, "127.0.0.1");
  await waitEvent(server, "listening");
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Change stream did not initialize")),
        5000,
      ).unref(),
    ),
  ]);
  return {
    service,
    server,
    stream,
    url: `http://127.0.0.1:${server.address().port}`,
  };
}
function client(url, token, options = {}) {
  const socket = connect(url, {
    path: "/api/realtime/socket.io",
    transports: ["polling"],
    auth: { token },
    extraHeaders: { Origin: config.frontendOrigin },
    reconnection: false,
    autoConnect: false,
    ...options,
  });
  sockets.add(socket);
  return socket;
}
async function connected(url, token) {
  const socket = client(url, token);
  const ready = waitEvent(socket, "connect");
  socket.connect();
  await ready;
  return socket;
}
const subscribe = (socket, orderId) =>
  socket.timeout(3000).emitWithAck("order:subscribe", { orderId });
const change = (orderId, update = { $inc: { paymentRevision: 1 } }) =>
  db("orders").updateOne({ _id: new mongoose.Types.ObjectId(orderId) }, update);

test("only owning customers and approved participating sellers can subscribe; events contain only the order ID", async () => {
  const customer = await account(),
    other = await account(),
    seller = await account("seller"),
    seller2 = await account("seller"),
    outsider = await account("seller"),
    pending = await account("seller"),
    admin = await account("admin");
  const orderId = await order(customer, [seller, seller2, pending]);
  await db("users").updateOne(
    { _id: pending.id },
    { $set: { sellerStatus: "pending" } },
  );
  const { url: secondInstance } = await start();
  const { url } = await start();
  const recipients = [];
  for (const who of [customer, seller, seller2]) {
    const socket = await connected(
      who === seller2 ? secondInstance : url,
      who.token,
    );
    assert.deepEqual(await subscribe(socket, orderId), { ok: true });
    recipients.push(socket);
  }
  for (const who of [other, outsider, pending, admin]) {
    const socket = await connected(url, who.token);
    const result = await subscribe(socket, orderId);
    assert.equal(result.ok, false);
    assert.equal(typeof result.message, "string");
  }
  assert.equal((await subscribe(recipients[0], "invalid-id")).ok, false);
  assert.deepEqual(await subscribe(recipients[0], orderId), { ok: true });
  const events = recipients.map((socket) => waitEvent(socket, "order:updated"));
  await change(orderId, {
    $set: { "groups.0.items.0.title": "Sensitive merchant item" },
  });
  for (const result of await Promise.all(events))
    assert.deepEqual(result, [{ orderId }]);
});

test("switching orders removes the former subscription, and aborted transactions never invalidate", async () => {
  const customer = await account();
  const first = await order(customer),
    second = await order(customer);
  const { url } = await start();
  const switched = await connected(url, customer.token),
    observer = await connected(url, customer.token);
  await subscribe(switched, first);
  await subscribe(switched, second);
  await subscribe(observer, first);
  const received = [];
  switched.on("order:updated", (event) => received.push(event));
  const session = await mongoose.startSession();
  session.startTransaction();
  await db("orders").updateOne(
    { _id: new mongoose.Types.ObjectId(second) },
    { $set: { status: "cancelled" } },
    { session },
  );
  await session.abortTransaction();
  await session.endSession();
  const oldEvent = waitEvent(observer, "order:updated");
  await change(first);
  await oldEvent;
  const newEvent = waitEvent(switched, "order:updated");
  await change(second);
  await newEvent;
  assert.deepEqual(received, [{ orderId: second }]);
});

test("exact Origin is required for polling and WebSocket handshakes and every polling request", async () => {
  const customer = await account();
  const { url } = await start();
  for (const transport of ["polling", "websocket"]) {
    for (const origin of [
      undefined,
      "http://localhost:3000.evil.test",
      "http://localhost:3000/",
    ]) {
      const socket = client(url, customer.token, {
        transports: [transport],
        extraHeaders: origin ? { Origin: origin } : {},
      });
      const error = waitEvent(socket, "connect_error");
      socket.connect();
      await error;
      assert.equal(socket.connected, false);
      socket.close();
    }
  }
  const socket = await connected(url, customer.token);
  const response = await fetch(
    `${url}/api/realtime/socket.io/?EIO=4&transport=polling&sid=${socket.io.engine.id}`,
    { headers: { Origin: "https://evil.test" } },
  );
  assert.equal(response.status, 400);
  const invalid = client(url, "invalid-token");
  const denied = waitEvent(invalid, "connect_error");
  invalid.connect();
  const [error] = await denied;
  assert.equal(error.message, "Please sign in again.");
});

test("delivery rechecks revoked sessions, seller approval, user credentials and current order ownership", async () => {
  for (const mutate of [
    async (who) =>
      db("sessions").updateOne(
        { _id: who.sid },
        { $set: { revokedAt: new Date() } },
      ),
    async (who) =>
      db("users").updateOne(
        { _id: who.id },
        { $set: { sellerStatus: "rejected" } },
      ),
    async (who) =>
      db("users").updateOne(
        { _id: who.id },
        { $inc: { credentialVersion: 1 } },
      ),
    async (_who, orderId) => change(orderId, { $set: { groups: [] } }),
  ]) {
    const customer = await account(),
      seller = await account("seller");
    const orderId = await order(customer, [seller]);
    const { url } = await start({ authCheckIntervalMs: 60000 });
    const socket = await connected(url, seller.token);
    await subscribe(socket, orderId);
    const received = [];
    socket.on("order:updated", (event) => received.push(event));
    const disconnected = waitEvent(socket, "disconnect");
    await mutate(seller, orderId);
    await change(orderId);
    await disconnected;
    assert.deepEqual(received, []);
  }
});

test("periodic checks disconnect idle revoked or expired sessions and expired access tokens", async () => {
  const { url } = await start({
    authCheckIntervalMs: 40,
    authCheckBatchSize: 1,
  });
  for (const cause of ["revoked", "session-expired", "jwt-expired"]) {
    const customer = await account();
    if (cause === "jwt-expired")
      customer.token = jwt.sign({ sid: customer.sid }, config.jwtSecret, {
        subject: String(customer.id),
        issuer: "marketplace-api",
        audience: "marketplace-web",
        algorithm: "HS256",
        expiresIn: 2,
      });
    const socket = await connected(url, customer.token);
    const disconnected = waitEvent(socket, "disconnect");
    if (cause === "revoked")
      await db("sessions").updateOne(
        { _id: customer.sid },
        { $set: { revokedAt: new Date() } },
      );
    if (cause === "session-expired")
      await db("sessions").updateOne(
        { _id: customer.sid },
        { $set: { expiresAt: new Date(0) } },
      );
    await disconnected;
    assert.equal(socket.connected, false);
  }
});

test("stream failure reconnects with authorized catch-up and shutdown closes active clients and stream", async () => {
  const customer = await account();
  const orderId = await order(customer);
  const state = await start({ reconnectDelayMs: 30 });
  const socket = await connected(state.url, customer.token);
  await subscribe(socket, orderId);
  const recovery = waitEvent(socket, "order:updated");
  state.stream.emit("error", new Error("simulated change stream interruption"));
  assert.deepEqual(await recovery, [{ orderId }]);
  const next = waitEvent(socket, "order:updated");
  await change(orderId);
  assert.deepEqual(await next, [{ orderId }]);
  const disconnected = waitEvent(socket, "disconnect");
  await state.service.close();
  await disconnected;
  assert.equal(state.server.listening, false);
  assert.equal(state.stream.closed, true);
  await state.service.close();
});

test("reconnection requires a new authorized subscription and refuses a revoked token", async () => {
  const customer = await account();
  const orderId = await order(customer);
  const { url } = await start();
  const socket = await connected(url, customer.token);
  await subscribe(socket, orderId);
  socket.disconnect();
  let connectedAgain = waitEvent(socket, "connect");
  socket.connect();
  await connectedAgain;
  assert.deepEqual(await subscribe(socket, orderId), { ok: true });
  const updated = waitEvent(socket, "order:updated");
  await change(orderId);
  assert.deepEqual(await updated, [{ orderId }]);
  socket.disconnect();
  await db("sessions").updateOne(
    { _id: customer.sid },
    { $set: { revokedAt: new Date() } },
  );
  const refused = waitEvent(socket, "connect_error");
  socket.connect();
  const [error] = await refused;
  assert.equal(error.message, "Please sign in again.");
  assert.equal(socket.connected, false);
});
