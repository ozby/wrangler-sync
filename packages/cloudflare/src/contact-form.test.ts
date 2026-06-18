import { describe, expect, it, vi } from "vitest";

import {
  buildContactConfirmationEmail,
  buildInternalContactEmail,
  createCloudflareContactFormHandler,
  validateContactForm,
  verifyTurnstileToken,
  type CloudflareEmailBinding,
  type ContactFormConfig,
} from "./contact-form.js";

const baseConfig: ContactFormConfig = {
  siteName: "Example Site",
  from: "info@example.com",
  internalRecipients: ["ops@example.com"],
  customerEmailField: "email",
  customerNameField: "name",
  fields: [
    { name: "name", label: "Name", required: true, maxLength: 80 },
    { name: "email", label: "Email", required: true, type: "email" },
    { name: "message", label: "Message", required: true, type: "textarea", maxLength: 500 },
  ],
  redirectPath: "/contact",
  subjects: {
    internal: "New website inquiry",
    confirmation: "We received your message",
  },
};

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

function request(entries: Record<string, string>): Request {
  return new Request("https://example.com/api/contact", {
    method: "POST",
    body: new URLSearchParams(entries),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

describe("contact form validation", () => {
  it("sanitizes valid values and normalizes customer email", () => {
    const result = validateContactForm(baseConfig, form({
      name: " Ada  Lovelace ",
      email: "ADA@EXAMPLE.COM ",
      message: " Hello\r\nworld ",
    }));

    expect(result).toEqual({
      ok: true,
      values: {
        name: "Ada Lovelace",
        email: "ada@example.com",
        message: "Hello\nworld",
      },
    });
  });

  it("rejects invalid required fields", () => {
    const result = validateContactForm(baseConfig, form({ name: "Ada", email: "not-email", message: "" }));

    expect(result).toEqual({ ok: false, error: "invalid_fields", fields: ["email", "message"] });
  });
});

describe("contact email builders", () => {
  const values = { name: "Ada", email: "ada@example.com", message: "Hello" };

  it("builds internal messages with verified from and customer replyTo", () => {
    const message = buildInternalContactEmail(baseConfig, values);

    expect(message).toMatchObject({
      from: "info@example.com",
      to: ["ops@example.com"],
      replyTo: "ada@example.com",
      subject: "New website inquiry",
    });
    expect(message.text).toContain("Name: Ada");
  });

  it("builds customer confirmations from the verified sender", () => {
    const message = buildContactConfirmationEmail(baseConfig, values);

    expect(message).toMatchObject({
      from: "info@example.com",
      to: "ada@example.com",
      replyTo: "info@example.com",
      subject: "We received your message",
    });
    expect(message.text).toContain("Hi Ada");
  });
});

describe("Turnstile verification", () => {
  it("posts secret, token, and remote IP to Cloudflare Siteverify", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true })));

    await expect(verifyTurnstileToken({ secret: "secret", token: "token", remoteIp: "203.0.113.10", fetcher })).resolves.toEqual({ ok: true });

    expect(fetcher).toHaveBeenCalledWith("https://challenges.cloudflare.com/turnstile/v0/siteverify", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ secret: "secret", response: "token", remoteip: "203.0.113.10" });
  });

  it("maps Siteverify failures without exposing token details", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: false, "error-codes": ["timeout-or-duplicate"] })));

    await expect(verifyTurnstileToken({ secret: "secret", token: "token", fetcher })).resolves.toEqual({ ok: false, error: "captcha_failed", turnstileCodes: ["timeout-or-duplicate"] });
  });
});

describe("createCloudflareContactFormHandler", () => {
  it("sends internal and confirmation emails before redirecting success", async () => {
    const email: CloudflareEmailBinding = { send: vi.fn(async () => ({ messageId: "ok" })) };
    const handler = createCloudflareContactFormHandler(baseConfig, {
      fetcher: vi.fn(async () => new Response(JSON.stringify({ success: true }))),
    });

    const response = await handler(request({ name: "Ada", email: "ada@example.com", message: "Hello", "cf-turnstile-response": "token" }), {
      EMAIL: email,
      CONTACT_TURNSTILE_SECRET_KEY: "secret",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/contact?contact=success");
    expect(email.send).toHaveBeenCalledTimes(2);
  });

  it("does not send email when captcha verification fails", async () => {
    const email: CloudflareEmailBinding = { send: vi.fn() };
    const handler = createCloudflareContactFormHandler(baseConfig, {
      fetcher: vi.fn(async () => new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }))),
    });

    const response = await handler(request({ name: "Ada", email: "ada@example.com", message: "Hello", "cf-turnstile-response": "bad" }), {
      EMAIL: email,
      CONTACT_TURNSTILE_SECRET_KEY: "secret",
    });

    expect(response.headers.get("location")).toBe("/contact?contact=captcha");
    expect(email.send).not.toHaveBeenCalled();
  });

  it("keeps success and logs non-PII metadata when confirmation fails", async () => {
    const warn = vi.fn();
    const email: CloudflareEmailBinding = {
      send: vi.fn(async () => {
        if ((email.send as ReturnType<typeof vi.fn>).mock.calls.length === 2) throw Object.assign(new Error("boom"), { code: "E_DELIVERY_FAILED" });
        return { messageId: "internal" };
      }),
    };
    const handler = createCloudflareContactFormHandler(baseConfig, {
      fetcher: vi.fn(async () => new Response(JSON.stringify({ success: true }))),
      logger: { warn },
    });

    const response = await handler(request({ name: "Ada", email: "ada@example.com", message: "Hello", "cf-turnstile-response": "token" }), {
      EMAIL: email,
      CONTACT_TURNSTILE_SECRET_KEY: "secret",
    });

    expect(response.headers.get("location")).toBe("/contact?contact=success");
    expect(warn).toHaveBeenCalledWith("contact_confirmation_failed", { code: "E_DELIVERY_FAILED", site: "Example Site" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("ada@example.com");
  });
});
