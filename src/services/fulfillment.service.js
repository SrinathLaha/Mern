import mongoose from "mongoose";
import { Order } from "../models/order.model.js";
import { orderView } from "./orders.service.js";
import { Product } from "../models/product.model.js";
import { User } from "../models/user.model.js";
import { ApiError } from "../utils/errors.js";
import { fulfillmentsFor } from "./fulfillment-state.js";
import { fulfillmentStatuses } from "../../../shared/fulfillment.mjs";
const conflict = () =>
  new ApiError(
    409,
    "This fulfillment changed. Reload the order before continuing.",
  );
function sameTracking(left, right) {
  return (
    left?.carrier === right?.carrier &&
    left?.trackingNumber === right?.trackingNumber &&
    (left?.trackingUrl ?? null) === (right?.trackingUrl ?? null)
  );
}
export async function transitionFulfillment(sellerId, orderId, input) {
  return mongoose.connection.transaction(async (session) => {
    const order = await Order.findOne({
      _id: orderId,
      "groups.sellerId": String(sellerId),
    }).session(session);
    if (!order) throw new ApiError(404, "Order not found.");
    if (order.status !== "paid")
      throw new ApiError(
        409,
        "Only paid orders without a refund or review hold can be fulfilled.",
      );
    // Make approval an actual transactional dependency, including moderation racing
    // the HTTP authorization check. Seller profile writes conflict with this lock.
    const seller = await User.collection.updateOne(
      {
        _id: new mongoose.Types.ObjectId(sellerId),
        role: "seller",
        status: "active",
        sellerStatus: "approved",
      },
      { $inc: { fulfillmentRevision: 1 } },
      { session },
    );
    if (seller.matchedCount !== 1)
      throw new ApiError(
        403,
        "Your store must be active and approved to fulfill orders.",
      );
    const entries = fulfillmentsFor(order);
    const current = entries.find(
      (entry) => entry.sellerId === String(sellerId),
    );
    if (
      current.version === input.expectedVersion + 1 &&
      current.status === input.status &&
      (input.status !== "shipped" ||
        sameTracking(current.tracking, input.tracking))
    )
      return orderView(order.toObject(), sellerId);
    if (
      current.version !== input.expectedVersion ||
      fulfillmentStatuses[fulfillmentStatuses.indexOf(current.status) + 1] !==
        input.status
    )
      throw conflict();
    if (input.status === "shipped") {
      const group = order.groups.find(
        (group) => group.sellerId === String(sellerId),
      );
      for (const item of group.items) {
        const result = await Product.updateOne(
          {
            _id: item.productId,
            sellerId,
            variants: {
              $elemMatch: { sku: item.sku, committed: { $gte: item.quantity } },
            },
          },
          { $inc: { "variants.$.committed": -item.quantity, version: 1 } },
          { session },
        );
        if (result.matchedCount !== 1)
          throw new ApiError(
            409,
            "Committed inventory needs support review before this order can ship.",
          );
      }
      current.tracking = input.tracking;
    }
    current.status = input.status;
    current.version++;
    current.history.push({ status: input.status, at: new Date() });
    order.fulfillments = entries;
    // Refund creation writes this same order in its transaction, so refund and
    // the first processing transition cannot both commit from a paid snapshot.
    await order.save({ session });
    return orderView(order.toObject(), sellerId);
  });
}
