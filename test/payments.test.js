import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../src/app.js";
import { accessToken } from "../src/utils/tokens.js";
const databaseName = `marketplace_test_${randomUUID().replaceAll("-", "")}`;
const config = {
  nodeEnv: "test",
  frontendOrigin: "http://localhost:3000",
  jwtSecret: "test-only-secret-that-is-at-least-48-characters-long",
  authLimit: 1000,
};
const db = (name) => mongoose.connection.collection(name);
const id = () => new mongoose.Types.ObjectId();
let app, provider, customer, other, seller, order, product;
async function account(role) {
  const userId = id(),
    sid = randomUUID();
  await db("users").insertOne({
    _id: userId,
    name: role,
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
  return { id: userId, token: accessToken(userId, sid, config.jwtSecret) };
}
function fakeProvider() {
  const sessions = new Map(),
    refunds = new Map();
  return {
    sessions,
    refunds,
    loseCreate: false,
    loseRefund: false,
    refundState: "succeeded",
    async createCheckout(params, key) {
      let session = sessions.get(key);
      if (!session) {
        session = {
          id: `cs_test_${randomUUID()}`,
          livemode: false,
          mode: "payment",
          status: "open",
          payment_status: "unpaid",
          amount_total: params.amountPaise,
          currency: "inr",
          metadata: { attemptId: params.attemptId, orderId: params.orderId },
          client_reference_id: params.orderId,
          payment_intent: null,
          url: "https://checkout.stripe.com/c/pay/test",
        };
        sessions.set(key, session);
      }
      if (this.loseCreate) {
        this.loseCreate = false;
        throw new Error("Lost response");
      }
      return structuredClone(session);
    },
    async retrieveCheckout(sessionId) {
      return structuredClone(
        [...sessions.values()].find((s) => s.id === sessionId),
      );
    },
    async retrievePaymentIntent(paymentIntentId) {
      return structuredClone(
        [...sessions.values()].find(
          (s) => s.payment_intent?.id === paymentIntentId,
        )?.payment_intent,
      );
    },
    async expireCheckout(sessionId) {
      const s = [...sessions.values()].find((s) => s.id === sessionId);
      if (s.status === "open") s.status = "expired";
      return structuredClone(s);
    },
    async createRefund(params, key) {
      let r = refunds.get(key);
      if (!r) {
        r = {
          id: `re_${randomUUID()}`,
          amount: params.amountPaise,
          currency: "inr",
          payment_intent: params.paymentIntentId,
          status: this.refundState,
        };
        refunds.set(key, r);
      }
      if (this.loseRefund) {
        this.loseRefund = false;
        throw new Error("Lost response");
      }
      return structuredClone(r);
    },
    async retrieveRefund(refundId) {
      return structuredClone(
        [...refunds.values()].find((r) => r.id === refundId),
      );
    },
    verifyWebhook(body, signature) {
      if (signature !== "valid" || !Buffer.isBuffer(body))
        throw new Error("Invalid signature");
      return JSON.parse(body.toString());
    },
    pay() {
      const s = [...sessions.values()][0];
      Object.assign(s, {
        status: "complete",
        payment_status: "paid",
        payment_intent: {
          id: `pi_${s.id}`,
          status: "succeeded",
          amount: s.amount_total,
          amount_received: s.amount_total,
          currency: s.currency,
          livemode: false,
          metadata: structuredClone(s.metadata),
        },
      });
      return s;
    },
  };
}
const call = (method, action = "", body, who = customer) => {
  const client = request(app);
  const req = client[method](`/api/orders/${order._id}/payment${action}`)
    .set("Origin", config.frontendOrigin)
    .set("Authorization", `Bearer ${who.token}`);
  return body === undefined ? req : req.send(body);
};
const checkout = () => call("post", "/checkout", {});
const refresh = () => call("post", "/refresh", {});
const refund = () => call("post", "/refund", {});
const inventory = async () =>
  (await db("products").findOne({ _id: product._id })).variants[0];
const cancel = () =>
  request(app)
    .post(`/api/orders/${order._id}/cancel`)
    .set("Origin", config.frontendOrigin)
    .set("Authorization", `Bearer ${customer.token}`)
    .send({});
before(async () => {
  await mongoose.connect(
    process.env.TEST_MONGODB_URI ||
      "mongodb://127.0.0.1:27018/?replicaSet=marketplace-rs",
    { dbName: databaseName, serverSelectionTimeoutMS: 5000 },
  );
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  customer = await account("customer");
  other = await account("customer");
  seller = await account("seller");
});
beforeEach(async () => {
  for (const name of ["products", "orders", "payments", "coupons"])
    await db(name).deleteMany({});
  provider = fakeProvider();
  app = createApp(config, { paymentProvider: provider });
  product = {
    _id: id(),
    sellerId: seller.id,
    categoryId: id(),
    title: "Mug",
    description: "Mug",
    images: [],
    status: "approved",
    version: 1,
    variants: [
      {
        sku: "BLUE",
        label: "Blue",
        pricePaise: 2000,
        stock: 1,
        reserved: 1,
        committed: 0,
      },
    ],
  };
  order = {
    _id: id(),
    customerId: customer.id,
    quoteId: id(),
    idempotencyKey: randomUUID(),
    status: "awaiting_payment",
    reservationExpiresAt: new Date(Date.now() + 900000),
    address: { recipient: "Customer" },
    groups: [
      {
        sellerId: String(seller.id),
        storeName: "Shop",
        items: [
          {
            productId: String(product._id),
            sku: "BLUE",
            quantity: 1,
            unitPricePaise: 2000,
            lineTotalPaise: 2000,
          },
        ],
      },
    ],
    subtotalPaise: 2000,
    totalPaise: 2000,
    discountPaise: 0,
    shippingPaise: 0,
    taxPaise: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db("products").insertOne(product);
  await db("orders").insertOne(order);
});
after(async () => {
  assert.match(mongoose.connection.name, /^marketplace_test_[a-f0-9]+$/);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
test("checkout reuses one session; verified capture commits reserved inventory exactly once", async () => {
  const first = await checkout().expect(200);
  assert.equal(first.body.data.payment.status, "open");
  await checkout().expect(200);
  assert.equal(provider.sessions.size, 1);
  provider.pay();
  await Promise.all([refresh().expect(200), refresh().expect(200)]);
  await refresh().expect(200);
  assert.equal(
    (await call("get").expect(200)).body.data.payment.status,
    "paid",
  );
  assert.deepEqual(await inventory(), {
    sku: "BLUE",
    label: "Blue",
    pricePaise: 2000,
    stock: 1,
    reserved: 0,
    committed: 1,
  });
  await cancel().expect(409);
  const view = (await call("get")).body.data.payment;
  assert.equal(view.paymentIntentId, undefined);
  assert.equal(view.sessionId, undefined);
});
test("full refund is persisted, confirmed and restocked once; pending and failed never restock", async () => {
  await checkout().expect(200);
  provider.pay();
  await refresh().expect(200);
  provider.refundState = "pending";
  const pending = await refund().expect(200);
  assert.equal(pending.body.data.payment.refundStatus, "pending");
  assert.equal((await inventory()).stock, 1);
  const external = [...provider.refunds.values()][0];
  external.status = "failed";
  await refresh().expect(200);
  assert.equal((await call("get")).body.data.payment.refundStatus, "failed");
  assert.equal((await inventory()).stock, 1);
  external.status = "succeeded";
  await refresh().expect(200);
  await refund().expect(200);
  assert.equal(provider.refunds.size, 1);
  assert.equal((await inventory()).stock, 2);
  assert.equal((await inventory()).committed, 0);
});
test("free checkout and refund work without credentials or external requests", async () => {
  await db("orders").updateOne({ _id: order._id }, { $set: { totalPaise: 0 } });
  app = createApp(config, { paymentProvider: null });
  const response = await checkout().expect(200);
  assert.equal(response.body.data.checkoutUrl, null);
  assert.equal(response.body.data.payment.status, "paid");
  await refund().expect(200);
  await refund().expect(200);
  assert.equal((await inventory()).stock, 2);
});
test("lost creation/refund responses recover across restart using durable keys", async () => {
  provider.loseCreate = true;
  const initial = await checkout().expect(200);
  assert.equal(initial.body.data.payment.status, "creating");
  app = createApp(config, { paymentProvider: provider });
  await checkout().expect(200);
  assert.equal(provider.sessions.size, 1);
  provider.pay();
  await refresh().expect(200);
  provider.loseRefund = true;
  await refund().expect(200);
  assert.equal((await inventory()).stock, 1);
  app = createApp(config, { paymentProvider: provider });
  await refund().expect(200);
  assert.equal(provider.refunds.size, 1);
  assert.equal((await inventory()).stock, 2);
});
test("late capture after cancellation refunds automatically without a second restock", async () => {
  await checkout().expect(200);
  await cancel().expect(200);
  provider.pay();
  await refresh().expect(200);
  await refresh().expect(200);
  assert.equal(
    (await db("orders").findOne({ _id: order._id })).status,
    "cancelled",
  );
  assert.equal(provider.refunds.size, 1);
  assert.equal((await inventory()).stock, 2);
});
test("expiry wins before reservation worker ran; late capture refunds and releases hold once", async () => {
  await checkout().expect(200);
  await db("orders").updateOne(
    { _id: order._id },
    { $set: { reservationExpiresAt: new Date(0) } },
  );
  provider.pay();
  await refresh().expect(200);
  assert.equal(
    (await db("orders").findOne({ _id: order._id })).status,
    "expired",
  );
  assert.equal((await inventory()).stock, 2);
  assert.equal(provider.refunds.size, 1);
});
test("provider identity, amount, currency and live-mode mismatches never commit inventory", async () => {
  for (const corrupt of [
    (s) => (s.metadata.orderId = "wrong"),
    (s) => (s.metadata.attemptId = "wrong"),
    (s) => s.amount_total++,
    (s) => (s.currency = "usd"),
    (s) => (s.livemode = true),
    (s) => s.payment_intent.amount_received--,
    (s) => (s.payment_intent.currency = "usd"),
    (s) => (s.payment_intent.metadata = { orderId: "wrong" }),
    (s) => (s.payment_intent.livemode = true),
    (s) => (s.id = "other"),
  ]) {
    await db("payments").deleteMany({});
    provider = fakeProvider();
    app = createApp(config, { paymentProvider: provider });
    await checkout().expect(200);
    const s = provider.pay();
    corrupt(s);
    await refresh().expect(200);
    assert.equal(
      (await db("orders").findOne({ _id: order._id })).status,
      "awaiting_payment",
    );
    assert.equal((await inventory()).committed, 0);
    assert.equal((await call("get")).body.data.payment.status, "review");
  }
});
test("webhook authenticates raw body before origin middleware; duplicate events retrieve trusted state", async () => {
  await checkout().expect(200);
  const s = provider.pay();
  const event = {
    type: "checkout.session.completed",
    livemode: false,
    data: { object: { id: s.id } },
  };
  const webhook = (body, signature = "valid") =>
    request(app)
      .post("/api/payments/stripe/webhook")
      .set("Stripe-Signature", signature)
      .send(body);
  await webhook(event, "invalid").expect(400);
  await webhook({ ...event, livemode: true }).expect(400);
  await webhook(event).expect(200);
  await webhook(event).expect(200);
  assert.equal((await inventory()).committed, 1);
  await request(app)
    .post(`/api/orders/${order._id}/payment/refresh`)
    .set("Authorization", `Bearer ${customer.token}`)
    .send({})
    .expect(403);
});
test("payment endpoints enforce customer ownership, strict bodies and disabled setup", async () => {
  await call("get", "", undefined, other).expect(404);
  await call("get", "", undefined, seller).expect(403);
  await call("post", "/checkout", { amountPaise: 1 }).expect(422);
  await call("post", "/refund", { amountPaise: 1 }).expect(422);
  app = createApp(config, { paymentProvider: null });
  assert.equal((await call("get").expect(200)).body.data.enabled, false);
  await checkout().expect(503);
  assert.throws(
    () =>
      createApp(
        { ...config, nodeEnv: "production" },
        { paymentProvider: provider },
      ),
    /test/i,
  );
});
test("cancel racing an in-flight capture check wins safely and enqueues one automatic refund", async () => {
  await checkout().expect(200);
  provider.pay();
  const retrieve = provider.retrieveCheckout.bind(provider);
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  provider.retrieveCheckout = async (sid) => {
    entered();
    await gate;
    return retrieve(sid);
  };
  const checking = refresh()
    .expect(200)
    .then((r) => r);
  await started;
  await cancel().expect(200);
  release();
  await checking;
  assert.equal(
    (await db("orders").findOne({ _id: order._id })).status,
    "cancelled",
  );
  assert.equal((await inventory()).stock, 2);
  assert.equal(provider.refunds.size, 1);
});
test("seller cannot overwrite or archive committed inventory", async () => {
  await checkout().expect(200);
  provider.pay();
  await refresh().expect(200);
  await db("categories").insertOne({
    _id: product.categoryId,
    name: "Mugs",
    normalizedName: "mugs",
    active: true,
  });
  const auth = (req) =>
    req
      .set("Origin", config.frontendOrigin)
      .set("Authorization", `Bearer ${seller.token}`);
  await auth(request(app).patch(`/api/seller/products/${product._id}`))
    .send({
      version: 2,
      title: "Edited mug",
      description: "Edited description",
      categoryId: String(product.categoryId),
      images: [{ url: "https://example.test/mug.jpg", alt: "Mug" }],
      variants: [{ sku: "NEW", label: "New", price: "20.00", stock: 20 }],
    })
    .expect(409);
  await auth(request(app).post(`/api/seller/products/${product._id}/archive`))
    .send({ version: 2 })
    .expect(409);
});
test("uncertain creation and refund older than retention enter review without new external operations", async () => {
  provider.loseCreate = true;
  await checkout().expect(200);
  await db("payments").updateOne(
    { orderId: order._id },
    { $set: { createdAt: new Date(Date.now() - 24 * 3600000) } },
  );
  let calls = 0;
  const create = provider.createCheckout.bind(provider);
  provider.createCheckout = (...args) => {
    calls++;
    return create(...args);
  };
  assert.equal(
    (await checkout().expect(200)).body.data.payment.status,
    "review",
  );
  assert.equal(calls, 0);
  await db("payments").deleteMany({});
  provider = fakeProvider();
  app = createApp(config, { paymentProvider: provider });
  await checkout().expect(200);
  provider.pay();
  await refresh().expect(200);
  provider.loseRefund = true;
  await refund().expect(200);
  await db("payments").updateOne(
    { orderId: order._id },
    { $set: { refundRequestedAt: new Date(Date.now() - 24 * 3600000) } },
  );
  let refundCalls = 0;
  provider.createRefund = async () => {
    refundCalls++;
    throw new Error("Should not run");
  };
  assert.equal((await refund().expect(200)).body.data.payment.status, "review");
  assert.equal(refundCalls, 0);
  assert.equal((await inventory()).stock, 1);
});
test("restart worker retries uncertain creation and pending refunds with bounded oldest-due scheduling", async () => {
  provider.loseCreate = true;
  await checkout().expect(200);
  await db("payments").updateOne(
    { orderId: order._id },
    { $set: { nextCheckAt: new Date(0) } },
  );
  app = createApp(config, { paymentProvider: provider });
  assert.equal(await app.locals.paymentService.sweep({ limit: 1 }), 1);
  assert.equal(provider.sessions.size, 1);
  provider.pay();
  await refresh().expect(200);
  provider.refundState = "pending";
  await refund().expect(200);
  [...provider.refunds.values()][0].status = "succeeded";
  await db("payments").updateOne(
    { orderId: order._id },
    { $set: { nextCheckAt: new Date(0) } },
  );
  const { createPaymentJobs } =
    await import("../src/jobs/payments.jobs.js");
  const errors = [];
  const worker = createPaymentJobs(app.locals.paymentService, {
    onError: (e) => errors.push(e),
  });
  await worker.close();
  assert.deepEqual(errors, []);
  assert.equal((await inventory()).stock, 2);
});
test("failed oldest work gets backoff so later due payments are not starved", async () => {
  await checkout().expect(200);
  const firstOrder = order,
    firstSession = [...provider.sessions.values()][0];
  order = { ...order, _id: id(), quoteId: id(), idempotencyKey: randomUUID() };
  await db("orders").insertOne(order);
  await db("products").updateOne(
    { _id: product._id },
    { $set: { "variants.0.reserved": 2, "variants.0.stock": 0 } },
  );
  await checkout().expect(200);
  const secondSession = [...provider.sessions.values()][1];
  Object.assign(secondSession, {
    status: "complete",
    payment_status: "paid",
    payment_intent: {
      id: "pi_second",
      status: "succeeded",
      amount: 2000,
      amount_received: 2000,
      currency: "inr",
      livemode: false,
      metadata: secondSession.metadata,
    },
  });
  const retrieve = provider.retrieveCheckout.bind(provider);
  provider.retrieveCheckout = async (sid) => {
    if (sid === firstSession.id) throw new Error("Network unavailable");
    return retrieve(sid);
  };
  await db("payments").updateOne(
    { orderId: firstOrder._id },
    { $set: { nextCheckAt: new Date(0) } },
  );
  await db("payments").updateOne(
    { orderId: order._id },
    { $set: { nextCheckAt: new Date(1) } },
  );
  await app.locals.paymentService.sweep({ limit: 1 });
  await app.locals.paymentService.sweep({ limit: 1 });
  assert.equal((await db("orders").findOne({ _id: order._id })).status, "paid");
  assert.equal((await inventory()).committed, 1);
});
test("expiry worker closes abandoned checkout and never returns a stale payment URL", async () => {
  await checkout().expect(200);
  await db("orders").updateOne(
    { _id: order._id },
    { $set: { reservationExpiresAt: new Date(0) } },
  );
  const response = await checkout().expect(200);
  assert.equal(response.body.data.checkoutUrl, null);
  assert.equal([...provider.sessions.values()][0].status, "expired");
  assert.equal((await inventory()).stock, 2);
});
test("refund binding mismatch cannot release inventory or coupon", async () => {
  const couponId = id();
  await db("coupons").insertOne({ _id: couponId, usedCount: 1 });
  await db("orders").updateOne(
    { _id: order._id },
    { $set: { coupon: { id: String(couponId) } } },
  );
  await checkout().expect(200);
  provider.pay();
  await refresh().expect(200);
  const create = provider.createRefund.bind(provider);
  provider.createRefund = async (...args) => ({
    ...(await create(...args)),
    amount: 1999,
  });
  assert.equal((await refund().expect(200)).body.data.payment.status, "review");
  assert.equal((await inventory()).stock, 1);
  assert.equal((await db("coupons").findOne({ _id: couponId })).usedCount, 1);
});
test("confirmed full refund releases coupon usage exactly once", async () => {
  const couponId = id();
  await db("coupons").insertOne({ _id: couponId, usedCount: 1 });
  await db("orders").updateOne(
    { _id: order._id },
    { $set: { coupon: { id: String(couponId) } } },
  );
  await checkout().expect(200);
  provider.pay();
  await refresh().expect(200);
  await Promise.all([refund().expect(200), refund().expect(200)]);
  await refund().expect(200);
  assert.equal((await db("coupons").findOne({ _id: couponId })).usedCount, 0);
  assert.equal((await inventory()).stock, 2);
});
test("unknown signed events acknowledged; similar webhook paths retain origin checks", async () => {
  await request(app)
    .post("/api/payments/stripe/webhook")
    .set("Stripe-Signature", "valid")
    .send({ type: "unrelated.event", livemode: false })
    .expect(200);
  for (const path of [
    "/api/payments/stripe/webhook/",
    "/api/payments/stripe/webhook/extra",
    "/api/payments/stripe/WEBHOOK",
  ])
    await request(app)
      .post(path)
      .set("Stripe-Signature", "valid")
      .send({ livemode: false })
      .expect(403);
  await db("orders").updateOne(
    { _id: order._id },
    { $set: { totalPaise: 49 } },
  );
  await checkout().expect(422);
  assert.equal(provider.sessions.size, 0);
});
test("duplicate terminal notifications do not leave paid records occupying the due queue", async () => {
  await checkout().expect(200);
  const s = provider.pay();
  await refresh().expect(200);
  await request(app)
    .post("/api/payments/stripe/webhook")
    .set("Stripe-Signature", "valid")
    .send({
      type: "checkout.session.completed",
      livemode: false,
      data: { object: { id: s.id } },
    })
    .expect(200);
  assert.equal(
    (await db("payments").findOne({ orderId: order._id })).nextCheckAt,
    null,
  );
});
test("real Stripe refund shape without a livemode field can confirm a verified test payment", async () => {
  await checkout().expect(200);
  provider.pay();
  await refresh().expect(200);
  const create = provider.createRefund.bind(provider);
  provider.createRefund = async (...args) => {
    const result = await create(...args);
    delete result.livemode;
    return result;
  };
  assert.equal(
    (await refund().expect(200)).body.data.payment.status,
    "refunded",
  );
  assert.equal((await inventory()).stock, 2);
});
test("signed external refund places paid inventory on review hold without claiming restock", async () => {
  await checkout().expect(200);
  const session = provider.pay();
  await refresh().expect(200);
  const event = {
    type: "charge.refunded",
    livemode: false,
    data: {
      object: {
        id: "ch_external",
        payment_intent: session.payment_intent.id,
        amount_refunded: 2000,
      },
    },
  };
  await request(app)
    .post("/api/payments/stripe/webhook")
    .set("Stripe-Signature", "valid")
    .send(event)
    .expect(200);
  const payment = (await call("get")).body.data.payment;
  assert.equal(payment.status, "review");
  assert.match(payment.message, /outside.*support/i);
  assert.equal(
    (await db("orders").findOne({ _id: order._id })).status,
    "refund_pending",
  );
  assert.equal((await inventory()).stock, 1);
  assert.equal((await inventory()).committed, 1);
  await refund().expect(409);
  assert.equal(provider.refunds.size, 0);
});
test("duplicate refunded notifications cannot starve a newer due capture", async () => {
  await checkout().expect(200);
  const first = provider.pay();
  await refresh().expect(200);
  await refund().expect(200);
  await request(app)
    .post("/api/payments/stripe/webhook")
    .set("Stripe-Signature", "valid")
    .send({
      type: "refund.updated",
      livemode: false,
      data: { object: { payment_intent: first.payment_intent.id } },
    })
    .expect(200);
  assert.equal(
    (await db("payments").findOne({ orderId: order._id })).nextCheckAt,
    null,
  );
  order = { ...order, _id: id(), quoteId: id(), idempotencyKey: randomUUID() };
  await db("orders").insertOne(order);
  await db("products").updateOne(
    { _id: product._id },
    { $set: { "variants.0.stock": 1, "variants.0.reserved": 1 } },
  );
  await checkout().expect(200);
  const next = [...provider.sessions.values()][1];
  Object.assign(next, {
    status: "complete",
    payment_status: "paid",
    payment_intent: {
      id: "pi_next",
      amount: 2000,
      amount_received: 2000,
      currency: "inr",
      livemode: false,
      status: "succeeded",
      metadata: next.metadata,
    },
  });
  await db("payments").updateOne(
    { orderId: order._id },
    { $set: { nextCheckAt: new Date() } },
  );
  await app.locals.paymentService.sweep({ limit: 1 });
  assert.equal((await db("orders").findOne({ _id: order._id })).status, "paid");
  assert.equal((await inventory()).committed, 1);
});
test("provider-confirmed outside refund before local capture puts order on review hold", async () => {
  await checkout().expect(200);
  const external = provider.pay();
  external.payment_intent.latest_charge = {
    id: "ch_early",
    livemode: false,
    paid: true,
    captured: true,
    payment_intent: external.payment_intent.id,
    amount: 2000,
    amount_captured: 2000,
    amount_refunded: 2000,
    currency: "inr",
  };
  await request(app)
    .post("/api/payments/stripe/webhook")
    .set("Stripe-Signature", "valid")
    .send({
      type: "charge.refunded",
      livemode: false,
      data: { object: external.payment_intent.latest_charge },
    })
    .expect(200);
  await refresh().expect(200);
  assert.equal((await call("get")).body.data.payment.status, "review");
  assert.equal(
    (await db("orders").findOne({ _id: order._id })).status,
    "refund_pending",
  );
  assert.equal((await inventory()).stock, 1);
  assert.equal((await inventory()).reserved, 0);
  assert.equal((await inventory()).committed, 1);
  assert.equal(provider.refunds.size, 0);
});
test("outside refund on a cancelled session never requests another refund or restocks twice", async () => {
  await checkout().expect(200);
  await cancel().expect(200);
  const external = provider.pay();
  external.payment_intent.latest_charge = {
    id: "ch_cancelled",
    livemode: false,
    paid: true,
    captured: true,
    payment_intent: external.payment_intent.id,
    amount: 2000,
    amount_captured: 2000,
    amount_refunded: 2000,
    currency: "inr",
  };
  await refresh().expect(200);
  assert.equal((await call("get")).body.data.payment.status, "review");
  assert.equal(provider.refunds.size, 0);
  assert.equal((await inventory()).stock, 2);
  assert.equal(
    (await db("orders").findOne({ _id: order._id })).status,
    "cancelled",
  );
});
test("external refund notification fences an already retrieved stale capture snapshot", async () => {
  await checkout().expect(200);
  const external = provider.pay();
  let enter, release;
  const started = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const retrieve = provider.retrieveCheckout.bind(provider);
  provider.retrieveCheckout = async (sid) => {
    const snapshot = await retrieve(sid);
    enter();
    await gate;
    return snapshot;
  };
  provider.retrievePaymentIntent = async (piId) => {
    assert.equal(piId, external.payment_intent.id);
    return structuredClone(external.payment_intent);
  };
  const refreshing = refresh()
    .expect(200)
    .then((r) => r);
  await started;
  external.payment_intent.latest_charge = {
    id: "ch_racing",
    livemode: false,
    paid: true,
    captured: true,
    payment_intent: external.payment_intent.id,
    amount: 2000,
    amount_captured: 2000,
    amount_refunded: 2000,
    currency: "inr",
  };
  try {
    await request(app)
      .post("/api/payments/stripe/webhook")
      .set("Stripe-Signature", "valid")
      .send({
        type: "charge.refunded",
        livemode: false,
        data: { object: external.payment_intent.latest_charge },
      })
      .expect(200);
  } finally {
    release();
  }
  await refreshing;
  assert.equal((await call("get")).body.data.payment.status, "review");
  assert.equal(
    (await db("orders").findOne({ _id: order._id })).status,
    "refund_pending",
  );
  assert.equal((await inventory()).committed, 1);
  assert.equal((await inventory()).stock, 1);
  assert.equal(provider.refunds.size, 0);
});
