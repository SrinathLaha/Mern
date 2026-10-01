import { parseArgs } from "node:util";
import mongoose from "mongoose";
import { readConfig } from "../config/env.js";
import { connectDatabase } from "../config/database.js";
import { promoteCustomer } from "../services/admin.service.js";
const { values } = parseArgs({ options: { email: { type: "string" } } });
try {
  if (!values.email || !values.email.includes("@"))
    throw new Error(
      "Use npm run admin:promote -- --email your-existing-account@example.com",
    );
  const config = readConfig();
  await connectDatabase(config.mongodbUri);
  const user = await promoteCustomer(values.email);
  console.info(
    `Account ${user.email} is now an administrator. Sign in again; previous sessions have been invalidated.`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
