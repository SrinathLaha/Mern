import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    phone: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    credentialVersion: { type: Number, default: 0 },
    passwordResetHash: { type: String, select: false },
    passwordResetExpiresAt: { type: Date, select: false },
    role: {
      type: String,
      enum: ["customer", "seller", "admin"],
      required: true,
    },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    storeName: String,
    storeDescription: String,
    sellerApplicationVersion: { type: Number, default: 0 },
    sellerReviewNote: String,
    sellerReviewedAt: Date,
    sellerReviews: {
      type: [
        {
          decision: String,
          reason: String,
          reviewedBy: mongoose.Schema.Types.ObjectId,
          reviewedAt: Date,
          applicationVersion: Number,
        },
      ],
      select: false,
      default: [],
    },
    sellerStatus: { type: String, enum: ["pending", "approved", "rejected"] },
  },
  { timestamps: true },
);

schema.index({ passwordResetHash: 1 }, { sparse: true });
export const User = mongoose.model("User", schema);
export function safeUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    storeName: user.storeName,
    sellerStatus: user.sellerStatus,
    ...(user.role === "seller"
      ? {
          storeDescription: user.storeDescription ?? "",
          sellerApplicationVersion: user.sellerApplicationVersion ?? 0,
          sellerReviewNote: user.sellerReviewNote ?? "",
          sellerReviewedAt: user.sellerReviewedAt,
        }
      : {}),
  };
}
