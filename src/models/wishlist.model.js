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
    productIds: {
      type: [mongoose.Schema.Types.ObjectId],
      default: [],
      validate: (ids) => ids.length <= 100,
    },
  },
  { timestamps: true },
);
export const Wishlist = mongoose.model("Wishlist", schema);
