import mongoose from "mongoose";
import { fulfillmentStatuses } from "../../../shared/fulfillment.mjs";
const trackingSchema = new mongoose.Schema(
  {
    carrier: { type: String, required: true },
    trackingNumber: { type: String, required: true },
    trackingUrl: String,
  },
  { _id: false },
);
const historySchema = new mongoose.Schema(
  {
    status: { type: String, enum: fulfillmentStatuses, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);
export const fulfillmentSchema = new mongoose.Schema(
  {
    sellerId: { type: String, required: true },
    status: {
      type: String,
      enum: fulfillmentStatuses,
      default: "pending",
      required: true,
    },
    version: {
      type: Number,
      default: 0,
      min: 0,
      validate: Number.isSafeInteger,
    },
    tracking: { type: trackingSchema, default: null },
    history: { type: [historySchema], default: [] },
  },
  { _id: false },
);
