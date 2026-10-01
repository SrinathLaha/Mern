// Fulfillment is mutable operational state, separate from the checkout snapshots.
// Legacy orders synthesize pending entries without requiring a bulk migration.
export function fulfillmentsFor(order) {
  return order.groups.map((group) => {
    const sellerId = String(group.sellerId);
    const stored = order.fulfillments?.find(
      (entry) => entry.sellerId === sellerId,
    );
    if (!stored)
      return {
        sellerId,
        status: "pending",
        version: 0,
        tracking: null,
        history: order.createdAt
          ? [{ status: "pending", at: order.createdAt }]
          : [],
      };
    return {
      sellerId,
      status: stored.status,
      version: stored.version,
      tracking: stored.tracking
        ? {
            carrier: stored.tracking.carrier,
            trackingNumber: stored.tracking.trackingNumber,
            ...(stored.tracking.trackingUrl
              ? { trackingUrl: stored.tracking.trackingUrl }
              : {}),
          }
        : null,
      history: stored.history.map((entry) => ({
        status: entry.status,
        at: entry.at,
      })),
    };
  });
}
export function canRefundOrder(order) {
  return (
    order.status === "paid" &&
    fulfillmentsFor(order).every((entry) => entry.status === "pending")
  );
}
