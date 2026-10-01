import nodemailer from "nodemailer";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const defaultOutbox = fileURLToPath(
  new URL("../../../../work/mail/", import.meta.url),
);
const escapeHtml = (value) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );

export function createMailer(config) {
  const mail = config.mail ?? {
    mode: "local",
    outbox: defaultOutbox,
    from: "noreply@marketplace.test",
  };
  if (config.nodeEnv === "production" && mail.mode !== "smtp")
    throw new Error("Production requires SMTP email delivery.");
  const transport =
    mail.mode === "smtp"
      ? nodemailer.createTransport({
          host: mail.host,
          port: mail.port,
          secure: mail.secure,
          requireTLS: true,
          auth: { user: mail.user, pass: mail.password },
          connectionTimeout: 5000,
          greetingTimeout: 5000,
          socketTimeout: 8000,
          dnsTimeout: 5000,
          logger: false,
          debug: false,
          disableFileAccess: true,
          disableUrlAccess: true,
        })
      : null;
  return {
    async sendPasswordReset({ to, url }) {
      const subject = "Reset your Marketplace password";
      const text = `Use this link to choose a new password: ${url}\n\nThis link expires in 15 minutes and works once. If you did not request it, ignore this email. Your password has not changed.`;
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${subject}</title></head><body style="font-family:Segoe UI,sans-serif;background:#f5f5ef;color:#243d32;padding:32px"><main style="max-width:560px;margin:auto;background:white;padding:36px;border-radius:18px"><p>marketplace.</p><h1>Choose a new password.</h1><p>We received a request to reset your password.</p><p><a style="display:inline-block;background:#244e3f;color:white;padding:14px 22px;border-radius:8px" href="${escapeHtml(url)}">Reset password</a></p><p>This link expires in 15 minutes and works once. If you requested several emails, use the most recent one.</p><p>If you did not request this, you can ignore this email. Your password has not changed.</p></main></body></html>`;
      if (transport) {
        const result = await transport.sendMail({
          from: mail.from,
          to,
          subject,
          text,
          html,
        });
        if (!result.accepted?.length)
          throw new Error("Email delivery was not accepted.");
      } else {
        const outbox = mail.outbox ?? defaultOutbox;
        await mkdir(outbox, { recursive: true, mode: 0o700 });
        await writeFile(
          path.join(outbox, `${Date.now()}-${randomUUID()}.html`),
          html,
          { flag: "wx", mode: 0o600 },
        );
      }
    },
  };
}
