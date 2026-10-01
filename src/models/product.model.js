import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    sellerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    categoryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    title: { type: String, required: true },
    description: { type: String, required: true },
    images: [{ _id: false, url: String, alt: String }],
    variants: [
      {
        _id: false,
        sku: String,
        label: String,
        pricePaise: Number,
        stock: Number,
        committed: { type: Number, default: 0, min: 0 },
        reserved: { type: Number, default: 0, min: 0 },
      },
    ],
    status: {
      type: String,
      enum: ["draft", "pending", "approved", "rejected", "archived"],
      default: "draft",
    },
    version: { type: Number, default: 0 },
    reviewNote: { type: String, default: "" },
    reviews: {
      type: [
        {
          _id: false,
          decision: String,
          reason: String,
          reviewedBy: mongoose.Schema.Types.ObjectId,
          reviewedAt: Date,
          productVersion: Number,
        },
      ],
      default: [],
      select: false,
    },
  },
  { timestamps: true },
);
// A multikey unique index protects SKU ownership across concurrent product writes.
// Duplicate entries inside one product are checked separately by the service.
schema.index({ sellerId: 1, "variants.sku": 1 }, { unique: true });
schema.index({ status: 1, createdAt: -1, _id: -1 });
schema.index({ sellerId: 1, status: 1, createdAt: -1 });
export const Product = mongoose.model("Product", schema);
