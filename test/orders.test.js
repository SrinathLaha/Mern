import { User } from "../src/models/user.model.js";
import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../src/app.js";
import { createReservationJobs } from "../src/jobs/reservation.jobs.js";
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
let app, customer, other, seller, seller2, admin, product, second, addressId;
const call = (method, path, token = customer?.token, body) => {
  const client = request(app);
  const req = client[method](`/api${path}`).set(
    "Origin",
    config.frontendOrigin,
  );
  if (token) req.set("Authorization", `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
};
async function account(role, name) {
  const userId = id(),
    sid = randomUUID();
  await db("users").insertOne({
    _id: userId,
    name,
    email: `${name}@example.test`,
    role,
    status: "active",
    sellerStatus: "approved",
    storeName: name,
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
async function cart(
  who = customer,
  items = [{ productId: product._id, sku: "BLUE", quantity: 1 }],
) {
  await db("carts").updateOne(
    { customerId: who.id },
    { $set: { items }, $inc: { version: 1 } },
    { upsert: true },
  );
}
const quote = (who = customer, couponCode) =>
  call("post", "/checkout/quote", who.token, {
    addressId: String(addressId),
    ...(couponCode ? { couponCode } : {}),
  });
const submit = (quoteId, key = randomUUID(), who = customer) =>
  call("post", "/orders", who.token, { quoteId, idempotencyKey: key });
const coupon = (maxUses = 1) =>
  call("post", "/admin/coupons", admin.token, {
    code: "SAVE",
    discountPaise: 500,
    minSubtotalPaise: 1000,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    maxUses,
  });
before(async () => {
  await mongoose.connect(
    process.env.TEST_MONGODB_URI ||
      "mongodb://127.0.0.1:27018/?replicaSet=marketplace-rs",
    { dbName: databaseName, serverSelectionTimeoutMS: 5000 },
  );
  app = createApp(config);
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
  customer = await account("customer", "customer");
  other = await account("customer", "other");
  seller = await account("seller", "Studio One");
  seller2 = await account("seller", "Studio Two");
  admin = await account("admin", "admin");
});
beforeEach(async () => {
  for (const collection of [
    "carts",
    "products",
    "categories",
    "addressbooks",
    "checkoutquotes",
    "orders",
    "coupons",
  ])
    await db(collection).deleteMany({});
  const categoryId = id();
  addressId = id();
  await db("categories").insertOne({
    _id: categoryId,
    name: "Mugs",
    normalizedName: "mugs",
    active: true,
  });
  product = {
    _id: id(),
    sellerId: seller.id,
    categoryId,
    title: "Blue mug",
    description: "Ceramic mug",
    images: [{ url: "https://example.test/mug.jpg", alt: "Mug" }],
    variants: [{ sku: "BLUE", label: "Blue", pricePaise: 2000, stock: 2 }],
    status: "approved",
    version: 0,
  };
  second = { ...product, _id: id(), sellerId: seller2.id, title: "Other mug" };
  await db("products").insertMany([product, second]);
  for (const who of [customer, other])
    await db("addressbooks").insertOne({
      _id: who.id,
      version: 0,
      addresses: [
        {
          _id: who === customer ? addressId : id(),
          recipient: "Asha",
          phone: "9876543210",
          line1: "12 Main Road",
          line2: "",
          city: "Pune",
          region: "Maharashtra",
          postalCode: "411001",
          country: "IN",
        },
      ],
    });
  await cart();
});
after(async () => {
  if (
    mongoose.connection.name === databaseName &&
    /^marketplace_test_[a-f0-9]{32}$/.test(databaseName)
  )
    await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
test("quote requires owned address and strict customer input", async () => {
  await call("post", "/checkout/quote", null, {
    addressId: String(addressId),
  }).expect(401);
  await quote(seller).expect(403);
  await quote(other).expect(404);
  await call("post", "/checkout/quote", customer.token, {
    addressId: String(addressId),
    discountPaise: 1,
  }).expect(422);
  const q = (await quote().expect(201)).body.data.quote;
  assert.equal(q.totalPaise, 2000);
  assert.equal(q.groups[0].items[0].unitPricePaise, 2000);
  assert.equal(
    (await db("products").findOne({ _id: product._id })).variants[0].stock,
    2,
  );
});
test("order reserves once, consumes cart, snapshots sellers and restricts seller totals", async () => {
  await cart(customer, [
    { productId: product._id, sku: "BLUE", quantity: 1 },
    { productId: second._id, sku: "BLUE", quantity: 2 },
  ]);
  await coupon().expect(201);
  const q = (await quote(customer, "save").expect(201)).body.data.quote;
  const key = randomUUID();
  const results = await Promise.all([submit(q.id, key), submit(q.id, key)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  const order = results[0].body.data.order;
  assert.equal(order.totalPaise, 5500);
  assert.equal(order.discountPaise, 500);
  assert.equal(order.status, "awaiting_payment");
  assert.equal(results[1].body.data.order.id, order.id);
  const p = await db("products").findOne({ _id: product._id });
  assert.equal(p.variants[0].stock, 1);
  assert.equal(p.variants[0].reserved, 1);
  assert.equal(p.version, 1);
  assert.equal(
    (await db("carts").findOne({ customerId: customer.id })).items.length,
    0,
  );
  assert.equal((await db("coupons").findOne({ code: "SAVE" })).usedCount, 1);
  await call("get", `/orders/${order.id}`, other.token).expect(404);
  const visible = (
    await call("get", `/seller/orders/${order.id}`, seller.token).expect(200)
  ).body.data.order;
  assert.equal(visible.groups.length, 1);
  assert.equal(visible.groups[0].sellerId, String(seller.id));
  assert.equal(visible.subtotalPaise, 2000);
  for (const field of [
    "totalPaise",
    "discountPaise",
    "couponCode",
    "customerId",
    "idempotencyKey",
  ])
    assert.equal(visible[field], undefined);
  assert.equal(
    (await call("get", "/seller/orders", seller2.token)).body.data.total,
    1,
  );
  await cart();
  const q2 = (await quote().expect(201)).body.data.quote;
  await submit(q2.id, key).expect(409);
  await submit(q.id).expect(200);
});
test("changed cart, address, price and expired quote reject without consuming cart", async () => {
  for (const change of [
    () =>
      db("carts").updateOne(
        { customerId: customer.id },
        { $inc: { version: 1 } },
      ),
    () =>
      db("addressbooks").updateOne(
        { _id: customer.id },
        { $inc: { version: 1 } },
      ),
    () =>
      db("products").updateOne(
        { _id: product._id },
        { $set: { "variants.0.pricePaise": 2100 } },
      ),
    (q) =>
      db("checkoutquotes").updateOne(
        { _id: new mongoose.Types.ObjectId(q.id) },
        { $set: { expiresAt: new Date(0) } },
      ),
  ]) {
    const q = (await quote().expect(201)).body.data.quote;
    await change(q);
    await submit(q.id).expect(409);
    assert.equal(
      (await db("carts").findOne({ customerId: customer.id })).items.length,
      1,
    );
    assert.equal(await db("orders").countDocuments(), 0);
    assert.equal(
      (await db("products").findOne({ _id: product._id })).variants[0].stock,
      2,
    );
  }
});
test("last-stock race permits exactly one order", async () => {
  await db("products").updateOne(
    { _id: product._id },
    { $set: { "variants.0.stock": 1 } },
  );
  await db("addressbooks").updateOne(
    { _id: other.id },
    { $set: { "addresses.0._id": addressId } },
  );
  await cart(other);
  const q1 = (await quote()).body.data.quote,
    q2 = (await quote(other)).body.data.quote;
  const results = await Promise.all([
    submit(q1.id),
    submit(q2.id, randomUUID(), other),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(await db("orders").countDocuments(), 1);
  const p = await db("products").findOne({ _id: product._id });
  assert.equal(p.variants[0].stock, 0);
  assert.equal(p.variants[0].reserved, 1);
  assert.equal(
    await db("carts").countDocuments({ "items.0": { $exists: true } }),
    1,
  );
});
test("coupon capacity races roll back the losing order's inventory", async () => {
  await coupon().expect(201);
  await db("addressbooks").updateOne(
    { _id: other.id },
    { $set: { "addresses.0._id": addressId } },
  );
  await cart(other, [{ productId: second._id, sku: "BLUE", quantity: 1 }]);
  const q1 = (await quote(customer, "SAVE")).body.data.quote,
    q2 = (await quote(other, "SAVE")).body.data.quote;
  const results = await Promise.all([
    submit(q1.id),
    submit(q2.id, randomUUID(), other),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal((await db("coupons").findOne({ code: "SAVE" })).usedCount, 1);
  const products = await db("products").find({}).toArray();
  assert.equal(
    products.reduce((sum, p) => sum + p.variants[0].stock, 0),
    3,
  );
  assert.equal(await db("orders").countDocuments(), 1);
});
test("cancel and read expiry release inventory and coupon exactly once", async () => {
  await coupon().expect(201);
  const q = (await quote(customer, "SAVE")).body.data.quote;
  const order = (await submit(q.id)).body.data.order;
  await Promise.all([
    call("post", `/orders/${order.id}/cancel`, customer.token, {}).expect(200),
    call("post", `/orders/${order.id}/cancel`, customer.token, {}).expect(200),
  ]);
  assert.equal(
    (await db("products").findOne({ _id: product._id })).variants[0].stock,
    2,
  );
  assert.equal((await db("coupons").findOne({ code: "SAVE" })).usedCount, 0);
  await cart();
  const q2 = (await quote(customer, "SAVE")).body.data.quote;
  const order2 = (await submit(q2.id)).body.data.order;
  await db("orders").updateOne(
    { _id: new mongoose.Types.ObjectId(order2.id) },
    { $set: { reservationExpiresAt: new Date(0) } },
  );
  assert.equal(
    (await call("get", `/orders/${order2.id}`).expect(200)).body.data.order
      .status,
    "expired",
  );
  await call("get", "/orders").expect(200);
  const p = await db("products").findOne({ _id: product._id });
  assert.equal(p.variants[0].stock, 2);
  assert.equal(p.variants[0].reserved, 0);
  assert.equal((await db("coupons").findOne({ code: "SAVE" })).usedCount, 0);
});
test("seller cannot replace reserved variants", async () => {
  const q = (await quote()).body.data.quote;
  const order = (await submit(q.id)).body.data.order;
  const fields = {
    title: "New title",
    description: "A new description",
    categoryId: String(product.categoryId),
    images: product.images,
    variants: [{ sku: "BLUE", label: "Blue", price: "20.00", stock: 2 }],
    version: 1,
  };
  await call(
    "patch",
    `/seller/products/${product._id}`,
    seller.token,
    fields,
  ).expect(409);
  await call("post", `/orders/${order.id}/cancel`, customer.token, {}).expect(
    200,
  );
  await call("patch", `/seller/products/${product._id}`, seller.token, {
    ...fields,
    version: 2,
  }).expect(200);
});
test("coupon admin enforces role, unique codes, and versioned disable", async () => {
  await call("get", "/admin/coupons", customer.token).expect(403);
  const c = (await coupon().expect(201)).body.data.coupon;
  await coupon().expect(409);
  await call("post", `/admin/coupons/${c.id}/disable`, admin.token, {
    version: 99,
  }).expect(409);
  await call("post", `/admin/coupons/${c.id}/disable`, admin.token, {
    version: c.version,
  }).expect(200);
  await quote(customer, "SAVE").expect(409);
  await call("get", "/orders?page=-1").expect(422);
  await call("get", "/orders?customerId=any").expect(422);
  await submit("invalid").expect(422);
});

test("unrelated stock reservations preserve a still-valid quote", async () => {
  await db("addressbooks").updateOne(
    { _id: other.id },
    { $set: { "addresses.0._id": addressId } },
  );
  await cart(other);
  const q1 = (await quote().expect(201)).body.data.quote;
  const q2 = (await quote(other).expect(201)).body.data.quote;
  await submit(q1.id).expect(201);
  await submit(q2.id, randomUUID(), other).expect(201);
  const p = await db("products").findOne({ _id: product._id });
  assert.equal(p.variants[0].stock, 0);
  assert.equal(p.variants[0].reserved, 2);
});

test("failed release rolls back an earlier inventory write and order transition", async () => {
  await cart(customer, [
    { productId: product._id, sku: "BLUE", quantity: 1 },
    { productId: second._id, sku: "BLUE", quantity: 1 },
  ]);
  const q = (await quote().expect(201)).body.data.quote;
  const order = (await submit(q.id).expect(201)).body.data.order;
  await db("products").updateOne(
    { _id: second._id },
    { $set: { "variants.0.reserved": 0 } },
  );
  await call("post", `/orders/${order.id}/cancel`, customer.token, {}).expect(
    409,
  );
  const p = await db("products").findOne({ _id: product._id });
  assert.equal(p.variants[0].stock, 1);
  assert.equal(p.variants[0].reserved, 1);
  assert.equal(
    (await db("orders").findOne({ _id: new mongoose.Types.ObjectId(order.id) }))
      .status,
    "awaiting_payment",
  );
  await db("products").updateOne(
    { _id: second._id },
    { $set: { "variants.0.reserved": 1 } },
  );
  await call("post", `/orders/${order.id}/cancel`, customer.token, {}).expect(
    200,
  );
});

test("a restarted worker releases overdue reservations and closes cleanly", async () => {
  const q = (await quote().expect(201)).body.data.quote;
  const order = (await submit(q.id).expect(201)).body.data.order;
  await db("orders").updateOne(
    { _id: new mongoose.Types.ObjectId(order.id) },
    { $set: { reservationExpiresAt: new Date(0) } },
  );
  const errors = [];
  const jobs = createReservationJobs({
    onError: (error) => errors.push(error),
  });
  await jobs.close();
  assert.deepEqual(errors, []);
  assert.equal(
    (await db("orders").findOne({ _id: new mongoose.Types.ObjectId(order.id) }))
      .status,
    "expired",
  );
  const again = createReservationJobs({
    onError: (error) => errors.push(error),
  });
  await again.close();
  assert.equal(
    (await db("products").findOne({ _id: product._id })).variants[0].stock,
    2,
  );
});

test("coupon discount is capped to subtotal and invalid monetary values are rejected", async () => {
  const valid = {
    code: "FULL",
    discountPaise: 3000,
    minSubtotalPaise: 0,
    maxUses: 2,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  for (const data of [
    { ...valid, discountPaise: 1.2 },
    { ...valid, discountPaise: 100000001 },
    { ...valid, maxUses: 0 },
    { ...valid, usedCount: 0 },
    { ...valid, expiresAt: new Date(0).toISOString() },
  ])
    await call("post", "/admin/coupons", admin.token, data).expect(422);
  await call("post", "/admin/coupons", admin.token, valid).expect(201);
  const q = (await quote(customer, "FULL").expect(201)).body.data.quote;
  assert.equal(q.discountPaise, 2000);
  assert.equal(q.totalPaise, 0);
  assert.equal((await submit(q.id).expect(201)).body.data.order.totalPaise, 0);
});

test("legacy products without reserved fields remain editable and archive guards holds", async () => {
  const fields = {
    title: "New title",
    description: "A new description",
    categoryId: String(product.categoryId),
    images: product.images,
    variants: [{ sku: "BLUE", label: "Blue", price: "20.00", stock: 2 }],
    version: 0,
  };
  await call(
    "patch",
    `/seller/products/${second._id}`,
    seller2.token,
    fields,
  ).expect(200);
  const q = (await quote().expect(201)).body.data.quote;
  await submit(q.id).expect(201);
  await call("post", `/seller/products/${product._id}/archive`, seller.token, {
    version: 1,
  }).expect(409);
  await call("get", "/seller/orders", customer.token).expect(403);
  await call("get", "/orders", seller.token).expect(403);
});

test("concurrent seller or category changes after snapshot reads reject stale checkout", async (t) => {
  for (const resource of ["seller", "category"]) {
    const q = (await quote().expect(201)).body.data.quote;
    const original = User.findOne;
    let changed = false;
    const interception = t.mock.method(User, "findOne", function (...args) {
      const query = original.apply(this, args);
      if (args[0]?.role === "seller") {
        const lean = query.lean;
        query.lean = async function (...leanArgs) {
          const result = await lean.apply(this, leanArgs);
          if (!changed) {
            changed = true;
            if (resource === "seller")
              await db("users").updateOne(
                { _id: seller.id },
                { $set: { storeName: "Changed store" } },
              );
            else
              await db("categories").updateOne(
                { _id: product.categoryId },
                { $set: { active: false } },
              );
          }
          return result;
        };
      }
      return query;
    });
    try {
      await submit(q.id).expect(409);
    } finally {
      interception.mock.restore();
    }
    assert.equal(changed, true);
    assert.equal(await db("orders").countDocuments(), 0);
    assert.equal(
      (await db("products").findOne({ _id: product._id })).variants[0].stock,
      2,
    );
    await db("categories").updateOne(
      { _id: product.categoryId },
      { $set: { active: true } },
    );
  }
});

test("one quote creates one order even when submissions use different retry keys", async () => {
  const q = (await quote().expect(201)).body.data.quote;
  const results = await Promise.all([submit(q.id), submit(q.id)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 201]);
  assert.equal(results[0].body.data.order.id, results[1].body.data.order.id);
  assert.equal(await db("orders").countDocuments(), 1);
  assert.equal(
    (await db("products").findOne({ _id: product._id })).variants[0].reserved,
    1,
  );
  const orderId = results[0].body.data.order.id;
  await call("post", `/orders/${orderId}/cancel`, other.token, {}).expect(404);
  await call("get", `/seller/orders/${orderId}`, seller2.token).expect(404);
  await call("post", `/orders/${orderId}/cancel`, seller.token, {}).expect(403);
});

test("order endpoints reject malformed identifiers, unknown fields and injected prices", async () => {
  const q = (await quote().expect(201)).body.data.quote;
  for (const input of [
    { quoteId: q.id, idempotencyKey: "not-a-uuid" },
    { quoteId: q.id, idempotencyKey: randomUUID(), totalPaise: 0 },
    {
      quoteId: q.id,
      idempotencyKey: randomUUID(),
      customerId: String(other.id),
    },
  ])
    await call("post", "/orders", customer.token, input).expect(422);
  for (const path of [
    "/orders/invalid",
    "/seller/orders/invalid",
    "/orders?page=100000",
    "/orders?page=1.5",
  ])
    await call(
      "get",
      path,
      path.startsWith("/seller/") ? seller.token : customer.token,
    ).expect(422);
  await call("post", "/admin/coupons/invalid/disable", admin.token, {
    version: 0,
  }).expect(422);
  assert.equal(await db("orders").countDocuments(), 0);
});
