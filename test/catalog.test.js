import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../src/app.js";
import { productInput } from "../../shared/catalog.mjs";

const databaseName = `marketplace_test_${randomUUID().replaceAll("-", "")}`;
const config = {
  nodeEnv: "test",
  frontendOrigin: "http://localhost:3000",
  jwtSecret: "test-only-secret-that-is-at-least-48-characters-long",
  authLimit: 1000,
};
let app, admin, seller, other, pending, customer, category;
const call = (method, url, token, body) => {
  const client = request(app);
  const req = client[method](`/api${url}`).set("Origin", config.frontendOrigin);
  if (token) req.set("Authorization", `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
};
async function account(email, role, approved = true) {
  const result = await call("post", "/auth/register", null, {
    name: "Asha Sharma",
    email,
    phone: "9876543210",
    password: "Example passphrase!",
    accountType: role === "admin" ? "customer" : role,
    ...(role === "seller" ? { storeName: "Asha Studio" } : {}),
  }).expect(201);
  await mongoose.connection.collection("users").updateOne(
    { email },
    {
      $set: {
        role,
        ...(role === "seller" && approved ? { sellerStatus: "approved" } : {}),
      },
    },
  );
  const login = await call("post", "/auth/login", null, {
    email,
    password: "Example passphrase!",
  }).expect(200);
  return { id: result.body.data.user.id, token: login.body.data.accessToken };
}
function input(overrides = {}) {
  return {
    title: "Handmade mug",
    description: "A carefully handmade ceramic mug.",
    categoryId: category.id,
    images: [{ url: "https://example.test/mug.jpg", alt: "Blue mug" }],
    variants: [{ sku: "MUG-BLUE", label: "Blue", price: "199.99", stock: 3 }],
    ...overrides,
  };
}
async function create(overrides = {}, owner = seller) {
  const result = await call(
    "post",
    "/seller/products",
    owner.token,
    input(overrides),
  ).expect(201);
  return result.body.data.product;
}
async function approve(product) {
  const submit = await call(
    "post",
    `/seller/products/${product.id}/submit`,
    seller.token,
    { version: product.version },
  ).expect(200);
  const review = await call(
    "post",
    `/admin/products/${product.id}/review`,
    admin.token,
    { version: submit.body.data.product.version, decision: "approved" },
  ).expect(200);
  return review.body.data.product;
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
  admin = await account("admin@example.test", "admin");
  seller = await account("seller@example.test", "seller");
  other = await account("other@example.test", "seller");
  pending = await account("pending@example.test", "seller", false);
  customer = await account("customer@example.test", "customer");
});
beforeEach(async () => {
  await mongoose.connection.collection("categories").deleteMany({});
  await mongoose.connection.collection("products").deleteMany({});
  await mongoose.connection
    .collection("users")
    .updateOne(
      { _id: new mongoose.Types.ObjectId(seller.id) },
      { $set: { status: "active", sellerStatus: "approved" } },
    );
  const result = await call("post", "/admin/categories", admin.token, {
    name: "Ceramics",
    description: "Made by hand",
    active: true,
  }).expect(201);
  category = result.body.data.category;
});
after(async () => {
  if (
    mongoose.connection.name === databaseName &&
    /^marketplace_test_[a-f0-9]{32}$/.test(databaseName)
  )
    await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test("categories require admin and reject normalized duplicates and stale updates", async () => {
  await call("post", "/admin/categories", null, { name: "Wood" }).expect(401);
  await call("get", "/admin/categories", seller.token).expect(403);
  await call("post", "/admin/categories", customer.token, {
    name: "Wood",
  }).expect(403);
  const duplicate = await call("post", "/admin/categories", admin.token, {
    name: " CERAMICS ",
    description: "",
    active: true,
  }).expect(409);
  assert.match(duplicate.body.message, /category/i);
  const results = await Promise.all(
    ["Pottery", "Clayware"].map((name) =>
      call("patch", `/admin/categories/${category.id}`, admin.token, {
        name,
        description: "",
        active: false,
        version: 0,
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const publicList = await call("get", "/catalog/categories").expect(200);
  assert.equal(publicList.body.data.categories.length, 0);
  const adminList = await call("get", "/admin/categories", admin.token).expect(
    200,
  );
  assert.equal(adminList.body.data.categories[0].version, 1);
  await call("patch", "/admin/categories/not-an-id", admin.token, {
    ...category,
    version: 0,
    id: undefined,
  }).expect(404);
});

test("seller routes require approval and enforce ownership without leaking records", async () => {
  for (const [token, status] of [
    [null, 401],
    [customer.token, 403],
    [pending.token, 403],
  ]) {
    await call("get", "/seller/products", token).expect(status);
    await call("post", "/seller/products", token, input()).expect(status);
  }
  const product = await create();
  assert.equal(product.status, "draft");
  assert.equal(product.version, 0);
  assert.equal(product.storeName, "Asha Studio");
  assert.equal(product.categoryName, "Ceramics");
  for (const id of [
    product.id,
    "bad-id",
    new mongoose.Types.ObjectId().toString(),
  ]) {
    await call("get", `/seller/products/${id}`, other.token).expect(404);
    await call("patch", `/seller/products/${id}`, other.token, {
      ...input(),
      version: 0,
    }).expect(404);
    for (const action of ["submit", "archive"])
      await call("post", `/seller/products/${id}/${action}`, other.token, {
        version: 0,
      }).expect(404);
  }
  await call("post", "/seller/products", seller.token, {
    ...input(),
    sellerId: other.id,
  }).expect(422);
});

test("price uses integer paise and SKU uniqueness is per seller including concurrent creates", async () => {
  const product = await create({
    variants: [{ sku: "mug-blue", label: "Blue", price: "0.29", stock: 0 }],
  });
  assert.equal(product.variants[0].price, "0.29");
  assert.equal(product.variants[0].sku, "MUG-BLUE");
  const stored = await mongoose.connection
    .collection("products")
    .findOne({ _id: new mongoose.Types.ObjectId(product.id) });
  assert.equal(stored.variants[0].pricePaise, 29);
  const duplicate = await call(
    "post",
    "/seller/products",
    seller.token,
    input(),
  ).expect(409);
  assert.match(duplicate.body.message, /sku/i);
  await create({}, other);
  await call(
    "post",
    "/seller/products",
    seller.token,
    input({
      variants: [
        { sku: "DUP", label: "One", price: "1.00", stock: 1 },
        { sku: "dup", label: "Two", price: "2", stock: 1 },
      ],
    }),
  ).expect(409);
  const concurrent = await Promise.all(
    [1, 2].map(() =>
      call(
        "post",
        "/seller/products",
        seller.token,
        input({
          variants: [{ sku: "RACE", label: "One", price: "1", stock: 1 }],
        }),
      ),
    ),
  );
  assert.deepEqual(
    concurrent.map((result) => result.status).sort(),
    [201, 409],
  );
});

test("invalid monetary, image, stock, bounds and category inputs return 422", async () => {
  for (const price of [1, "0", "-1", "1.001", "1e3", "1000000.01", "NaN"])
    await call(
      "post",
      "/seller/products",
      seller.token,
      input({ variants: [{ sku: "SKU", label: "One", price, stock: 1 }] }),
    ).expect(422);
  for (const url of [
    "http://example.test/a.jpg",
    "https://user:pass@example.test/a.jpg",
    "javascript:alert(1)",
  ])
    await call(
      "post",
      "/seller/products",
      seller.token,
      input({ images: [{ url, alt: "A mug" }] }),
    ).expect(422);
  for (const stock of [-1, 1.5, "2", 1000001])
    await call(
      "post",
      "/seller/products",
      seller.token,
      input({ variants: [{ sku: "SKU", label: "One", price: "1", stock }] }),
    ).expect(422);
  for (const overrides of [
    { variants: [] },
    {
      variants: Array.from({ length: 21 }, (_, i) => ({
        sku: `SKU-${i}`,
        label: "One",
        price: "1",
        stock: 1,
      })),
    },
    { images: Array(6).fill({ url: "https://example.test/a", alt: "A" }) },
    { categoryId: "invalid" },
    { categoryId: new mongoose.Types.ObjectId().toString() },
  ])
    await call(
      "post",
      "/seller/products",
      seller.token,
      input(overrides),
    ).expect(422);
});

test("maximum valid catalog payload accepts twenty variants and five images", async () => {
  const product = await create({
    title: "T".repeat(120),
    description: "D".repeat(5000),
    images: Array.from({ length: 5 }, () => ({
      url: `https://example.test/${"a".repeat(1900)}`,
      alt: "A".repeat(120),
    })),
    variants: Array.from({ length: 20 }, (_, i) => ({
      sku: `SKU-${i}`,
      label: "L".repeat(80),
      price: "1000000.00",
      stock: 1000000,
    })),
  });
  assert.equal(product.variants.length, 20);
  assert.equal(product.images.length, 5);
});

test("submission requires an image and active category; archived products cannot change", async () => {
  const product = await create({ images: [] });
  await call("post", `/seller/products/${product.id}/submit`, seller.token, {
    version: 0,
  }).expect(422);
  const edited = await call(
    "patch",
    `/seller/products/${product.id}`,
    seller.token,
    { ...input(), version: 0 },
  ).expect(200);
  await call("patch", `/admin/categories/${category.id}`, admin.token, {
    name: "Ceramics",
    description: "",
    active: false,
    version: 0,
  }).expect(200);
  await call("post", `/seller/products/${product.id}/submit`, seller.token, {
    version: edited.body.data.product.version,
  }).expect(422);
  await call("post", `/seller/products/${product.id}/archive`, seller.token, {
    version: 1,
  }).expect(200);
  await call("patch", `/seller/products/${product.id}`, seller.token, {
    ...input(),
    version: 2,
  }).expect(409);
  await call("post", `/seller/products/${product.id}/submit`, seller.token, {
    version: 2,
  }).expect(409);
  await call("post", `/seller/products/${product.id}/archive`, seller.token, {
    version: 2,
  }).expect(409);
});

test("moderation records one atomic decision and rejects stale or invalid reviews", async () => {
  const product = await create();
  await call("post", `/admin/products/${product.id}/review`, admin.token, {
    version: 0,
    decision: "approved",
  }).expect(409);
  await call("post", `/seller/products/${product.id}/submit`, seller.token, {
    version: 0,
  }).expect(200);
  await call("post", `/admin/products/${product.id}/review`, seller.token, {
    version: 1,
    decision: "approved",
  }).expect(403);
  await call("post", `/admin/products/${product.id}/review`, admin.token, {
    version: 1,
    decision: "rejected",
    reason: "",
  }).expect(422);
  const results = await Promise.all(
    ["approved", "rejected"].map((decision) =>
      call("post", `/admin/products/${product.id}/review`, admin.token, {
        version: 1,
        decision,
        reason: "A detailed decision reason.",
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const stored = await mongoose.connection
    .collection("products")
    .findOne({ _id: new mongoose.Types.ObjectId(product.id) });
  assert.equal(stored.reviews.length, 1);
  assert.equal(String(stored.reviews[0].reviewedBy), admin.id);
  assert.equal(stored.version, 2);
  await call("post", "/admin/products/bad/review", admin.token, {
    version: 0,
    decision: "approved",
  }).expect(404);
});

test("a concurrent edit and approval cannot approve content that was not reviewed", async () => {
  const product = await create();
  await call("post", `/seller/products/${product.id}/submit`, seller.token, {
    version: 0,
  }).expect(200);
  const results = await Promise.all([
    call("patch", `/seller/products/${product.id}`, seller.token, {
      ...input({ title: "Changed after submission" }),
      version: 1,
    }),
    call("post", `/admin/products/${product.id}/review`, admin.token, {
      version: 1,
      decision: "approved",
    }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const current = (
    await call("get", `/seller/products/${product.id}`, seller.token).expect(
      200,
    )
  ).body.data.product;
  assert.equal(current.version, 2);
  if (current.status === "approved")
    assert.equal(current.title, "Handmade mug");
  else assert.equal(current.status, "draft");
});

test("approved visibility is removed by edit, archive, category disable and seller ineligibility", async () => {
  const product = await approve(await create());
  const publicProduct = (
    await call("get", `/catalog/products/${product.id}`).expect(200)
  ).body.data.product;
  for (const key of [
    "status",
    "version",
    "reviewNote",
    "reviews",
    "sellerId",
    "email",
    "phone",
  ])
    assert.equal(publicProduct[key], undefined);
  await mongoose.connection
    .collection("users")
    .updateOne(
      { _id: new mongoose.Types.ObjectId(seller.id) },
      { $set: { sellerStatus: "rejected" } },
    );
  await call("get", `/catalog/products/${product.id}`).expect(404);
  assert.equal(
    (await call("get", "/catalog/products").expect(200)).body.data.total,
    0,
  );
  await mongoose.connection
    .collection("users")
    .updateOne(
      { _id: new mongoose.Types.ObjectId(seller.id) },
      { $set: { sellerStatus: "approved", status: "suspended" } },
    );
  await call("get", `/catalog/products/${product.id}`).expect(404);
  await mongoose.connection
    .collection("users")
    .updateOne(
      { _id: new mongoose.Types.ObjectId(seller.id) },
      { $set: { status: "active" } },
    );
  await call("patch", `/admin/categories/${category.id}`, admin.token, {
    name: "Ceramics",
    description: "",
    active: false,
    version: 0,
  }).expect(200);
  await call("get", `/catalog/products/${product.id}`).expect(404);
  await call("patch", `/admin/categories/${category.id}`, admin.token, {
    name: "Ceramics",
    description: "",
    active: true,
    version: 1,
  }).expect(200);
  const edited = (
    await call("patch", `/seller/products/${product.id}`, seller.token, {
      ...input(),
      version: 2,
    }).expect(200)
  ).body.data.product;
  assert.equal(edited.status, "draft");
  await call("get", `/catalog/products/${product.id}`).expect(404);
  const approved = await approve(edited);
  await call("post", `/seller/products/${product.id}/archive`, seller.token, {
    version: approved.version,
  }).expect(200);
  await call("get", `/catalog/products/${product.id}`).expect(404);
});

test("filters match price and stock on one variant and price sort uses lowest variant", async () => {
  const cheap = await approve(
    await create({
      title: "Literal [mug]",
      variants: [
        { sku: "CHEAP", label: "Small", price: "10", stock: 0 },
        { sku: "EXPENSIVE", label: "Large", price: "100", stock: 4 },
      ],
    }),
  );
  const mid = await approve(
    await create({
      title: "Medium cup",
      variants: [{ sku: "MID", label: "Medium", price: "30", stock: 2 }],
    }),
  );
  await create({
    title: "Hidden draft",
    variants: [{ sku: "DRAFT", label: "One", price: "1", stock: 2 }],
  });
  const matched = (
    await call("get", "/catalog/products?inStock=true&maxPrice=40").expect(200)
  ).body.data;
  assert.deepEqual(
    matched.products.map((p) => p.id),
    [mid.id],
  );
  assert.equal(matched.total, 1);
  const page = (
    await call("get", "/catalog/products?sort=priceAsc&limit=1&page=1").expect(
      200,
    )
  ).body.data;
  assert.equal(page.products[0].id, cheap.id);
  assert.equal(page.total, 2);
  assert.equal(page.limit, 1);
  assert.equal(
    (await call("get", "/catalog/products?sort=priceDesc").expect(200)).body
      .data.products[0].id,
    mid.id,
  );
  assert.deepEqual(
    (
      await call("get", "/catalog/products?search=%5Bmug%5D").expect(200)
    ).body.data.products.map((p) => p.id),
    [cheap.id],
  );
  assert.equal(
    (
      await call(
        "get",
        `/catalog/products?categoryId=${new mongoose.Types.ObjectId()}`,
      ).expect(200)
    ).body.data.total,
    0,
  );
});

test("list queries validate strict bounds and private lists honor owner and status", async () => {
  await create();
  await create({}, other);
  assert.equal(
    (
      await call("get", "/seller/products?status=draft", seller.token).expect(
        200,
      )
    ).body.data.total,
    1,
  );
  assert.equal(
    (
      await call("get", "/seller/products?status=pending", seller.token).expect(
        200,
      )
    ).body.data.total,
    0,
  );
  assert.equal(
    (await call("get", "/admin/products?status=all", admin.token).expect(200))
      .body.data.total,
    2,
  );
  for (const query of [
    "page=0",
    "page=10001",
    "limit=49",
    "limit=1.5",
    "inStock=yes",
    "minPrice=10&maxPrice=1",
    "categoryId=bad",
    "sort=random",
    "search=" + "x".repeat(81),
    "page=1&page=2",
    "unknown=value",
  ])
    await call("get", `/catalog/products?${query}`).expect(422);
  for (const path of ["/seller/products", "/admin/products"])
    await call(
      "get",
      `${path}?status=bogus`,
      path.includes("admin") ? admin.token : seller.token,
    ).expect(422);
  await call("get", "/catalog/products/bad").expect(404);
});

test("concurrent edits preserve one version and SKU conflicts cannot partially update a product", async () => {
  const product = await create();
  await create({
    variants: [{ sku: "TAKEN", label: "Taken", price: "12", stock: 1 }],
  });
  await call("patch", `/seller/products/${product.id}`, seller.token, {
    ...input({
      title: "Must not persist",
      variants: [{ sku: "TAKEN", label: "One", price: "10", stock: 1 }],
    }),
    version: 0,
  }).expect(409);
  const unchanged = (
    await call("get", `/seller/products/${product.id}`, seller.token).expect(
      200,
    )
  ).body.data.product;
  assert.equal(unchanged.title, "Handmade mug");
  assert.equal(unchanged.version, 0);
  const results = await Promise.all(
    ["First replacement", "Second replacement"].map((title) =>
      call("patch", `/seller/products/${product.id}`, seller.token, {
        ...input({ title }),
        version: 0,
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const stored = (
    await call("get", `/seller/products/${product.id}`, seller.token).expect(
      200,
    )
  ).body.data.product;
  assert.equal(
    stored.title,
    results.find((result) => result.status === 200).body.data.product.title,
  );
  assert.equal(stored.version, 1);
  await call("post", `/seller/products/${product.id}/submit`, seller.token, {
    version: 0,
  }).expect(409);
  await call("post", `/seller/products/${product.id}/archive`, seller.token, {
    version: 0,
  }).expect(409);
});

test("rejection permits resubmission and review audit retains the last fifty decisions", async () => {
  let product = await create();
  for (let index = 0; index < 51; index++) {
    product = (
      await call(
        "post",
        `/seller/products/${product.id}/submit`,
        seller.token,
        { version: product.version },
      ).expect(200)
    ).body.data.product;
    product = (
      await call("post", `/admin/products/${product.id}/review`, admin.token, {
        version: product.version,
        decision: "rejected",
        reason: `Please improve the image ${index}.`,
      }).expect(200)
    ).body.data.product;
    assert.equal(product.status, "rejected");
  }
  assert.equal(product.reviewNote, "Please improve the image 50.");
  const stored = await mongoose.connection
    .collection("products")
    .findOne({ _id: new mongoose.Types.ObjectId(product.id) });
  assert.equal(stored.reviews.length, 50);
  assert.equal(stored.reviews[0].reason, "Please improve the image 1.");
  assert.equal(stored.reviews[49].reason, "Please improve the image 50.");
  assert.equal(stored.version, 102);
  assert.equal(
    (await call("get", "/catalog/products").expect(200)).body.data.total,
    0,
  );
});

test("shared validation places duplicate SKU and missing image descriptions on their fields", async () => {
  const variants = [
    { sku: "SAME", label: "One", price: "1", stock: 1 },
    { sku: "same", label: "Two", price: "2", stock: 1 },
  ];
  const duplicate = productInput.safeParse(input({ variants }));
  assert.equal(duplicate.success, false);
  assert.ok(
    duplicate.error.issues.some(
      (issue) => issue.path.join(".") === "variants.1.sku",
    ),
  );
  const response = await call(
    "post",
    "/seller/products",
    seller.token,
    input({ variants }),
  ).expect(409);
  assert.ok(
    response.body.errors.some((error) => error.field === "variants.1.sku"),
  );
  const invalid = productInput.safeParse(
    input({ images: [{ url: "https://example.test/a", alt: "" }] }),
  );
  assert.equal(invalid.success, false);
  assert.match(invalid.error.issues[0].message, /describe/i);
});
