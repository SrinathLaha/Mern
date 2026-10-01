import { transitionFulfillment } from "../services/fulfillment.service.js";
export async function transition(req, res) {
  res.json({
    success: true,
    data: {
      order: await transitionFulfillment(
        req.user._id,
        req.validatedParams.orderId,
        req.validated,
      ),
    },
  });
}
