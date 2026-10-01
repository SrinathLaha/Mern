import mongoose from "mongoose";
const schema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    normalizedName: { type: String, required: true, unique: true },
    description: { type: String, default: "" },
    active: { type: Boolean, default: true },
    version: { type: Number, default: 0 },
  },
  { timestamps: true },
);
export const Category = mongoose.model("Category", schema);
