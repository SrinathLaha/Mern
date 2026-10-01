import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import {
  isProjectLocalDatabase,
  replaceMongoUri,
} from "../../scripts/local-database.mjs";
import {
  assertSourceEnvironment,
  copyIntoEmptyDatabase,
  databaseManifest,
} from "../../scripts/migrate-local-database.mjs";

test("only the explicit loopback replica endpoint starts a local server", () => {
  assert.equal(
    isProjectLocalDatabase(
      "mongodb://127.0.0.1:27018/marketplace_dev?replicaSet=marketplace-rs",
    ),
    true,
  );
  for (const uri of [
    "mongodb://127.0.0.1:27017/marketplace_dev",
    "mongodb://example.com:27018/db",
    "mongodb://127.0.0.1:27018.evil/db",
    "bad",
  ])
    assert.equal(isProjectLocalDatabase(uri), false);
});

test("migration rejects remote, authenticated, and unexpected source databases", () => {
  assert.doesNotThrow(() =>
    assertSourceEnvironment("mongodb://localhost:27017/marketplace_dev"),
  );
  for (const uri of [
    "mongodb://example.com:27017/marketplace_dev",
    "mongodb://localhost:27017/production",
    "mongodb://user:password@localhost:27017/marketplace_dev",
    "mongodb://localhost:27018/marketplace_dev",
    "mongodb://localhost:27017/marketplace_dev?replicaSet=other",
  ])
    assert.throws(() => assertSourceEnvironment(uri));
});

test("copy preserves BSON values, IDs, empty collections and indexes, and refuses a second copy", async () => {
  const client = await new mongoose.mongo.MongoClient(
    "mongodb://127.0.0.1:27018/?replicaSet=marketplace-rs",
    { serverSelectionTimeoutMS: 5000 },
  ).connect();
  const suffix = randomUUID().replaceAll("-", "");
  const source = client.db(`marketplace_copy_src_${suffix}`);
  const destination = client.db(`marketplace_copy_dst_${suffix}`);
  try {
    await source.createCollection("empty");
    await source.collection("documents").insertOne({
      _id: new mongoose.Types.ObjectId(),
      email: "copy@example.test",
      hash: "preserve-hash",
      expires: new Date("2099-01-01"),
      nested: { items: [1, "two", null] },
      long: mongoose.mongo.Long.fromString("9007199254740993"),
      decimal: mongoose.mongo.Decimal128.fromString("12.50"),
      binary: new mongoose.mongo.Binary(Buffer.from([0, 1, 255])),
    });
    await source
      .collection("documents")
      .createIndex({ email: 1 }, { unique: true });
    await source
      .collection("documents")
      .createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
    const original = await databaseManifest(source);
    assert.deepEqual(
      await copyIntoEmptyDatabase(source, destination),
      original,
    );
    assert.deepEqual(await databaseManifest(source), original);
    await assert.rejects(
      copyIntoEmptyDatabase(source, destination),
      /not empty/,
    );
    assert.deepEqual(await databaseManifest(destination), original);
  } finally {
    // Only names generated inside this test can reach cleanup, never marketplace_dev.
    try {
      for (const database of [source, destination]) {
        assert.match(
          database.databaseName,
          /^marketplace_copy_(src|dst)_[a-f0-9]{32}$/,
        );
        await database.dropDatabase();
      }
    } finally {
      await client.close();
    }
  }
});

test("switching databases preserves all other environment bytes and rejects ambiguity", () => {
  const before =
    '# Keep me\r\nPORT=4000\r\nMONGODB_URI="mongodb://127.0.0.1:27017/marketplace_dev"\r\nSECRET="unchanged"\r\n';
  assert.equal(
    replaceMongoUri(
      before,
      "mongodb://127.0.0.1:27018/marketplace_dev?replicaSet=marketplace-rs",
    ),
    '# Keep me\r\nPORT=4000\r\nMONGODB_URI="mongodb://127.0.0.1:27018/marketplace_dev?replicaSet=marketplace-rs"\r\nSECRET="unchanged"\r\n',
  );
  assert.throws(() => replaceMongoUri("PORT=4000\n", "x"));
  assert.throws(() => replaceMongoUri("MONGODB_URI=a\nMONGODB_URI=b\n", "x"));
});
