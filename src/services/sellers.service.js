import { User, safeUser } from "../models/user.model.js";
import { ApiError } from "../utils/errors.js";
export const versionMatch = (version) => ({
  $expr: { $eq: [{ $ifNull: ["$sellerApplicationVersion", 0] }, version] },
});
export async function updateApplication(id, data) {
  const user = await User.findOneAndUpdate(
    {
      _id: id,
      role: "seller",
      status: "active",
      sellerStatus: { $in: ["pending", "rejected"] },
      ...versionMatch(data.version),
    },
    {
      $set: {
        storeName: data.storeName,
        storeDescription: data.storeDescription,
        sellerStatus: "pending",
      },
      $unset: { sellerReviewNote: "", sellerReviewedAt: "" },
      $inc: { sellerApplicationVersion: 1 },
    },
    { returnDocument: "after" },
  );
  if (!user)
    throw new ApiError(
      409,
      "This application has changed or is already approved. Refresh its status before trying again.",
    );
  return safeUser(user);
}
