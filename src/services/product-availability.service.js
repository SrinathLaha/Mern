import { Product } from "../models/product.model.js";
import { Category } from "../models/category.model.js";
import { User } from "../models/user.model.js";

// Return only products that are still public. Hidden records never supply display data.
export async function publicProducts(ids) {
  const products = await Product.find({ _id: { $in: ids }, status: "approved" })
    .select("title images variants categoryId sellerId")
    .lean();
  const [categories, sellers] = await Promise.all([
    Category.find({
      _id: { $in: products.map((product) => product.categoryId) },
      active: true,
    })
      .select("_id")
      .lean(),
    User.find({
      _id: { $in: products.map((product) => product.sellerId) },
      role: "seller",
      status: "active",
      sellerStatus: "approved",
    })
      .select("storeName")
      .lean(),
  ]);
  const activeCategories = new Set(
    categories.map((category) => String(category._id)),
  );
  const activeSellers = new Map(
    sellers.map((seller) => [String(seller._id), seller]),
  );
  return new Map(
    products
      .filter(
        (product) =>
          activeCategories.has(String(product.categoryId)) &&
          activeSellers.has(String(product.sellerId)),
      )
      .map((product) => [
        String(product._id),
        {
          ...product,
          storeName:
            activeSellers.get(String(product.sellerId)).storeName ?? "",
        },
      ]),
  );
}
export function productSummary(productId, product) {
  return {
    productId: String(productId),
    title: product?.title ?? "Unavailable product",
    storeName: product?.storeName ?? "",
    image: product?.images?.[0]
      ? { url: product.images[0].url, alt: product.images[0].alt }
      : null,
  };
}
