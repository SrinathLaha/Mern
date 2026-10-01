import mongoose from "mongoose";
import { User, safeUser } from "../models/user.model.js";
import { AddressBook, safeBook } from "../models/address-book.model.js";
import { ApiError } from "../utils/errors.js";
const conflict = () =>
  new ApiError(
    409,
    "Your addresses changed in another request. Reload addresses and try again.",
  );
export async function updateProfile(userId, data) {
  const user = await User.findOneAndUpdate(
    { _id: userId, status: "active" },
    { $set: { name: data.name, phone: data.phone } },
    { returnDocument: "after" },
  );
  if (!user) throw new ApiError(401, "Please sign in again.");
  return safeUser(user);
}
export async function getAddresses(userId) {
  return safeBook(await AddressBook.findById(userId).lean());
}
export async function changeAddress(userId, action, id, data) {
  const book = await AddressBook.findById(userId).lean();
  const addresses = book?.addresses ?? [];
  const index = addresses.findIndex((item) => String(item._id) === id);
  if (action !== "create" && index === -1)
    throw new ApiError(404, "Address not found.");
  if (data.version !== (book?.version ?? 0)) throw conflict();
  let defaultAddressId = book?.defaultAddressId ?? null;
  const fields = { ...data };
  delete fields.version;
  if (action === "create") {
    if (addresses.length >= 10)
      throw new ApiError(
        409,
        "You can save up to 10 addresses. Remove one before adding another.",
      );
    const newId = new mongoose.Types.ObjectId();
    addresses.push({ ...fields, _id: newId });
    defaultAddressId ??= String(newId);
  } else if (action === "update")
    addresses[index] = { ...fields, _id: addresses[index]._id };
  else if (action === "default") defaultAddressId = id;
  else if (action === "delete") {
    addresses.splice(index, 1);
    if (defaultAddressId === id)
      defaultAddressId = addresses.length ? String(addresses[0]._id) : null;
  }
  try {
    const updated = await AddressBook.findOneAndUpdate(
      { _id: userId, version: data.version },
      { $set: { addresses, defaultAddressId }, $inc: { version: 1 } },
      { upsert: !book, returnDocument: "after" },
    );
    if (!updated) throw conflict();
    return safeBook(updated.toObject());
  } catch (error) {
    if (error.code === 11000) throw conflict();
    throw error;
  }
}
