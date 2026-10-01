import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const options = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt, 64, options);
  return `scrypt$${salt}$${key.toString("hex")}`;
}
export async function verifyPassword(password, encoded) {
  const [, salt, stored] = encoded.split("$");
  const derived = await derive(password, salt, 64, options);
  const expected = Buffer.from(stored, "hex");
  return (
    expected.length === derived.length && timingSafeEqual(expected, derived)
  );
}
// Missing users still pay the same scrypt cost as existing users.
export const dummyHash = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;
