export const paymentController = (service, action) => async (req, res) =>
  res.json({
    success: true,
    data: await service[action](req.user._id, req.validatedParams.id),
  });
export const stripeWebhookController = (service) => async (req, res) =>
  res.json(await service.webhook(req.body, req.get("Stripe-Signature")));
