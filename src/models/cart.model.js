import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    version: { type: Number, default: 0, min: 0 },
    items: {
      type: [
        {
          _id: false,
          productId: { type: mongoose.Schema.Types.ObjectId, required: true },
          sku: { type: String, required: true },
          quantity: { type: Number, required: true, min: 1, max: 99 },
        },
      ],
      default: [],
      validate: (items) => items.length <= 50,
    },
  },
  { timestamps: true },
);
export const Cart = mongoose.model("Cart", schema);
