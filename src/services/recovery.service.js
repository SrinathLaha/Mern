import { User } from "../models/user.model.js";
import { newSecret, digest } from "../utils/tokens.js";
import { hashPassword } from "../utils/passwords.js";
import { ApiError } from "../utils/errors.js";

const invalidLink = () =>
  new ApiError(
    400,
    "This reset link is invalid or has expired. Please request a new one.",
  );
export async function requestPasswordReset(email, config, mailer) {
  const user = await User.findOne({ email, status: "active" });
  if (!user) return;
  const token = newSecret();
  const hash = digest(token);
  // Match legacy version zero as well as explicit zero; a concurrent reset invalidates this issuance.
  const version = user.credentialVersion ?? 0;
  const issued = await User.updateOne(
    {
      _id: user._id,
      status: "active",
      $expr: { $eq: [{ $ifNull: ["$credentialVersion", 0] }, version] },
    },
    {
      $set: {
        passwordResetHash: hash,
        passwordResetExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    },
  );
  if (!issued.modifiedCount) return;
  const url = new URL("/reset-password", config.frontendOrigin);
  url.hash = `token=${token}`;
  try {
    await mailer.sendPasswordReset({ to: user.email, url: url.toString() });
  } catch {
    // Failed delivery must not invalidate a newer successful request.
    await User.updateOne(
      { _id: user._id, passwordResetHash: hash },
      { $unset: { passwordResetHash: "", passwordResetExpiresAt: "" } },
    );
    throw new Error("Password recovery delivery failed.");
  }
}

export async function resetPassword({ token, password }) {
  const match = {
    passwordResetHash: digest(token),
    passwordResetExpiresAt: { $gt: new Date() },
    status: "active",
  };
  if (!(await User.exists(match))) throw invalidLink();
  const passwordHash = await hashPassword(password);
  // One MongoDB document atomically changes credentials, consumes the token, and revokes sessions.
  const user = await User.findOneAndUpdate(
    { ...match, passwordResetExpiresAt: { $gt: new Date() } },
    {
      $set: { passwordHash },
      $unset: { passwordResetHash: "", passwordResetExpiresAt: "" },
      $inc: { credentialVersion: 1 },
    },
  );
  if (!user) throw invalidLink();
}
