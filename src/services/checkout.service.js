import mongoose from "mongoose";
import { Cart } from "../models/cart.model.js";
import { AddressBook } from "../models/address-book.model.js";
import { Product } from "../models/product.model.js";
import { Category } from "../models/category.model.js";
import { User } from "../models/user.model.js";
import { usableCoupon } from "./coupons.service.js";
import { CheckoutQuote } from "../models/checkout-quote.model.js";
import { ApiError } from "../utils/errors.js";

export function snapshotView(data) {
  return {
    address: data.address,
    groups: data.groups,
    subtotalPaise: data.subtotalPaise,
    discountPaise: data.discountPaise,
    shippingPaise: data.shippingPaise,
    taxPaise: data.taxPaise,
    totalPaise: data.totalPaise,
    couponCode: data.couponCode,
  };
}
export async function buildSnapshot(
  customerId,
  addressId,
  couponCode,
  session,
  lockDependencies = false,
) {
  const book = await AddressBook.findById(customerId).session(session).lean();
  const saved = book?.addresses.find(
    (address) => String(address._id) === String(addressId),
  );
  if (!saved) throw new ApiError(404, "Choose one of your saved addresses.");
  const cart = await Cart.findOne({ customerId }).session(session).lean();
  if (!cart?.items.length)
    throw new ApiError(
      409,
      "Your cart is empty. Add items before checking out.",
    );
  const address = Object.fromEntries(
    [
      "recipient",
      "phone",
      "line1",
      "line2",
      "city",
      "region",
      "postalCode",
      "country",
    ].map((field) => [field, saved[field] ?? ""]),
  );
  const groups = [];
  const lockedCategories = new Set(),
    lockedSellers = new Set();
  let subtotalPaise = 0;
  for (const line of cart.items) {
    const product = await Product.findOne({
      _id: line.productId,
      status: "approved",
    })
      .session(session)
      .lean();
    const variant = product?.variants.find((v) => v.sku === line.sku);
    if (!variant || variant.stock < line.quantity)
      throw new ApiError(
        409,
        "A cart item is unavailable or has insufficient stock. Review your cart.",
      );
    const category = await Category.exists({
      _id: product.categoryId,
      active: true,
    }).session(session);
    const seller = await User.findOne({
      _id: product.sellerId,
      role: "seller",
      status: "active",
      sellerStatus: "approved",
    })
      .session(session)
      .lean();
    if (!category || !seller)
      throw new ApiError(
        409,
        "A cart item is no longer available. Review your cart.",
      );
    // A snapshot read alone does not conflict with concurrent moderation/profile writes.
    // Lock these dependencies during acceptance; a changed document retries the transaction.
    if (lockDependencies) {
      if (!lockedCategories.has(String(product.categoryId))) {
        const locked = await Category.collection.updateOne(
          { _id: product.categoryId, active: true },
          { $inc: { checkoutRevision: 1 } },
          { session },
        );
        if (locked.matchedCount !== 1)
          throw new ApiError(409, "This category changed. Review your cart.");
        lockedCategories.add(String(product.categoryId));
      }
      if (!lockedSellers.has(String(seller._id))) {
        const locked = await User.collection.updateOne(
          {
            _id: seller._id,
            role: "seller",
            status: "active",
            sellerStatus: "approved",
          },
          { $inc: { checkoutRevision: 1 } },
          { session },
        );
        if (locked.matchedCount !== 1)
          throw new ApiError(409, "This seller changed. Review your cart.");
        lockedSellers.add(String(seller._id));
      }
    }
    const lineTotalPaise = variant.pricePaise * line.quantity;
    if (!Number.isSafeInteger(lineTotalPaise) || lineTotalPaise < 0)
      throw new ApiError(
        409,
        "This product has an invalid price. Please contact support.",
      );
    let group = groups.find((g) => g.sellerId === String(seller._id));
    if (!group) {
      group = {
        sellerId: String(seller._id),
        storeName: seller.storeName ?? "",
        items: [],
      };
      groups.push(group);
    }
    group.items.push({
      productId: String(product._id),
      sku: line.sku,
      title: product.title,
      variantLabel: variant.label,
      quantity: line.quantity,
      unitPricePaise: variant.pricePaise,
      lineTotalPaise,
    });
    subtotalPaise += lineTotalPaise;
  }
  if (!Number.isSafeInteger(subtotalPaise))
    throw new ApiError(409, "Cart total is too large.");
  const coupon = await usableCoupon(couponCode, subtotalPaise, session);
  const discountPaise = coupon
    ? Math.min(coupon.discountPaise, subtotalPaise)
    : 0;
  // Development settings only; payments and provider/jurisdiction rules are later milestones.
  return {
    address,
    addressId,
    addressVersion: book.version,
    cartVersion: cart.version,
    groups,
    coupon,
    couponCode: coupon?.code ?? null,
    subtotalPaise,
    discountPaise,
    shippingPaise: 0,
    taxPaise: 0,
    totalPaise: subtotalPaise - discountPaise,
  };
}
export async function createQuote(customerId, input) {
  return mongoose.connection.transaction(async (session) => {
    const snapshot = await buildSnapshot(
      customerId,
      input.addressId,
      input.couponCode,
      session,
    );
    const [quote] = await CheckoutQuote.create(
      [
        {
          ...snapshot,
          customerId,
          expiresAt: new Date(Date.now() + 5 * 60000),
        },
      ],
      { session },
    );
    return {
      id: String(quote._id),
      expiresAt: quote.expiresAt,
      cartVersion: quote.cartVersion,
      ...snapshotView(quote.toObject()),
    };
  });
}
