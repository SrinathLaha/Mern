import { before, after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../src/app.js";
import { promoteCustomer } from "../src/services/admin.service.js";

test("admin promotion requires an active customer and invalidates existing access and refresh", async () => {
  const login = await call("post", "/auth/login", null, {
    email: "customer@example.test",
    password: "Example passphrase!",
  }).expect(200);
  const promoted = await promoteCustomer(" CUSTOMER@example.test ");
  assert.equal(promoted.role, "admin");
  await call("get", "/auth/me", customer.token).expect(401);
  await request(app)
    .post("/api/auth/refresh")
    .set("Origin", config.frontendOrigin)
    .set("Cookie", login.headers["set-cookie"])
    .send({})
    .expect(401);
  await assert.rejects(
    promoteCustomer("seller@example.test"),
    /No active customer/,
  );
  await assert.rejects(
    promoteCustomer("missing@example.test"),
    /No active customer/,
  );
  const fresh = await call("post", "/auth/login", null, {
    email: "customer@example.test",
    password: "Example passphrase!",
  }).expect(200);
  await call("get", "/admin/sellers", fresh.body.data.accessToken).expect(200);
});

test("concurrent review decisions record exactly one outcome", async () => {
  const responses = await Promise.all(
    ["approved", "rejected"].map((decision) =>
      call("post", `/admin/sellers/${seller.id}/review`, admin.token, {
        version: 0,
        decision,
        reason: "A detailed review decision.",
      }),
    ),
  );
  assert.deepEqual(responses.map((result) => result.status).sort(), [200, 409]);
  const stored = await mongoose.connection
    .collection("users")
    .findOne({ _id: new mongoose.Types.ObjectId(seller.id) });
  assert.equal(stored.sellerReviews.length, 1);
  assert.equal(
    stored.sellerStatus,
    responses.find((result) => result.status === 200).body.data.user
      .sellerStatus,
  );
});

const databaseName = `marketplace_test_${randomUUID().replaceAll("-", "")}`;
const config = {
  nodeEnv: "test",
  frontendOrigin: "http://localhost:3000",
  jwtSecret: "test-only-secret-that-is-at-least-48-characters-long",
  authLimit: 1000,
};
let app, customer, other, seller, admin;
const call = (method, url, token, body) => {
  const client = request(app);
  const req = client[method](`/api${url}`).set("Origin", config.frontendOrigin);
  if (token) req.set("Authorization", `Bearer ${token}`);
  return body === undefined ? req : req.send(body);
};
async function account(email, role = "customer") {
  const registration = await call("post", "/auth/register", null, {
    name: "Asha Sharma",
    email,
    phone: "9876543210",
    password: "Example passphrase!",
    accountType: role === "admin" ? "customer" : role,
    ...(role === "seller" ? { storeName: "Asha Studio" } : {}),
  }).expect(201);
  if (role === "admin")
    await mongoose.connection
      .collection("users")
      .updateOne({ email }, { $set: { role: "admin" } });
  const login = await call("post", "/auth/login", null, {
    email,
    password: "Example passphrase!",
  }).expect(200);
  return {
    token: login.body.data.accessToken,
    id: registration.body.data.user.id,
  };
}
const address = {
  label: "Home",
  recipient: "Asha Sharma",
  phone: "9876543210",
  line1: "12 Market Road",
  line2: "",
  city: "Hyderabad",
  region: "Telangana",
  postalCode: "500001",
  country: "India",
};
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
  for (const collection of ["users", "sessions", "addressbooks"])
    await mongoose.connection.collection(collection).deleteMany({});
  customer = await account("customer@example.test");
  other = await account("other@example.test");
  seller = await account("seller@example.test", "seller");
  admin = await account("admin@example.test", "admin");
});
after(async () => {
  if (
    mongoose.connection.name === databaseName &&
    /^marketplace_test_[a-f0-9]{32}$/.test(databaseName)
  )
    await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
test("profile updates only the signed-in user and rejects privilege/email changes", async () => {
  const result = await call("patch", "/account/profile", customer.token, {
    name: "Asha Rao",
    phone: "+91 9876543210",
  }).expect(200);
  assert.equal(result.body.data.user.name, "Asha Rao");
  assert.equal(result.body.data.user.passwordHash, undefined);
  for (const field of ["role", "email", "sellerStatus", "passwordHash"])
    await call("patch", "/account/profile", customer.token, {
      name: "Asha Rao",
      phone: "9876543210",
      [field]: "admin",
    }).expect(422);
  const unchanged = await call("get", "/auth/me", other.token).expect(200);
  assert.equal(unchanged.body.data.user.name, "Asha Sharma");
  await call("patch", "/account/profile", null, {
    name: "Asha Rao",
    phone: "9876543210",
  }).expect(401);
});
test("address CRUD and default selection are owned, persistent and versioned", async () => {
  const first = await call("post", "/account/addresses", customer.token, {
    ...address,
    version: 0,
  }).expect(201);
  const a = first.body.data.book.addresses[0].id;
  assert.equal(first.body.data.book.defaultAddressId, a);
  const second = await call("post", "/account/addresses", customer.token, {
    ...address,
    label: "Office",
    version: 1,
  }).expect(201);
  const b = second.body.data.book.addresses[1].id;
  await call("patch", `/account/addresses/${a}`, other.token, {
    ...address,
    version: 0,
  }).expect(404);
  await call("delete", `/account/addresses/${a}`, other.token, {
    version: 0,
  }).expect(404);
  await call("patch", `/account/addresses/${a}/default`, other.token, {
    version: 0,
  }).expect(404);
  const empty = await call("get", "/account/addresses", other.token).expect(
    200,
  );
  assert.equal(empty.body.data.book.addresses.length, 0);
  await call("patch", `/account/addresses/${b}/default`, customer.token, {
    version: 2,
  }).expect(200);
  await call("patch", `/account/addresses/${a}`, customer.token, {
    ...address,
    city: "Pune",
    version: 3,
  }).expect(200);
  const removed = await call(
    "delete",
    `/account/addresses/${b}`,
    customer.token,
    { version: 4 },
  ).expect(200);
  assert.equal(removed.body.data.book.defaultAddressId, a);
  assert.equal(removed.body.data.book.addresses[0].city, "Pune");
  const last = await call("delete", `/account/addresses/${a}`, customer.token, {
    version: 5,
  }).expect(200);
  assert.equal(last.body.data.book.defaultAddressId, null);
});
test("concurrent address writes cannot overwrite each other and limit remains ten", async () => {
  const results = await Promise.all([
    call("post", "/account/addresses", customer.token, {
      ...address,
      version: 0,
    }),
    call("post", "/account/addresses", customer.token, {
      ...address,
      version: 0,
    }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  for (let version = 1; version < 10; version++)
    await call("post", "/account/addresses", customer.token, {
      ...address,
      version,
    }).expect(201);
  await call("post", "/account/addresses", customer.token, {
    ...address,
    version: 10,
  }).expect(409);
  await call("post", "/account/addresses", customer.token, {
    ...address,
    postalCode: "wrong",
    version: 10,
  }).expect(422);
  await call("patch", "/account/addresses/not-an-id", customer.token, {
    ...address,
    version: 10,
  }).expect(404);
});
test("only admins review current pending applications; approval unlocks seller access immediately", async () => {
  await call("get", "/admin/sellers", customer.token).expect(403);
  await call("get", "/admin/sellers", seller.token).expect(403);
  const list = await call(
    "get",
    "/admin/sellers?status=pending&page=1",
    admin.token,
  ).expect(200);
  assert.equal(list.body.data.total, 1);
  assert.equal(list.body.data.sellers[0].passwordHash, undefined);
  await call("get", "/seller/access", seller.token).expect(403);
  await call("post", `/admin/sellers/${seller.id}/review`, customer.token, {
    version: 0,
    decision: "approved",
    reason: "",
  }).expect(403);
  await call("post", `/admin/sellers/${seller.id}/review`, admin.token, {
    version: 0,
    decision: "approved",
    reason: "",
  }).expect(200);
  await call("get", "/seller/access", seller.token).expect(200);
  await call("post", `/admin/sellers/${seller.id}/review`, admin.token, {
    version: 0,
    decision: "rejected",
    reason: "Late decision",
  }).expect(409);
  const user = await mongoose.connection
    .collection("users")
    .findOne({ _id: new mongoose.Types.ObjectId(seller.id) });
  assert.equal(String(user.sellerReviews[0].reviewedBy), admin.id);
});
test("rejected sellers see the reason and resubmit; changed applications reject stale decisions", async () => {
  await call("post", `/admin/sellers/${seller.id}/review`, admin.token, {
    version: 0,
    decision: "rejected",
    reason: "",
  }).expect(422);
  await call("post", `/admin/sellers/${seller.id}/review`, admin.token, {
    version: 0,
    decision: "rejected",
    reason: "Please describe your products.",
  }).expect(200);
  const current = await call("get", "/seller/application", seller.token).expect(
    200,
  );
  assert.equal(
    current.body.data.user.sellerReviewNote,
    "Please describe your products.",
  );
  await call("get", "/seller/access", seller.token).expect(403);
  await call("patch", "/seller/application", seller.token, {
    version: 1,
    storeName: "Asha Studio",
    storeDescription: "Handmade ceramics and home accessories.",
  }).expect(200);
  await call("post", `/admin/sellers/${seller.id}/review`, admin.token, {
    version: 1,
    decision: "approved",
    reason: "",
  }).expect(409);
  await call("post", `/admin/sellers/${seller.id}/review`, admin.token, {
    version: 2,
    decision: "approved",
    reason: "",
  }).expect(200);
  await call("patch", "/seller/application", seller.token, {
    version: 3,
    storeName: "Changed",
    storeDescription: "Changed after approval",
  }).expect(409);
  await call("get", "/seller/application", customer.token).expect(403);
  await call("get", "/admin/sellers?page=-1", admin.token).expect(422);
});
