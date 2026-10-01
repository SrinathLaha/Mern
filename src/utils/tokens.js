import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export const newSecret = () => randomBytes(32).toString("hex");
const claims = { issuer: "marketplace-api", audience: "marketplace-web" };
export function accessToken(userId, sessionId, secret) {
  return jwt.sign({ sid: sessionId }, secret, {
    ...claims,
    subject: String(userId),
    expiresIn: "10m",
    algorithm: "HS256",
  });
}
export function verifyAccess(token, secret) {
  return jwt.verify(token, secret, { ...claims, algorithms: ["HS256"] });
}
export function parseRefresh(value) {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(value))
    return null;
  const [id, secret] = value.split(".");
  return { id, hash: digest(secret) };
}
