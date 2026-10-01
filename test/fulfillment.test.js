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
let app, customer, seller, secondSeller, outsider, order, products;
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
const call = (method, path, who = customer, body) => {
  const client = request(app);
  const req = client[method](`/api${path}`)
    .set("Origin", config.frontendOrigin)
    .set("Authorization", `Bearer ${who.token}`);
  return body === undefined ? req : req.send(body);
};
const transition = (status, expectedVersion, who = seller, tracking) =>
  call("patch", `/seller/orders/${order._id}/fulfillment`, who, {
    status,
    expectedVersion,
    ...(tracking ? { tracking } : {}),
  });
const get = (who = customer) =>
  call(
    "get",
    `/${who === customer ? "orders" : "seller/orders"}/${order._id}`,
    who,
  );
const inventory = async (index) =>
  (await db("products").findOne({ _id: products[index]._id })).variants[0];
const tracking = {
  carrier: "India Post",
  trackingNumber: "IN12345",
  trackingUrl: "https://tracking.example.test/IN12345",
};
before(async () => {
  await mongoose.connect(
    process.env.TEST_MONGODB_URI ||
      "mongodb://127.0.0.1:27018/?replicaSet=marketplace-rs",
    { dbName: databaseName, serverSelectionTimeoutMS: 5000 },
  );
  app = createApp(config, { paymentProvider: null });
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  customer = await account("customer");
  seller = await account("seller");
  secondSeller = await account("seller");
  outsider = await account("seller");
});
beforeEach(async () => {
  for (const name of ["orders", "payments", "products"])
    await db(name).deleteMany({});
  await db("users").updateMany(
    { role: "seller" },
    { $set: { sellerStatus: "approved", status: "active" } },
  );
  products = [seller, secondSeller].map((who, index) => ({
    _id: id(),
    sellerId: who.id,
    categoryId: id(),
    title: `Mug ${index}`,
    description: "Ceramic mug",
    status: "approved",
    version: 0,
    variants: [
      {
        sku: "BLUE",
        label: "Blue",
        pricePaise: 2000,
        stock: 3 + index,
        reserved: 0,
        committed: 1,
      },
    ],
  }));
  await db("products").insertMany(products);
  order = {
    _id: id(),
    customerId: customer.id,
    quoteId: id(),
    idempotencyKey: randomUUID(),
    status: "paid",
    reservationExpiresAt: new Date(Date.now() + 900000),
    address: { recipient: "Customer" },
    groups: products.map((p) => ({
      sellerId: String(p.sellerId),
      storeName: "Shop",
      items: [
        {
          productId: String(p._id),
          sku: "BLUE",
          quantity: 1,
          unitPricePaise: 2000,
          lineTotalPaise: 2000,
        },
      ],
    })),
    subtotalPaise: 4000,
    totalPaise: 0,
    discountPaise: 4000,
    shippingPaise: 0,
    taxPaise: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  await db("orders").insertOne(order);
  await db("payments").insertOne({
    _id: id(),
    orderId: order._id,
    customerId: customer.id,
    status: "paid",
    amountPaise: 0,
    currency: "INR",
    creationKey: randomUUID(),
    creationParams: {},
    refundStatus: "none",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});
after(async () => {
  assert.match(mongoose.connection.name, /^marketplace_test_[a-f0-9]+$/);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
test("legacy orders expose pending fulfillment and customer-only refund eligibility without seller leakage", async () => {
  const view = (await get().expect(200)).body.data.order;
  assert.equal(view.canRefund, true);
  assert.equal(view.fulfillments.length, 2);
  assert.deepEqual(
    view.fulfillments.map((f) => [f.status, f.version, f.tracking]),
    [
      ["pending", 0, null],
      ["pending", 0, null],
    ],
  );
  const own = (await get(seller).expect(200)).body.data.order;
  assert.equal(own.fulfillments.length, 1);
  assert.equal(own.fulfillments[0].sellerId, String(seller.id));
  assert.equal(own.canRefund, undefined);
});
test("sellers progress sequentially with exact history, replay and independent versions", async () => {
  const first = await transition("processing", 0).expect(200);
  assert.equal(first.body.data.order.fulfillments[0].status, "processing");
  assert.equal(first.body.data.order.fulfillments[0].version, 1);
  await transition("processing", 0).expect(200);
  await transition("packed", 0).expect(409);
  await transition("delivered", 1).expect(409);
  await Promise.all([
    transition("packed", 1).expect(200),
    transition("processing", 0, secondSeller).expect(200),
  ]);
  const view = (await get().expect(200)).body.data.order;
  assert.equal(view.canRefund, false);
  assert.deepEqual(
    view.fulfillments.map((f) => [f.status, f.version]),
    [
      ["packed", 2],
      ["processing", 1],
    ],
  );
  assert.deepEqual(
    view.fulfillments[0].history.map((h) => h.status),
    ["pending", "processing", "packed"],
  );
  assert.equal((await inventory(0)).committed, 1);
  assert.equal((await inventory(1)).committed, 1);
  assert.deepEqual(
    (await db("orders").findOne({ _id: order._id })).groups,
    order.groups,
  );
});
test("shipping consumes committed inventory once and exact tracking replays cannot change details", async () => {
  await transition("processing", 0).expect(200);
  await transition("packed", 1).expect(200);
  await Promise.all([
    transition("shipped", 2, seller, tracking).expect(200),
    transition("shipped", 2, seller, tracking).expect(200),
  ]);
  assert.equal((await inventory(0)).committed, 0);
  assert.equal((await inventory(0)).stock, 3);
  assert.equal((await inventory(1)).committed, 1);
  await transition("shipped", 2, seller, {
    ...tracking,
    trackingNumber: "OTHER",
  }).expect(409);
  await transition("processing", 0).expect(409);
  await transition("delivered", 3).expect(200);
  await transition("delivered", 3).expect(200);
  const view = (await get().expect(200)).body.data.order;
  assert.equal(view.status, "paid");
  assert.deepEqual(view.fulfillments[0].tracking, tracking);
  assert.deepEqual(
    view.fulfillments[0].history.map((h) => h.status),
    ["pending", "processing", "packed", "shipped", "delivered"],
  );
  assert.equal((await inventory(0)).committed, 0);
  assert.equal((await inventory(0)).stock, 3);
  assert.equal(
    JSON.stringify((await get(secondSeller)).body.data.order).includes(
      "IN12345",
    ),
    false,
  );
});
test("only the owning approved seller can transition a paid order", async () => {
  await transition("processing", 0, outsider).expect(404);
  await transition("processing", 0, customer).expect(403);
  await db("users").updateOne(
    { _id: seller.id },
    { $set: { sellerStatus: "pending" } },
  );
  await transition("processing", 0).expect(403);
  await db("users").updateOne(
    { _id: seller.id },
    { $set: { sellerStatus: "approved" } },
  );
  for (const status of [
    "awaiting_payment",
    "cancelled",
    "expired",
    "refund_pending",
    "refunded",
  ]) {
    await db("orders").updateOne({ _id: order._id }, { $set: { status } });
    await transition("processing", 0).expect(409);
  }
  assert.equal((await inventory(0)).committed, 1);
});
test("tracking, versions, statuses and route params use strict shared validation", async () => {
  for (const data of [
    { status: "shipped", expectedVersion: 0 },
    { status: "pending", expectedVersion: 0 },
    { status: "processing", expectedVersion: -1 },
    { status: "processing", expectedVersion: 0.1 },
    { status: "processing", expectedVersion: 0, sellerId: String(seller.id) },
    { status: "processing", expectedVersion: 0, tracking },
    {
      status: "shipped",
      expectedVersion: 2,
      tracking: { carrier: " ", trackingNumber: "x" },
    },
    {
      status: "shipped",
      expectedVersion: 2,
      tracking: { ...tracking, trackingUrl: "http://example.test" },
    },
    {
      status: "shipped",
      expectedVersion: 2,
      tracking: {
        ...tracking,
        trackingUrl: "https://name:password@example.test",
      },
    },
    {
      status: "shipped",
      expectedVersion: 2,
      tracking: { ...tracking, secret: "x" },
    },
  ])
    await call(
      "patch",
      `/seller/orders/${order._id}/fulfillment`,
      seller,
      data,
    ).expect(422);
  await call("patch", "/seller/orders/invalid/fulfillment", seller, {
    status: "processing",
    expectedVersion: 0,
  }).expect(422);
});
test("processing prevents a full refund without touching committed inventory", async () => {
  await transition("processing", 0).expect(200);
  await call(
    "post",
    `/orders/${order._id}/payment/refund`,
    customer,
    {},
  ).expect(409);
  assert.equal((await inventory(0)).committed, 1);
  assert.equal((await inventory(1)).committed, 1);
  assert.equal(
    (await db("payments").findOne({ orderId: order._id })).status,
    "paid",
  );
});
test("refund and processing race has one winner and keeps both sellers inventory consistent", async () => {
  const results = await Promise.all([
    transition("processing", 0),
    call("post", `/orders/${order._id}/payment/refund`, customer, {}),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const stored = await db("orders").findOne({ _id: order._id });
  if (stored.status === "refunded") {
    assert.equal((await inventory(0)).committed, 0);
    assert.equal((await inventory(0)).stock, 4);
    assert.equal((await inventory(1)).stock, 5);
    assert.equal(
      (await get()).body.data.order.fulfillments[0].status,
      "pending",
    );
  } else {
    assert.equal(stored.status, "paid");
    assert.equal((await inventory(0)).committed, 1);
    assert.equal((await inventory(0)).stock, 3);
    assert.equal((await inventory(1)).stock, 4);
    assert.equal(
      (await get()).body.data.order.fulfillments[0].status,
      "processing",
    );
  }
});
test("failed shipping inventory adjustment rolls back status and history", async () => {
  await transition("processing", 0).expect(200);
  await transition("packed", 1).expect(200);
  await db("products").updateOne(
    { _id: products[0]._id },
    { $set: { "variants.0.committed": 0 } },
  );
  await transition("shipped", 2, seller, tracking).expect(409);
  const fulfillment = (await get()).body.data.order.fulfillments[0];
  assert.equal(fulfillment.status, "packed");
  assert.equal(fulfillment.version, 2);
  assert.equal(fulfillment.history.length, 3);
  assert.equal((await inventory(0)).stock, 3);
});
test("shipping rollback restores an earlier SKU decrement if a later SKU is unavailable", async () => {
  const missing = id();
  await db("orders").updateOne(
    { _id: order._id },
    {
      $push: {
        "groups.0.items": {
          productId: String(missing),
          sku: "MISSING",
          quantity: 1,
          unitPricePaise: 2000,
          lineTotalPaise: 2000,
        },
      },
    },
  );
  await transition("processing", 0).expect(200);
  await transition("packed", 1).expect(200);
  await transition("shipped", 2, seller, tracking).expect(409);
  assert.equal((await inventory(0)).committed, 1);
  assert.equal((await inventory(0)).stock, 3);
  assert.equal((await get()).body.data.order.fulfillments[0].status, "packed");
});
test("approval revoked after HTTP authorization cannot commit seller processing", async (t) => {
  const { User } = await import("../src/models/user.model.js");
  const original = User.collection.updateOne.bind(User.collection);
  let intercepted = false;
  const method = t.mock.method(
    User.collection,
    "updateOne",
    async function (filter, update, options) {
      if (update?.$inc?.fulfillmentRevision && !intercepted) {
        intercepted = true;
        await db("users").updateOne(
          { _id: seller.id },
          { $set: { sellerStatus: "rejected" } },
        );
      }
      return original(filter, update, options);
    },
  );
  try {
    await transition("processing", 0).expect(403);
  } finally {
    method.mock.restore();
  }
  assert.equal(intercepted, true);
  assert.equal((await get()).body.data.order.fulfillments[0].status, "pending");
  assert.equal((await inventory(0)).committed, 1);
});
test("a refund that wins first cannot be followed by fulfillment, including replay requests", async () => {
  await call(
    "post",
    `/orders/${order._id}/payment/refund`,
    customer,
    {},
  ).expect(200);
  await transition("processing", 0).expect(409);
  await transition("processing", 0, secondSeller).expect(409);
  const view = (await get()).body.data.order;
  assert.equal(view.canRefund, false);
  assert.equal(view.status, "refunded");
  assert.equal(view.fulfillments[0].version, 0);
  assert.equal((await inventory(0)).stock, 4);
  assert.equal((await inventory(1)).stock, 5);
});
