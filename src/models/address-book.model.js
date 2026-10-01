import mongoose from "mongoose";
const addressSchema = new mongoose.Schema(
  {
    label: String,
    recipient: String,
    phone: String,
    line1: String,
    line2: String,
    city: String,
    region: String,
    postalCode: String,
    country: String,
  },
  { _id: true },
);
const schema = new mongoose.Schema(
  {
    _id: mongoose.Schema.Types.ObjectId,
    version: { type: Number, default: 0 },
    addresses: { type: [addressSchema], default: [] },
    defaultAddressId: { type: String, default: null },
  },
  { timestamps: true },
);
export const AddressBook = mongoose.model("AddressBook", schema);
export function safeBook(book) {
  return {
    version: book?.version ?? 0,
    defaultAddressId: book?.defaultAddressId ?? null,
    addresses: (book?.addresses ?? []).map(
      ({
        _id,
        label,
        recipient,
        phone,
        line1,
        line2,
        city,
        region,
        postalCode,
        country,
      }) => ({
        id: String(_id),
        label,
        recipient,
        phone,
        line1,
        line2,
        city,
        region,
        postalCode,
        country,
      }),
    ),
  };
}
