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
let app, customer, other, seller, admin, product, categoryId;
const db = (name) => mongoose.connection.collection(name);
const call = (method, path, token = customer?.token, body) => {
  const client = request(app);
  const req = client[method](`/api${path}`).set("Origin", config.frontendOrigin);
  if (token) req.set("Authorization", `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
};
async function account(email, role) {
  const result = await call("post", "/auth/register", null, {
    name: "Asha Sharma",
    email,
    phone: "9876543210",
    password: "Example passphrase!",
    accountType: role === "admin" ? "customer" : role,
    ...(role === "seller" ? { storeName: "Asha Studio" } : {}),
  }).expect(201);
  await db("users").updateOne(
    { email },
    {
      $set: {
        role,
        ...(role === "seller" ? { sellerStatus: "approved" } : {}),
      },
    },
  );
  const login = await call("post", "/auth/login", null, {
    email,
    password: "Example passphrase!",
  }).expect(200);
  return {
    id: new mongoose.Types.ObjectId(result.body.data.user.id),
    token: login.body.data.accessToken,
  };
}
const add = (quantity = 1, id = product._id.toString(), sku = "MUG-BLUE") =>
  call("post", "/cart/items", customer.token, { productId: id, sku, quantity });
const linePath = () => `/cart/items/${product._id}/MUG-BLUE`;
const wishPath = () => `/wishlist/items/${product._id}`;
before(async () => {
  await mongoose.connect(
    process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017",
    { dbName: databaseName, serverSelectionTimeoutMS: 5000 },
  );
  app = createApp(config);
  await Promise.all(
    Object.values(mongoose.models).map((model) => model.init()),
  );
  customer = await account("customer@example.test", "customer");
  other = await account("other@example.test", "customer");
  seller = await account("seller@example.test", "seller");
  admin = await account("admin@example.test", "admin");
});
beforeEach(async () => {
  await Promise.all(
    ["carts", "wishlists", "products", "categories"].map((name) =>
      db(name).deleteMany({}),
    ),
  );
  await db("users").updateOne(
    { _id: seller.id },
    { $set: { status: "active", sellerStatus: "approved", role: "seller" } },
  );
  categoryId = new mongoose.Types.ObjectId();
  await db("categories").insertOne({
    _id: categoryId,
    name: "Ceramics",
    normalizedName: "ceramics",
    active: true,
  });
  product = {
    _id: new mongoose.Types.ObjectId(),
    sellerId: seller.id,
    categoryId,
    title: "Handmade mug",
    description: "Handmade ceramic mug",
    images: [{ url: "https://example.test/mug.jpg", alt: "Blue mug" }],
    variants: [
      { sku: "MUG-BLUE", label: "Blue", pricePaise: 19999, stock: 20 },
    ],
    status: "approved",
  };
  await db("products").insertOne(product);
});
after(async () => {
  if (
    mongoose.connection.name === databaseName &&
    /^marketplace_test_[a-f0-9]{32}$/.test(databaseName)
  )
    await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("cart and wishlist require customers and isolate ownership", async () => {
  for (const path of ["/cart", "/wishlist"]) {
    await call("get", path, null).expect(401);
    await call("get", path, seller.token).expect(403);
    await call("get", path, admin.token).expect(403);
  }
  const empty = (await call("get", "/cart").expect(200)).body.data.cart;
  assert.deepEqual(empty, {
    version: 0,
    items: [],
    subtotalPaise: 0,
    itemCount: 0,
    hasUnavailableItems: false,
  });
  await add(2).expect(200);
  await call("put", wishPath()).expect(200);
  assert.equal(
    (await call("get", "/cart", other.token)).body.data.cart.items.length,
    0,
  );
  assert.equal(
    (await call("get", "/wishlist", other.token)).body.data.wishlist.items
      .length,
    0,
  );
  await call("delete", linePath(), other.token, { version: 0 }).expect(200);
  assert.equal((await call("get", "/cart")).body.data.cart.itemCount, 2);
});

test("cart rejects injected fields and invalid quantities, versions and route keys", async () => {
  for (const quantity of [0, -1, 1.5, 100, "2", null])
    await add(quantity).expect(422);
  await call("post", "/cart/items", customer.token, {
    productId: String(product._id),
    sku: "MUG-BLUE",
    quantity: 1,
    pricePaise: 1,
  }).expect(422);
  await add(1, "invalid").expect(422);
  await add(1, String(product._id), "bad/sku").expect(422);
  await call("patch", linePath(), customer.token, { quantity: 2 }).expect(422);
  await call("delete", linePath(), customer.token, { version: -1 }).expect(422);
  await call("put", wishPath(), customer.token, {
    customerId: String(other.id),
  }).expect(422);
  await call("delete", "/wishlist/items/invalid").expect(422);
});

test("cart totals use current integer prices and versioned updates reject stale writes", async () => {
  const cart = (await add(3).expect(200)).body.data.cart;
  assert.equal(cart.subtotalPaise, 59997);
  assert.equal(cart.items[0].variantLabel, "Blue");
  assert.equal(cart.items[0].storeName, "Asha Studio");
  await db("products").updateOne(
    { _id: product._id },
    { $set: { "variants.0.pricePaise": 105 } },
  );
  assert.equal((await call("get", "/cart")).body.data.cart.subtotalPaise, 315);
  const edited = (
    await call("patch", linePath(), customer.token, {
      quantity: 2,
      version: cart.version,
    }).expect(200)
  ).body.data.cart;
  assert.equal(edited.subtotalPaise, 210);
  await call("patch", linePath(), customer.token, {
    quantity: 1,
    version: cart.version,
  }).expect(409);
  await call("delete", linePath(), customer.token, {
    version: cart.version,
  }).expect(409);
  await call("delete", linePath(), customer.token, {
    version: edited.version,
  }).expect(200);
});

test("simultaneous adds neither lose increments nor bypass stock", async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => add(1)));
  assert.ok(
    results.every((result) => result.status === 200),
    results.map((result) => result.status).join(","),
  );
  let cart = (await call("get", "/cart")).body.data.cart;
  assert.equal(cart.itemCount, 12);
  assert.equal(cart.version, 12);
  const limited = await Promise.all(Array.from({ length: 12 }, () => add(1)));
  assert.equal(limited.filter((result) => result.status === 200).length, 8);
  assert.ok(limited.every((result) => [200, 409].includes(result.status)));
  cart = (await call("get", "/cart")).body.data.cart;
  assert.equal(cart.itemCount, 20);
  const edits = await Promise.all(
    [1, 2].map((quantity) =>
      call("patch", linePath(), customer.token, {
        quantity,
        version: cart.version,
      }),
    ),
  );
  assert.deepEqual(edits.map((result) => result.status).sort(), [200, 409]);
});

test("current visibility hides saved product details while allowing removal", async () => {
  const hiddenCases = [
    [
      "products",
      { _id: product._id },
      { status: "draft" },
      { status: "approved" },
    ],
    ["categories", { _id: categoryId }, { active: false }, { active: true }],
    [
      "users",
      { _id: seller.id },
      { status: "suspended" },
      { status: "active" },
    ],
    [
      "users",
      { _id: seller.id },
      { sellerStatus: "pending" },
      { sellerStatus: "approved" },
    ],
  ];
  await add().expect(200);
  await call("put", wishPath()).expect(200);
  for (const [collection, filter, hidden, visible] of hiddenCases) {
    await db(collection).updateOne(filter, { $set: hidden });
    const cart = (await call("get", "/cart").expect(200)).body.data.cart;
    assert.equal(cart.items[0].title, "Unavailable product");
    assert.equal(cart.items[0].image, null);
    assert.equal(cart.items[0].unitPricePaise, null);
    assert.equal(cart.items[0].storeName, "");
    assert.equal(cart.subtotalPaise, 0);
    assert.equal(cart.hasUnavailableItems, true);
    const wish = (await call("get", "/wishlist").expect(200)).body.data.wishlist
      .items[0];
    assert.equal(wish.available, false);
    assert.equal(wish.title, "Unavailable product");
    await add().expect(409);
    await db(collection).updateOne(filter, { $set: visible });
  }
  await db("products").deleteOne({ _id: product._id });
  const cart = (await call("get", "/cart")).body.data.cart;
  await call("delete", linePath(), customer.token, {
    version: cart.version,
  }).expect(200);
  await call("delete", wishPath()).expect(200);
});

test("missing variants and insufficient stock are excluded from totals", async () => {
  await add(3).expect(200);
  await db("products").updateOne(
    { _id: product._id },
    { $set: { "variants.0.stock": 2 } },
  );
  let cart = (await call("get", "/cart")).body.data.cart;
  assert.equal(cart.items[0].available, false);
  assert.equal(cart.items[0].stock, 2);
  assert.equal(cart.subtotalPaise, 0);
  await call("patch", linePath(), customer.token, {
    quantity: 2,
    version: cart.version,
  }).expect(200);
  await db("products").updateOne(
    { _id: product._id },
    { $set: { variants: [] } },
  );
  cart = (await call("get", "/cart")).body.data.cart;
  assert.equal(cart.items[0].available, false);
  assert.equal(cart.items[0].unitPricePaise, null);
  await call("delete", linePath(), customer.token, {
    version: cart.version,
  }).expect(200);
});

test("cart line and quantity bounds cannot be bypassed", async () => {
  await db("products").updateOne(
    { _id: product._id },
    { $set: { "variants.0.stock": 1000 } },
  );
  await add(99).expect(200);
  await add(1).expect(409);
  const items = Array.from({ length: 50 }, (_, index) => ({
    productId: new mongoose.Types.ObjectId(),
    sku: `SKU-${index}`,
    quantity: 1,
  }));
  await db("carts").updateOne({ customerId: customer.id }, { $set: { items } });
  await add(1).expect(409);
});

test("concurrent distinct lines respect the 50-line cart limit", async () => {
  await add().expect(200);
  const items = Array.from({ length: 49 }, (_, index) => ({
    productId: new mongoose.Types.ObjectId(),
    sku: `SKU-${index}`,
    quantity: 1,
  }));
  await db("carts").updateOne({ customerId: customer.id }, { $set: { items } });
  const second = {
    ...product,
    _id: new mongoose.Types.ObjectId(),
    variants: [{ ...product.variants[0], sku: "OTHER-MUG" }],
  };
  await db("products").insertOne(second);
  const results = await Promise.all([
    add(),
    add(1, String(second._id), "OTHER-MUG"),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await call("get", "/cart")).body.data.cart.items.length, 50);
});

test("wishlist is idempotent, permits sold-out public products, and enforces cap under concurrency", async () => {
  await db("products").updateOne(
    { _id: product._id },
    { $set: { "variants.0.stock": 0 } },
  );
  const writes = await Promise.all(
    Array.from({ length: 6 }, () => call("put", wishPath())),
  );
  assert.ok(writes.every((result) => result.status === 200));
  assert.equal(
    (await call("get", "/wishlist")).body.data.wishlist.items.length,
    1,
  );
  await call("delete", wishPath()).expect(200);
  await call("delete", wishPath()).expect(200);
  await db("wishlists").updateOne(
    { customerId: customer.id },
    {
      $set: {
        productIds: Array.from(
          { length: 99 },
          () => new mongoose.Types.ObjectId(),
        ),
      },
    },
  );
  const second = {
    ...product,
    _id: new mongoose.Types.ObjectId(),
    variants: [{ ...product.variants[0], sku: "OTHER-MUG" }],
  };
  await db("products").insertOne(second);
  const capped = await Promise.all([
    call("put", wishPath()),
    call("put", `/wishlist/items/${second._id}`),
  ]);
  assert.deepEqual(capped.map((result) => result.status).sort(), [200, 409]);
  const list = (await call("get", "/wishlist")).body.data.wishlist;
  assert.equal(list.items.length, 100);
  const existing = capped[0].status === 200 ? product._id : second._id;
  await call("put", `/wishlist/items/${existing}`).expect(200);
  await db("products").updateOne(
    { _id: existing },
    { $set: { status: "draft" } },
  );
  await call("put", `/wishlist/items/${existing}`).expect(409);
  await db("products").updateOne(
    { _id: product._id },
    { $set: { status: "draft" } },
  );
  await call("put", wishPath(), other.token).expect(409);
});
