import { verifyAccess } from "../utils/tokens.js";
import { ApiError } from "../utils/errors.js";
import { Session } from "../models/session.model.js";
import { User } from "../models/user.model.js";

export async function authenticateAccessToken(token, config) {
  let payload;
  try {
    payload = verifyAccess(token, config.jwtSecret);
  } catch {
    throw new ApiError(401, "Please sign in again.");
  }
  const session = await Session.findOne({
    _id: payload.sid,
    userId: payload.sub,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  });
  if (!session) throw new ApiError(401, "Please sign in again.");
  const user = await User.findOne({ _id: session.userId, status: "active" });
  if (
    !user ||
    (session.credentialVersion ?? 0) !== (user.credentialVersion ?? 0)
  )
    throw new ApiError(401, "Please sign in again.");
  return user;
}

export const authenticate = (config) => async (req, _res, next) => {
  const token = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : "";
  req.user = await authenticateAccessToken(token, config);
  next();
};
export const requireRole = (role) => (req, _res, next) => {
  if (req.user.role !== role)
    throw new ApiError(403, "Your account does not have access to this area.");
  if (role === "seller" && req.user.sellerStatus !== "approved")
    throw new ApiError(
      403,
      "Your store must be approved before you can start selling.",
    );
  next();
};
