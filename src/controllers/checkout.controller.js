import { createQuote } from "../services/checkout.service.js";
export async function quote(req, res) {
  res
    .status(201)
    .json({
      success: true,
      data: { quote: await createQuote(req.user._id, req.validated) },
    });
}
