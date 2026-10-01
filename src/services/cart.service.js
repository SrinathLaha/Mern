import { Cart } from "../models/cart.model.js";
import { ApiError } from "../utils/errors.js";
import {
  publicProducts,
  productSummary,
} from "./product-availability.service.js";

async function document(customerId) {
  return (
    (await Cart.findOne({ customerId }).lean()) ?? {
      customerId,
      version: 0,
      items: [],
    }
  );
}
async function ensureDocument(customerId) {
  try {
    await Cart.updateOne(
      { customerId },
      { $setOnInsert: { customerId, version: 0, items: [] } },
      { upsert: true },
    );
  } catch (error) {
    // Concurrent first writes race on the customer unique index; the winner owns the document.
    if (error.code !== 11000) throw error;
  }
}
async function view(cart) {
  const products = await publicProducts(
    cart.items.map((item) => item.productId),
  );
  const items = cart.items.map((item) => {
    const product = products.get(String(item.productId));
    const variant = product?.variants.find((entry) => entry.sku === item.sku);
    const stock = variant?.stock ?? 0;
    const issue = !product
      ? "This product is no longer available."
      : !variant
        ? "This variant is no longer available."
        : stock === 0
          ? "This variant is out of stock."
          : stock < item.quantity
            ? `Only ${stock} available. Reduce the quantity.`
            : null;
    return {
      ...productSummary(item.productId, product),
      sku: item.sku,
      quantity: item.quantity,
      variantLabel: variant?.label ?? "",
      unitPricePaise: variant?.pricePaise ?? null,
      lineTotalPaise: issue ? 0 : variant.pricePaise * item.quantity,
      stock,
      available: !issue,
      issue,
    };
  });
  return {
    version: cart.version,
    items,
    subtotalPaise: items.reduce((sum, item) => sum + item.lineTotalPaise, 0),
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    hasUnavailableItems: items.some((item) => !item.available),
  };
}
async function requirePurchasable(productId, sku, quantity) {
  const product = (await publicProducts([productId])).get(String(productId));
  if (!product) throw new ApiError(409, "This product is no longer available.");
  const variant = product.variants.find((entry) => entry.sku === sku);
  if (!variant) throw new ApiError(409, "This variant is no longer available.");
  if (variant.stock < quantity)
    throw new ApiError(
      409,
      `Only ${variant.stock} available. Choose a smaller quantity.`,
    );
}
const sameLine = (item, productId, sku) =>
  String(item.productId) === String(productId) && item.sku === sku;
const stale = () =>
  new ApiError(409, "Your cart changed. Reload it before continuing.");

export async function getCart(customerId) {
  return view(await document(customerId));
}
export async function addItem(customerId, { productId, sku, quantity }) {
  await ensureDocument(customerId);
  // The whole document CAS makes the quantity and line-count checks atomic with
  // respect to every other cart write. Re-read stock and quantity on every retry.
  for (let attempt = 0; attempt < 64; attempt++) {
    const cart = await document(customerId);
    const existing = cart.items.find((item) => sameLine(item, productId, sku));
    const nextQuantity = (existing?.quantity ?? 0) + quantity;
    if (nextQuantity > 99)
      throw new ApiError(409, "Choose at most 99 units per cart item.");
    if (!existing && cart.items.length >= 50)
      throw new ApiError(409, "Your cart can contain at most 50 items.");
    await requirePurchasable(productId, sku, nextQuantity);
    const items = existing
      ? cart.items.map((item) =>
          sameLine(item, productId, sku)
            ? { ...item, quantity: nextQuantity }
            : item,
        )
      : [...cart.items, { productId, sku, quantity }];
    const updated = await Cart.findOneAndUpdate(
      { customerId, version: cart.version },
      { $set: { items }, $inc: { version: 1 } },
      { returnDocument: "after", runValidators: true },
    ).lean();
    if (updated) return view(updated);
  }
  throw stale();
}
export async function updateItem(
  customerId,
  { productId, sku },
  { quantity, version },
) {
  const cart = await document(customerId);
  if (cart.version !== version) throw stale();
  if (!cart.items.some((item) => sameLine(item, productId, sku)))
    throw new ApiError(404, "Cart item not found.");
  await requirePurchasable(productId, sku, quantity);
  const items = cart.items.map((item) =>
    sameLine(item, productId, sku) ? { ...item, quantity } : item,
  );
  const updated = await Cart.findOneAndUpdate(
    { customerId, version },
    { $set: { items }, $inc: { version: 1 } },
    { returnDocument: "after", runValidators: true },
  ).lean();
  if (!updated) throw stale();
  return view(updated);
}
export async function removeItem(customerId, { productId, sku }, { version }) {
  const cart = await document(customerId);
  if (cart.version !== version) throw stale();
  const items = cart.items.filter((item) => !sameLine(item, productId, sku));
  if (items.length === cart.items.length) return view(cart);
  const updated = await Cart.findOneAndUpdate(
    { customerId, version },
    { $set: { items }, $inc: { version: 1 } },
    { returnDocument: "after", runValidators: true },
  ).lean();
  if (!updated) throw stale();
  return view(updated);
}
