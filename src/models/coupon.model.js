import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true },
    discountPaise: { type: Number, required: true },
    minSubtotalPaise: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    maxUses: { type: Number, required: true },
    usedCount: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const Coupon = mongoose.model("Coupon", schema);
