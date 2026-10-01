import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
    },
    customerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    status: {
      type: String,
      enum: [
        "creating",
        "open",
        "paid",
        "expired",
        "refund_pending",
        "refunded",
        "review",
      ],
      default: "creating",
    },
    amountPaise: { type: Number, required: true },
    currency: { type: String, default: "INR" },
    creationKey: { type: String, required: true, unique: true },
    creationParams: { type: mongoose.Schema.Types.Mixed, required: true },
    sessionId: { type: String },
    paymentIntentId: { type: String },
    checkoutUrl: String,
    refundKey: String,
    refundRequestedAt: Date,
    refundId: String,
    refundStatus: {
      type: String,
      enum: ["none", "pending", "succeeded", "failed"],
      default: "none",
    },
    outsideRefundNotified: { type: Boolean, default: false },
    automaticRefund: { type: Boolean, default: false },
    message: String,
    nextCheckAt: { type: Date, default: Date.now },
    failures: { type: Number, default: 0 },
    leaseToken: String,
    leaseUntil: Date,
  },
  { timestamps: true },
);
schema.index({ sessionId: 1 }, { unique: true, sparse: true });
schema.index({ refundId: 1 }, { unique: true, sparse: true });
schema.index({ nextCheckAt: 1, leaseUntil: 1 });
export const Payment = mongoose.model("Payment", schema);
