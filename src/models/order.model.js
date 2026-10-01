import { fulfillmentSchema } from "./fulfillment.schema.js";
import mongoose from "mongoose";
import { snapshotFields } from "./checkout-quote.model.js";
const schema = new mongoose.Schema(
  {
    customerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    quoteId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      unique: true,
    },
    idempotencyKey: { type: String, required: true },
    status: {
      type: String,
      enum: [
        "awaiting_payment",
        "cancelled",
        "expired",
        "paid",
        "refund_pending",
        "refunded",
      ],
      default: "awaiting_payment",
    },
    fulfillments: { type: [fulfillmentSchema], default: [] },
    paymentRevision: { type: Number, default: 0 },
    reservationExpiresAt: { type: Date, required: true },
    ...snapshotFields,
  },
  { timestamps: true },
);
schema.index({ customerId: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ customerId: 1, createdAt: -1, _id: -1 });
schema.index({ "groups.sellerId": 1, createdAt: -1, _id: -1 });
schema.index({ status: 1, reservationExpiresAt: 1 });
export const Order = mongoose.model("Order", schema);
