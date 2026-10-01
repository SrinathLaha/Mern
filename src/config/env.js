import { z } from "zod";

export function readConfig(env = process.env) {
  const schema = z.object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    HOST: z.string().default("127.0.0.1"),
    STRIPE_SECRET_KEY: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^sk_test_[A-Za-z0-9]+$/)
        .optional(),
    ),
    STRIPE_WEBHOOK_SECRET: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z
        .string()
        .regex(/^whsec_[A-Za-z0-9]+$/)
        .optional(),
    ),
    MAIL_MODE: z.enum(["local", "smtp"]).default("local"),
    MAIL_OUTBOX_DIR: z.string().min(1).optional(),
    MAIL_FROM: z.string().email().optional(),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    SMTP_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    MONGODB_URI: z.string().regex(/^mongodb(?:\+srv)?:\/\//),
    FRONTEND_URL: z.url(),
    JWT_ACCESS_SECRET: z
      .string()
      .min(48)
      .refine(
        (value) =>
          value !== "replace-with-a-random-secret-of-at-least-48-characters",
      ),
  });
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid environment variables: ${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")}`,
    );
  const values = parsed.data;
  const frontend = new URL(values.FRONTEND_URL);
  if (
    frontend.origin !== values.FRONTEND_URL ||
    !["http:", "https:"].includes(frontend.protocol)
  )
    throw new Error(
      "FRONTEND_URL must be an http(s) origin without a path or trailing slash.",
    );
  if (values.NODE_ENV === "production" && frontend.protocol !== "https:")
    throw new Error("Production requires an HTTPS FRONTEND_URL.");
  if (values.NODE_ENV === "production" && values.MAIL_MODE !== "smtp")
    throw new Error("Production requires SMTP email delivery.");
  if (
    values.MAIL_MODE === "smtp" &&
    (!values.MAIL_FROM ||
      !values.SMTP_HOST ||
      !values.SMTP_USER ||
      !values.SMTP_PASSWORD)
  )
    throw new Error(
      "SMTP requires MAIL_FROM, SMTP_HOST, SMTP_USER and SMTP_PASSWORD.",
    );
  return {
    nodeEnv: values.NODE_ENV,
    port: values.PORT,
    host: values.HOST,
    mongodbUri: values.MONGODB_URI,
    frontendOrigin: values.FRONTEND_URL,
    jwtSecret: values.JWT_ACCESS_SECRET,
    payments: {
      secretKey: values.STRIPE_SECRET_KEY,
      webhookSecret: values.STRIPE_WEBHOOK_SECRET,
    },
    mail: {
      mode: values.MAIL_MODE,
      outbox: values.MAIL_OUTBOX_DIR,
      from: values.MAIL_FROM ?? "noreply@marketplace.test",
      host: values.SMTP_HOST,
      port: values.SMTP_PORT,
      secure: values.SMTP_SECURE,
      user: values.SMTP_USER,
      password: values.SMTP_PASSWORD,
    },
  };
}
