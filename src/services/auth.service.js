import { randomUUID } from "node:crypto";
import { User, safeUser } from "../models/user.model.js";
import { Session } from "../models/session.model.js";
import {
  hashPassword,
  verifyPassword,
  dummyHash,
} from "../utils/passwords.js";
import {
  digest,
  newSecret,
  accessToken,
  parseRefresh,
} from "../utils/tokens.js";
import { ApiError } from "../utils/errors.js";

const sessionDuration = 7 * 24 * 60 * 60 * 1000;
const unauthorized = () => new ApiError(401, "Please sign in again.");
function sessionResponse(user, session, secret, config) {
  return {
    user: safeUser(user),
    accessToken: accessToken(user._id, session._id, config.jwtSecret),
    refreshToken: `${session._id}.${secret}`,
    expiresAt: session.expiresAt,
  };
}
export async function register(data) {
  // Whitelist persisted fields. Never spread an untrusted body into a model.
  const user = await User.create({
    name: data.name,
    email: data.email,
    phone: data.phone,
    passwordHash: await hashPassword(data.password),
    role: data.accountType,
    ...(data.accountType === "seller"
      ? { storeName: data.storeName, sellerStatus: "pending" }
      : {}),
  });
  return safeUser(user);
}
export async function signIn(data, config) {
  const user = await User.findOne({ email: data.email }).select(
    "+passwordHash",
  );
  const valid = await verifyPassword(
    data.password,
    user?.passwordHash ?? dummyHash,
  );
  if (!user || !valid || user.status !== "active")
    throw new ApiError(401, "The email or password is incorrect.");
  const secret = newSecret();
  const session = await Session.create({
    _id: randomUUID(),
    userId: user._id,
    credentialVersion: user.credentialVersion ?? 0,
    refreshHash: digest(secret),
    expiresAt: new Date(Date.now() + sessionDuration),
  });
  return sessionResponse(user, session, secret, config);
}
export async function refresh(value, config) {
  const parsed = parseRefresh(value);
  if (!parsed) throw unauthorized();
  const secret = newSecret();
  const session = await Session.findOneAndUpdate(
    {
      _id: parsed.id,
      refreshHash: parsed.hash,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
      "usedHashes.2047": { $exists: false },
    },
    {
      $set: { refreshHash: digest(secret) },
      $push: { usedHashes: parsed.hash },
    },
    { returnDocument: "after" },
  );
  if (!session) {
    // Only a previously valid token proves reuse. A random guess cannot log someone out.
    await Session.updateOne(
      { _id: parsed.id, usedHashes: parsed.hash, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    throw unauthorized();
  }
  const user = await User.findOne({ _id: session.userId, status: "active" });
  if (
    !user ||
    (session.credentialVersion ?? 0) !== (user.credentialVersion ?? 0)
  ) {
    await Session.updateOne(
      { _id: session._id },
      { $set: { revokedAt: new Date() } },
    );
    throw unauthorized();
  }
  return sessionResponse(user, session, secret, config);
}
export async function signOut(value) {
  const parsed = parseRefresh(value);
  if (!parsed) return;
  await Session.updateOne(
    {
      _id: parsed.id,
      $or: [{ refreshHash: parsed.hash }, { usedHashes: parsed.hash }],
    },
    { $set: { revokedAt: new Date() } },
  );
}
