import mongoose from "mongoose";

const schema = new mongoose.Schema(
  {
    _id: String,
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    refreshHash: { type: String, required: true },
    credentialVersion: { type: Number, default: 0 },
    usedHashes: { type: [String], default: [] },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const Session = mongoose.model("Session", schema);
