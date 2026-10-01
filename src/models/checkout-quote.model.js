import mongoose from "mongoose";
// These are server-built, immutable snapshots; clients never write their fields.
export const snapshotFields = {
  address: { type: mongoose.Schema.Types.Mixed, required: true },
  groups: { type: [mongoose.Schema.Types.Mixed], required: true },
  subtotalPaise: Number,
  discountPaise: Number,
  shippingPaise: Number,
  taxPaise: Number,
  totalPaise: Number,
  couponCode: { type: String, default: null },
  coupon: { type: mongoose.Schema.Types.Mixed, default: null },
};
const schema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    expiresAt: { type: Date, required: true },
    cartVersion: Number,
    addressVersion: Number,
    addressId: mongoose.Schema.Types.ObjectId,
    ...snapshotFields,
  },
  { timestamps: true },
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const CheckoutQuote = mongoose.model("CheckoutQuote", schema);
