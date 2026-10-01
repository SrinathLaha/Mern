import { Wishlist } from "../models/wishlist.model.js";
import { ApiError } from "../utils/errors.js";
import {
  publicProducts,
  productSummary,
} from "./product-availability.service.js";

async function document(customerId) {
  return (
    (await Wishlist.findOne({ customerId }).lean()) ?? {
      customerId,
      version: 0,
      productIds: [],
    }
  );
}
async function view(wishlist) {
  const products = await publicProducts(wishlist.productIds);
  return {
    items: wishlist.productIds.map((id) => {
      const product = products.get(String(id));
      return {
        ...productSummary(id, product),
        available: Boolean(product),
        issue: product ? null : "This product is no longer available.",
      };
    }),
  };
}
export async function getWishlist(customerId) {
  return view(await document(customerId));
}
export async function addItem(customerId, productId) {
  try {
    await Wishlist.updateOne(
      { customerId },
      { $setOnInsert: { customerId, version: 0, productIds: [] } },
      { upsert: true },
    );
  } catch (error) {
    if (error.code !== 11000) throw error;
  }
  for (let attempt = 0; attempt < 64; attempt++) {
    const wishlist = await document(customerId);
    if (!(await publicProducts([productId])).has(productId))
      throw new ApiError(409, "This product is no longer available.");
    if (wishlist.productIds.some((id) => String(id) === productId))
      return view(wishlist);
    if (wishlist.productIds.length >= 100)
      throw new ApiError(
        409,
        "Your wishlist can contain at most 100 products.",
      );
    const updated = await Wishlist.findOneAndUpdate(
      { customerId, version: wishlist.version },
      {
        $set: { productIds: [...wishlist.productIds, productId] },
        $inc: { version: 1 },
      },
      { returnDocument: "after", runValidators: true },
    ).lean();
    if (updated) return view(updated);
  }
  throw new ApiError(409, "Your wishlist changed. Try again.");
}
export async function removeItem(customerId, productId) {
  // Atomic pull and version increment also invalidate pending CAS additions.
  const updated = await Wishlist.findOneAndUpdate(
    { customerId, productIds: productId },
    { $pull: { productIds: productId }, $inc: { version: 1 } },
    { returnDocument: "after" },
  ).lean();
  return view(updated ?? (await document(customerId)));
}
