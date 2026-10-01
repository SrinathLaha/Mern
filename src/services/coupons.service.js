import { Coupon } from "../models/coupon.model.js";
import { ApiError } from "../utils/errors.js";
export function couponView(c) {
  return {
    id: String(c._id),
    code: c.code,
    discountPaise: c.discountPaise,
    minSubtotalPaise: c.minSubtotalPaise,
    expiresAt: c.expiresAt,
    maxUses: c.maxUses,
    usedCount: c.usedCount,
    active: c.active,
    version: c.version,
  };
}
export async function createCoupon(data) {
  if (new Date(data.expiresAt) <= new Date())
    throw new ApiError(422, "Choose a future coupon expiry.");
  try {
    return couponView(await Coupon.create(data));
  } catch (error) {
    if (error.code === 11000)
      throw new ApiError(409, "This coupon code already exists.");
    throw error;
  }
}
export async function listCoupons() {
  return {
    coupons: (
      await Coupon.find().sort({ createdAt: -1, _id: -1 }).limit(100).lean()
    ).map(couponView),
  };
}
export async function disableCoupon(id, version) {
  const coupon = await Coupon.findOneAndUpdate(
    { _id: id, version },
    { $set: { active: false }, $inc: { version: 1 } },
    { returnDocument: "after" },
  );
  if (!coupon) {
    if (!(await Coupon.exists({ _id: id })))
      throw new ApiError(404, "Coupon not found.");
    throw new ApiError(409, "This coupon changed. Reload before disabling it.");
  }
  return couponView(coupon);
}
export async function usableCoupon(code, subtotal, session) {
  if (!code) return null;
  const coupon = await Coupon.findOne({ code }).session(session).lean();
  if (!coupon || !coupon.active)
    throw new ApiError(
      409,
      "This coupon is invalid or disabled. Remove it or choose another code.",
    );
  if (coupon.expiresAt <= new Date())
    throw new ApiError(
      409,
      "This coupon has expired. Remove it or choose another code.",
    );
  if (coupon.usedCount >= coupon.maxUses)
    throw new ApiError(
      409,
      "This coupon has reached its usage limit. Remove it or choose another code.",
    );
  if (subtotal < coupon.minSubtotalPaise)
    throw new ApiError(
      409,
      "Your subtotal does not meet this coupon's minimum spend.",
    );
  return {
    id: String(coupon._id),
    code: coupon.code,
    discountPaise: coupon.discountPaise,
    minSubtotalPaise: coupon.minSubtotalPaise,
    version: coupon.version,
  };
}
