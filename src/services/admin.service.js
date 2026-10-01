import mongoose from "mongoose";
import { User, safeUser } from "../models/user.model.js";
import { ApiError } from "../utils/errors.js";
import { versionMatch } from "./sellers.service.js";
export async function listSellers({ status, page, limit }) {
  const filter = { role: "seller", status: "active", sellerStatus: status };
  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ createdAt: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit),
    User.countDocuments(filter),
  ]);
  return { sellers: users.map(safeUser), total, page, limit };
}
export async function reviewSeller(id, reviewerId, data) {
  if (!mongoose.isObjectIdOrHexString(id))
    throw new ApiError(404, "Seller application not found.");
  const now = new Date();
  const user = await User.findOneAndUpdate(
    {
      _id: id,
      role: "seller",
      status: "active",
      sellerStatus: "pending",
      ...versionMatch(data.version),
    },
    {
      $set: {
        sellerStatus: data.decision,
        sellerReviewNote: data.reason,
        sellerReviewedAt: now,
      },
      $inc: { sellerApplicationVersion: 1 },
      $push: {
        sellerReviews: {
          $each: [
            {
              decision: data.decision,
              reason: data.reason,
              reviewedBy: reviewerId,
              reviewedAt: now,
              applicationVersion: data.version,
            },
          ],
          $slice: -50,
        },
      },
    },
    { returnDocument: "after" },
  );
  if (!user)
    throw new ApiError(
      409,
      "This application is no longer pending or its details changed. Reload the list before reviewing it.",
    );
  return safeUser(user);
}
export async function promoteCustomer(email) {
  const user = await User.findOneAndUpdate(
    { email: email.trim().toLowerCase(), role: "customer", status: "active" },
    { $set: { role: "admin" }, $inc: { credentialVersion: 1 } },
    { returnDocument: "after" },
  );
  if (!user)
    throw new Error(
      "No active customer account matched. Register a dedicated customer account first.",
    );
  return safeUser(user);
}
