import { canRefundOrder } from "./fulfillment-state.js";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { Payment } from "../models/payment.model.js";
import { Order } from "../models/order.model.js";
import { expireOrders } from "./orders.service.js";
import { Product } from "../models/product.model.js";
import { Coupon } from "../models/coupon.model.js";
import { ApiError } from "../utils/errors.js";

const RETENTION_MS = 23 * 3600000;
const pendingMessage =
  "Payment confirmation is pending. Refresh shortly; do not create another order to retry payment.";
const reviewMessage =
  "This payment needs support review. Please do not pay again.";
const unavailable = () => {
  const error = new ApiError(
    503,
    "Payments are unavailable. Configure Stripe test credentials and the webhook secret to enable checkout.",
  );
  error.code = "PAYMENTS_DISABLED";
  return error;
};
class BindingError extends Error {}
const providerId = (value) => (typeof value === "string" ? value : value?.id);
export function paymentView(payment) {
  if (!payment) return null;
  return {
    id: String(payment._id),
    orderId: String(payment.orderId),
    status: payment.status,
    amountPaise: payment.amountPaise,
    currency: "INR",
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    refundStatus: payment.refundStatus,
    ...(payment.message ? { message: payment.message } : {}),
  };
}
function validSession(payment, s) {
  if (
    !s ||
    typeof s.id !== "string" ||
    !s.id.startsWith("cs_") ||
    (payment.sessionId && payment.sessionId !== s.id) ||
    s.livemode !== false ||
    s.mode !== "payment" ||
    s.amount_total !== payment.amountPaise ||
    s.currency !== "inr" ||
    s.metadata?.attemptId !== String(payment._id) ||
    s.metadata?.orderId !== String(payment.orderId) ||
    s.client_reference_id !== String(payment.orderId)
  )
    throw new BindingError();
  if (s.payment_status === "paid") {
    if (s.status !== "complete") throw new BindingError();
    validIntent(payment, s.payment_intent);
  }
}
function validIntent(payment, pi) {
  if (
    !pi ||
    typeof pi.id !== "string" ||
    !pi.id.startsWith("pi_") ||
    pi.status !== "succeeded" ||
    pi.livemode !== false ||
    pi.amount !== payment.amountPaise ||
    pi.amount_received !== payment.amountPaise ||
    pi.currency !== "inr" ||
    pi.metadata?.attemptId !== String(payment._id) ||
    pi.metadata?.orderId !== String(payment.orderId) ||
    (payment.paymentIntentId && payment.paymentIntentId !== pi.id)
  )
    throw new BindingError();
}

function hasOutsideRefund(payment, checkout) {
  const charge = checkout.payment_intent?.latest_charge;
  if (!charge || typeof charge !== "object") return false;
  if (
    !Number.isSafeInteger(charge.amount_refunded) ||
    charge.amount_refunded < 0
  )
    throw new BindingError();
  if (charge.amount_refunded === 0) return false;
  if (
    typeof charge.id !== "string" ||
    !charge.id.startsWith("ch_") ||
    charge.livemode !== false ||
    charge.paid !== true ||
    charge.captured !== true ||
    providerId(charge.payment_intent) !== checkout.payment_intent.id ||
    charge.amount !== payment.amountPaise ||
    charge.amount_captured !== payment.amountPaise ||
    charge.currency !== "inr" ||
    charge.amount_refunded > payment.amountPaise
  )
    throw new BindingError();
  return true;
}
function holdOutsideRefund(payment) {
  payment.status = "review";
  payment.refundStatus = "pending";
  payment.nextCheckAt = null;
  payment.message =
    "A refund made outside this checkout needs support review. Your order is on hold.";
}
function validRefund(payment, r) {
  if (
    !r ||
    typeof r.id !== "string" ||
    !r.id.startsWith("re_") ||
    (payment.refundId && payment.refundId !== r.id) ||
    r.livemode === true ||
    r.amount !== payment.amountPaise ||
    r.currency !== "inr" ||
    providerId(r.payment_intent) !== payment.paymentIntentId ||
    !["pending", "requires_action", "succeeded", "failed", "canceled"].includes(
      r.status,
    )
  )
    throw new BindingError();
}
function checkoutUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://checkout.stripe.com" &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
async function moveInventory(order, from, session) {
  for (const group of order.groups)
    for (const item of group.items) {
      const inc =
        from === "reserved"
          ? {
              "variants.$.reserved": -item.quantity,
              "variants.$.committed": item.quantity,
              version: 1,
            }
          : {
              "variants.$.committed": -item.quantity,
              "variants.$.stock": item.quantity,
              version: 1,
            };
      const result = await Product.updateOne(
        {
          _id: item.productId,
          variants: {
            $elemMatch: { sku: item.sku, [from]: { $gte: item.quantity } },
          },
        },
        { $inc: inc },
        { session },
      );
      if (result.matchedCount !== 1) throw new Error("INVENTORY_REVIEW");
    }
  if (from === "committed" && order.coupon) {
    const result = await Coupon.updateOne(
      { _id: order.coupon.id, usedCount: { $gte: 1 } },
      { $inc: { usedCount: -1 } },
      { session },
    );
    if (result.matchedCount !== 1) throw new Error("COUPON_REVIEW");
  }
}
function setRefundIntent(payment, automatic = false) {
  if (payment.refundKey) return;
  payment.refundKey = `refund-${payment._id}`;
  payment.refundRequestedAt = new Date();
  payment.refundStatus = "pending";
  payment.status = "refund_pending";
  payment.automaticRefund = automatic;
  payment.nextCheckAt = new Date();
  payment.message = "Your full refund is pending confirmation.";
}
export function createPaymentService(config, provider) {
  async function owned(customerId, orderId) {
    let order = await Order.findOne({ _id: orderId, customerId }).lean();
    if (!order) throw new ApiError(404, "Order not found.");
    await expireOrders({ orderId, limit: 1 });
    order = await Order.findOne({ _id: orderId, customerId }).lean();
    return order;
  }
  async function get(customerId, orderId) {
    await owned(customerId, orderId);
    return {
      payment: paymentView(await Payment.findOne({ orderId }).lean()),
      enabled: Boolean(provider),
    };
  }
  // The lease reduces overlapping external calls; the token fences all commits if a
  // process stalls past its lease. Provider idempotency protects expired leases too.
  async function transaction(paymentId, token, work) {
    return mongoose.connection.transaction(async (session) => {
      const payment = await Payment.findOne({
        _id: paymentId,
        leaseToken: token,
      }).session(session);
      if (!payment) return null;
      const order = await Order.findById(payment.orderId).session(session);
      if (!order) throw new Error("ORDER_REVIEW");
      await work(payment, order, session);
      await payment.save({ session });
      return payment.toObject();
    });
  }
  async function finishRefund(paymentId, token, external) {
    return transaction(paymentId, token, async (p, order, session) => {
      if (p.refundStatus === "succeeded") return;
      if (external) {
        validRefund(p, external);
        p.refundId = external.id;
      }
      const status = external?.status ?? "succeeded";
      if (status === "succeeded") {
        if (!p.automaticRefund) {
          if (order.status !== "refund_pending")
            throw new Error("ORDER_REVIEW");
          await moveInventory(order, "committed", session);
          order.status = "refunded";
          await order.save({ session });
        }
        p.status = "refunded";
        p.refundStatus = "succeeded";
        p.nextCheckAt = null;
        p.message = "Your full refund is confirmed.";
      } else {
        p.status = "refund_pending";
        p.refundStatus = ["failed", "canceled"].includes(status)
          ? "failed"
          : "pending";
        p.nextCheckAt = new Date(
          Date.now() + (p.refundStatus === "failed" ? 3600000 : 30000),
        );
        p.message =
          p.refundStatus === "failed"
            ? "The refund failed. Contact support; your order remains on hold."
            : "Your full refund is pending confirmation.";
      }
    });
  }
  async function refundExternal(p, token) {
    if (p.amountPaise === 0) return finishRefund(p._id, token, null);
    if (!provider) throw unavailable();
    if (
      !p.refundId &&
      Date.now() - new Date(p.refundRequestedAt).getTime() >= RETENTION_MS
    )
      throw new BindingError();
    const external = p.refundId
      ? await provider.retrieveRefund(p.refundId)
      : await provider.createRefund(
          { paymentIntentId: p.paymentIntentId, amountPaise: p.amountPaise },
          p.refundKey,
        );
    validRefund(p, external);
    return finishRefund(p._id, token, external);
  }
  async function reconcile(paymentId, { dueOnly = false } = {}) {
    const token = randomUUID(),
      now = new Date();
    let p = await Payment.findOneAndUpdate(
      {
        _id: paymentId,
        ...(dueOnly ? { nextCheckAt: { $ne: null, $lte: now } } : {}),
        $or: [
          { leaseUntil: { $exists: false } },
          { leaseUntil: null },
          { leaseUntil: { $lte: now } },
        ],
      },
      {
        $set: { leaseToken: token, leaseUntil: new Date(Date.now() + 120000) },
      },
      { returnDocument: "after" },
    ).lean();
    if (!p) return Payment.findById(paymentId).lean();
    try {
      if (["review", "refunded", "paid"].includes(p.status)) {
        await Payment.updateOne(
          {
            _id: p._id,
            leaseToken: token,
            status: p.status,
            ...(p.status === "paid" ? { refundKey: { $exists: false } } : {}),
          },
          { $set: { nextCheckAt: null } },
        );
        return p;
      }
      await expireOrders({ orderId: p.orderId, limit: 1 });
      if (p.refundKey) return await refundExternal(p, token);
      if (p.amountPaise === 0) {
        return await transaction(
          p._id,
          token,
          async (payment, order, session) => {
            if (
              order.status === "awaiting_payment" &&
              order.reservationExpiresAt > new Date()
            ) {
              await moveInventory(order, "reserved", session);
              order.status = "paid";
              await order.save({ session });
              payment.status = "paid";
            } else payment.status = "expired";
            payment.message = undefined;
            payment.nextCheckAt = null;
          },
        );
      }
      if (!provider) throw unavailable();
      if (
        !p.sessionId &&
        Date.now() - new Date(p.createdAt).getTime() >= RETENTION_MS
      )
        throw new BindingError();
      const recoveringCreation = !p.sessionId;
      let external = p.sessionId
        ? await provider.retrieveCheckout(p.sessionId)
        : await provider.createCheckout(p.creationParams, p.creationKey);
      validSession(p, external);
      p = await transaction(p._id, token, async (payment) => {
        payment.sessionId = external.id;
        payment.checkoutUrl = checkoutUrl(external.url);
      });
      if (!p) return null;
      if (recoveringCreation) {
        external = await provider.retrieveCheckout(p.sessionId);
        validSession(p, external);
      }
      const order = await Order.findById(p.orderId).lean();
      if (
        order.status !== "awaiting_payment" ||
        order.reservationExpiresAt <= new Date()
      ) {
        if (external.status === "open") {
          await provider.expireCheckout(external.id);
          // Expiry may race a capture. Always retrieve instead of trusting the expiry response.
          external = await provider.retrieveCheckout(external.id);
          validSession(p, external);
        }
      }
      await expireOrders({ orderId: p.orderId, limit: 1 });
      p = await transaction(p._id, token, async (payment, current, session) => {
        validSession(payment, external);
        if (external.payment_status === "paid") {
          const outsideRefund =
            hasOutsideRefund(payment, external) ||
            payment.outsideRefundNotified;
          payment.paymentIntentId = external.payment_intent.id;
          if (
            current.status === "awaiting_payment" &&
            current.reservationExpiresAt > new Date()
          ) {
            await moveInventory(current, "reserved", session);
            current.status = "paid";
            await current.save({ session });
            payment.status = "paid";
            payment.nextCheckAt = null;
            payment.message = undefined;
          } else if (["cancelled", "expired"].includes(current.status)) {
            if (!outsideRefund) setRefundIntent(payment, true);
          } else if (current.status === "awaiting_payment") {
            payment.nextCheckAt = new Date();
            payment.message = pendingMessage;
          }
          if (outsideRefund) {
            if (current.status === "paid") {
              current.status = "refund_pending";
              await current.save({ session });
            }
            holdOutsideRefund(payment);
          }
        } else {
          payment.status =
            external.status === "open" && current.status === "awaiting_payment"
              ? "open"
              : "expired";
          payment.nextCheckAt =
            external.status === "expired" ? null : new Date(Date.now() + 30000);
          payment.message = undefined;
        }
        payment.failures = 0;
      });
      if (p?.refundKey) return await refundExternal(p, token);
      return p;
    } catch (error) {
      const review = error instanceof BindingError;
      await Payment.updateOne(
        { _id: paymentId, leaseToken: token },
        {
          $set: {
            ...(review ? { status: "review" } : {}),
            message: review ? reviewMessage : pendingMessage,
            nextCheckAt: review
              ? null
              : new Date(
                  Date.now() +
                    Math.min(
                      3600000,
                      30000 * 2 ** Math.min(p?.failures ?? 0, 7),
                    ),
                ),
          },
          $inc: { failures: 1 },
        },
      );
      return Payment.findById(paymentId).lean();
    } finally {
      await Payment.updateOne(
        { _id: paymentId, leaseToken: token },
        { $unset: { leaseToken: 1, leaseUntil: 1 } },
      );
    }
  }
  async function checkout(customerId, orderId) {
    const order = await owned(customerId, orderId);
    let payment = await Payment.findOne({ orderId }).lean();
    if (!payment) {
      if (order.status !== "awaiting_payment")
        throw new ApiError(409, "This order is no longer awaiting payment.");
      if (order.totalPaise > 0 && order.totalPaise < 50)
        throw new ApiError(422, "The minimum card payment is 50 paise.");
      if (order.totalPaise > 0 && !provider) throw unavailable();
      try {
        payment = await mongoose.connection.transaction(async (session) => {
          const existing = await Payment.findOne({ orderId })
            .session(session)
            .lean();
          if (existing) return existing;
          const locked = await Order.updateOne(
            {
              _id: orderId,
              customerId,
              status: "awaiting_payment",
              reservationExpiresAt: { $gt: new Date() },
            },
            { $inc: { paymentRevision: 1 } },
            { session },
          );
          if (locked.matchedCount !== 1)
            throw new ApiError(409, "The payment reservation ended.");
          const paymentId = new mongoose.Types.ObjectId();
          const [created] = await Payment.create(
            [
              {
                _id: paymentId,
                orderId,
                customerId,
                amountPaise: order.totalPaise,
                creationKey: `checkout-${paymentId}`,
                creationParams: {
                  attemptId: String(paymentId),
                  orderId: String(orderId),
                  amountPaise: order.totalPaise,
                  frontendOrigin: config.frontendOrigin,
                  expiresAt: Math.floor(Date.now() / 1000) + 86400,
                },
              },
            ],
            { session },
          );
          return created.toObject();
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
        payment = await Payment.findOne({ orderId }).lean();
        if (!payment) throw error;
      }
    }
    payment = await reconcile(payment._id);
    const current = await owned(customerId, orderId);
    return {
      payment: paymentView(payment),
      checkoutUrl:
        payment?.status === "open" &&
        current.status === "awaiting_payment" &&
        current.reservationExpiresAt > new Date()
          ? checkoutUrl(payment.checkoutUrl)
          : null,
    };
  }
  async function refresh(customerId, orderId) {
    await owned(customerId, orderId);
    const payment = await Payment.findOne({ orderId }).lean();
    return {
      payment: paymentView(payment ? await reconcile(payment._id) : null),
    };
  }
  async function refund(customerId, orderId) {
    await owned(customerId, orderId);
    const p = await mongoose.connection.transaction(async (session) => {
      const payment = await Payment.findOne({ orderId, customerId }).session(
        session,
      );
      const order = await Order.findOne({ _id: orderId, customerId }).session(
        session,
      );
      if (
        !payment ||
        !["paid", "refund_pending", "refunded"].includes(order.status)
      )
        throw new ApiError(
          409,
          "Only paid, unfulfilled orders can be refunded.",
        );
      if (!payment.refundKey) {
        if (!canRefundOrder(order))
          throw new ApiError(
            409,
            "A full refund is available only before any seller starts processing.",
          );
        if (payment.status !== "paid")
          throw new ApiError(409, "Payment confirmation is still pending.");
        setRefundIntent(payment);
        order.status = "refund_pending";
        await order.save({ session });
        await payment.save({ session });
      }
      return payment.toObject();
    });
    return { payment: paymentView(await reconcile(p._id)) };
  }
  async function webhook(rawBody, signature) {
    if (!provider) throw unavailable();
    let event;
    try {
      event = await provider.verifyWebhook(rawBody, signature);
    } catch {
      throw new ApiError(400, "Invalid Stripe webhook signature.");
    }
    if (event?.livemode !== false)
      throw new ApiError(400, "Only Stripe test events are accepted.");
    const object = event.data?.object;
    let filter;
    if (
      event.type?.startsWith("checkout.session.") &&
      typeof object?.id === "string"
    )
      filter = { sessionId: object.id };
    else if (
      event.type?.startsWith("refund.") &&
      typeof object?.payment_intent === "string"
    )
      filter = { paymentIntentId: object.payment_intent };
    else if (
      event.type === "charge.refunded" &&
      typeof object?.payment_intent === "string"
    )
      filter = { paymentIntentId: object.payment_intent };
    else if (
      event.type?.startsWith("payment_intent.") &&
      typeof object?.id === "string"
    )
      filter = { paymentIntentId: object.id };
    if (filter) {
      let payment = await Payment.findOne(filter).lean();
      let verifiedIntent;
      // A refund webhook can arrive before the capture reconciler persists the PI.
      // Retrieve the trusted intent and resolve its immutable order/attempt binding.
      if (!payment && event.type === "charge.refunded") {
        verifiedIntent = await provider.retrievePaymentIntent(
          object.payment_intent,
        );
        if (verifiedIntent?.id !== object.payment_intent)
          throw new BindingError();
        const metadata = verifiedIntent.metadata;
        if (
          mongoose.isObjectIdOrHexString(metadata?.attemptId) &&
          mongoose.isObjectIdOrHexString(metadata?.orderId)
        ) {
          payment = await Payment.findOne({
            _id: metadata.attemptId,
            orderId: metadata.orderId,
          }).lean();
          if (payment) validIntent(payment, verifiedIntent);
        }
      }
      if (payment) {
        // Dashboard refunds are outside this milestone's intent workflow. A signed
        // event can place the order on hold, but never authorizes restocking.
        if (event.type === "charge.refunded") {
          await mongoose.connection.transaction(async (session) => {
            const current = await Payment.findById(payment._id).session(
              session,
            );
            if (!current || current.refundKey) return;
            if (verifiedIntent) validIntent(current, verifiedIntent);
            current.outsideRefundNotified = true;
            if (verifiedIntent) current.paymentIntentId = verifiedIntent.id;
            const order = await Order.findById(current.orderId).session(
              session,
            );
            if (order?.status === "paid") {
              holdOutsideRefund(current);
              order.status = "refund_pending";
              await order.save({ session });
            } else if (!["review", "refunded"].includes(current.status)) {
              current.nextCheckAt = new Date();
            }
            // This write conflicts with a concurrent capture transaction, causing
            // it to retry and observe the notification even with a stale API reply.
            await current.save({ session });
          });
        }
        await Payment.updateOne(
          {
            _id: payment._id,
            status: { $nin: ["paid", "refunded", "review"] },
          },
          { $set: { nextCheckAt: new Date() } },
        );
        await reconcile(payment._id);
      }
    }
    return { received: true };
  }
  async function sweep({ limit = 20 } = {}) {
    const due = await Payment.find({
      nextCheckAt: { $ne: null, $lte: new Date() },
      $or: [
        { leaseUntil: { $exists: false } },
        { leaseUntil: null },
        { leaseUntil: { $lte: new Date() } },
      ],
    })
      .sort({ nextCheckAt: 1, _id: 1 })
      .limit(limit)
      .select("_id")
      .lean();
    for (const payment of due) {
      try {
        await reconcile(payment._id, { dueOnly: true });
      } catch {
        await Payment.updateOne(
          { _id: payment._id },
          { $set: { nextCheckAt: new Date(Date.now() + 60000) } },
        );
      }
    }
    return due.length;
  }
  return { get, checkout, refresh, refund, webhook, sweep };
}
