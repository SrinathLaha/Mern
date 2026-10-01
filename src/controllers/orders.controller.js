import * as service from "../services/orders.service.js";
export async function create(req, res) {
  const result = await service.createOrder(req.user._id, req.validated);
  res
    .status(result.created ? 201 : 200)
    .json({ success: true, data: { order: result.order } });
}
export const list =
  (seller = false) =>
  async (req, res) =>
    res.json({
      success: true,
      data: await service.listOrders(req.user._id, req.validatedQuery, seller),
    });
export const get =
  (seller = false) =>
  async (req, res) =>
    res.json({
      success: true,
      data: {
        order: await service.getOrder(
          req.user._id,
          req.validatedParams.id,
          seller,
        ),
      },
    });
export async function cancel(req, res) {
  res.json({
    success: true,
    data: {
      order: await service.cancelOrder(req.user._id, req.validatedParams.id),
    },
  });
}
