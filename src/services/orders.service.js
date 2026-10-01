import {
  fulfillmentsFor,
  canRefundOrder,
} from "./fulfillment-state.js";
import mongoose from "mongoose";
import { Order } from "../models/order.model.js";
import { CheckoutQuote } from "../models/checkout-quote.model.js";
import {
  buildSnapshot,
  snapshotView,
} from "./checkout.service.js";
import { Product } from "../models/product.model.js";
import { Cart } from "../models/cart.model.js";
import { AddressBook } from "../models/address-book.model.js";
import { Coupon } from "../models/coupon.model.js";
import { ApiError } from "../utils/errors.js";

const changed = () =>
  new ApiError(
    409,
    "Checkout details changed. Review your cart and request a new quote.",
  );
export function orderView(order, sellerId) {
  const base = {
    id: String(order._id),
    status: order.status,
    createdAt: order.createdAt,
    reservationExpiresAt: order.reservationExpiresAt,
    fulfillments: fulfillmentsFor(order).filter(
      (entry) => !sellerId || entry.sellerId === String(sellerId),
    ),
  };
  if (!sellerId)
    return {
      ...base,
      ...snapshotView(order),
      canRefund: canRefundOrder(order),
    };
  const groups = order.groups.filter(
    (group) => group.sellerId === String(sellerId),
  );
  return {
    ...base,
    address: order.address,
    groups,
    subtotalPaise: groups.reduce(
      (total, group) =>
        total + group.items.reduce((sum, item) => sum + item.lineTotalPaise, 0),
      0,
    ),
  };
}
async function replay(customerId, quoteId, idempotencyKey, session) {
  const keyed = await Order.findOne({ customerId, idempotencyKey })
    .session(session)
    .lean();
  if (keyed) {
    if (String(keyed.quoteId) !== quoteId)
      throw new ApiError(
        409,
        "This retry key belongs to another checkout. Start a new checkout request.",
      );
    return keyed;
  }
  return Order.findOne({ customerId, quoteId }).session(session).lean();
}
export async function createOrder(customerId, { quoteId, idempotencyKey }) {
  try {
    return await mongoose.connection.transaction(async (session) => {
      const existing = await replay(
        customerId,
        quoteId,
        idempotencyKey,
        session,
      );
      if (existing) return { order: orderView(existing), created: false };
      const quote = await CheckoutQuote.findOne({ _id: quoteId, customerId })
        .session(session)
        .lean();
      if (!quote)
        throw new ApiError(
          409,
          "This quote is unavailable. Review checkout again.",
        );
      if (quote.expiresAt <= new Date())
        throw new ApiError(409, "This quote expired. Review checkout again.");
      const fresh = await buildSnapshot(
        customerId,
        quote.addressId,
        quote.couponCode,
        session,
        true,
      );
      if (
        fresh.cartVersion !== quote.cartVersion ||
        fresh.addressVersion !== quote.addressVersion ||
        JSON.stringify(snapshotView(fresh)) !==
          JSON.stringify(snapshotView(quote)) ||
        JSON.stringify(fresh.coupon) !== JSON.stringify(quote.coupon)
      )
        throw changed();
      // Take a write lock so an address edit cannot race quote acceptance.
      const addressLock = await AddressBook.collection.updateOne(
        { _id: customerId, version: quote.addressVersion },
        { $inc: { checkoutRevision: 1 } },
        { session },
      );
      if (addressLock.matchedCount !== 1) throw changed();
      for (const group of quote.groups)
        for (const item of group.items) {
          const result = await Product.updateOne(
            {
              _id: item.productId,
              status: "approved",
              variants: {
                $elemMatch: {
                  sku: item.sku,
                  pricePaise: item.unitPricePaise,
                  stock: { $gte: item.quantity },
                },
              },
            },
            {
              $inc: {
                "variants.$.stock": -item.quantity,
                "variants.$.reserved": item.quantity,
                version: 1,
              },
            },
            { session },
          );
          if (result.matchedCount !== 1) throw changed();
        }
      if (quote.coupon) {
        const coupon = await Coupon.updateOne(
          {
            _id: quote.coupon.id,
            version: quote.coupon.version,
            active: true,
            expiresAt: { $gt: new Date() },
            $expr: { $lt: ["$usedCount", "$maxUses"] },
          },
          { $inc: { usedCount: 1 } },
          { session },
        );
        if (coupon.matchedCount !== 1)
          throw new ApiError(
            409,
            "This coupon is no longer available. Review checkout again.",
          );
      }
      const consumed = await Cart.updateOne(
        { customerId, version: quote.cartVersion },
        { $set: { items: [] }, $inc: { version: 1 } },
        { session },
      );
      if (consumed.matchedCount !== 1) throw changed();
      const [order] = await Order.create(
        [
          {
            ...snapshotView(quote),
            coupon: quote.coupon,
            fulfillments: fulfillmentsFor({
              groups: quote.groups,
              createdAt: new Date(),
            }),
            customerId,
            quoteId,
            idempotencyKey,
            reservationExpiresAt: new Date(Date.now() + 15 * 60000),
          },
        ],
        { session },
      );
      return { order: orderView(order.toObject()), created: true };
    });
  } catch (error) {
    // A competing request may commit either unique key between our snapshot and insert.
    if (error.code === 11000) {
      const existing = await replay(customerId, quoteId, idempotencyKey, null);
      if (existing) return { order: orderView(existing), created: false };
    }
    throw error;
  }
}
async function releaseOrder(id, { customerId, expireOnly = false } = {}) {
  return mongoose.connection.transaction(async (session) => {
    const order = await Order.findOne({
      _id: id,
      ...(customerId ? { customerId } : {}),
    })
      .session(session)
      .lean();
    if (!order) throw new ApiError(404, "Order not found.");
    if (order.status !== "awaiting_payment") {
      if (
        customerId &&
        ["paid", "refund_pending", "refunded"].includes(order.status)
      )
        throw new ApiError(409, "Paid orders must use the full refund action.");
      return order;
    }
    const expired = order.reservationExpiresAt <= new Date();
    if (expireOnly && !expired) return order;
    const status = expired ? "expired" : "cancelled";
    const transitioned = await Order.updateOne(
      { _id: order._id, status: "awaiting_payment" },
      { $set: { status } },
      { session },
    );
    if (transitioned.modifiedCount !== 1) throw changed();
    for (const group of order.groups)
      for (const item of group.items) {
        const released = await Product.updateOne(
          {
            _id: item.productId,
            variants: {
              $elemMatch: { sku: item.sku, reserved: { $gte: item.quantity } },
            },
          },
          {
            $inc: {
              "variants.$.stock": item.quantity,
              "variants.$.reserved": -item.quantity,
              version: 1,
            },
          },
          { session },
        );
        if (released.matchedCount !== 1)
          throw new ApiError(
            409,
            "The reservation needs support review before it can be released.",
          );
      }
    if (order.coupon) {
      const released = await Coupon.updateOne(
        { _id: order.coupon.id, usedCount: { $gte: 1 } },
        { $inc: { usedCount: -1 } },
        { session },
      );
      if (released.matchedCount !== 1)
        throw new ApiError(409, "The coupon reservation needs support review.");
    }
    return { ...order, status };
  });
}
export async function expireOrders({ customerId, orderId, limit = 100 } = {}) {
  const expired = await Order.find({
    status: "awaiting_payment",
    reservationExpiresAt: { $lte: new Date() },
    ...(customerId ? { customerId } : {}),
    ...(orderId ? { _id: orderId } : {}),
  })
    .sort({ reservationExpiresAt: 1 })
    .limit(limit)
    .select("_id")
    .lean();
  for (const order of expired)
    await releaseOrder(order._id, { expireOnly: true });
  return expired.length;
}
export async function cancelOrder(customerId, id) {
  return orderView(await releaseOrder(id, { customerId }));
}
const ownership = (userId, seller) =>
  seller ? { "groups.sellerId": String(userId) } : { customerId: userId };
export async function getOrder(userId, id, seller = false) {
  const filter = { _id: id, ...ownership(userId, seller) };
  if (!(await Order.exists(filter)))
    throw new ApiError(404, "Order not found.");
  await expireOrders({ orderId: id, limit: 1 });
  const order = await Order.findOne(filter).lean();
  return orderView(order, seller ? userId : null);
}
export async function listOrders(userId, { page }, seller = false) {
  if (!seller) await expireOrders({ customerId: userId, limit: 20 });
  const filter = ownership(userId, seller),
    limit = 20;
  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Order.countDocuments(filter),
  ]);
  return {
    orders: orders.map((order) => orderView(order, seller ? userId : null)),
    page,
    total,
    limit,
  };
}
