export type ContactFieldType = "text" | "email" | "textarea" | "tel";

export type ContactFieldConfig = {
  readonly name: string;
  readonly label: string;
  readonly required?: boolean;
  readonly type?: ContactFieldType;
  readonly maxLength?: number;
};

export type EmailAddress = string | { email: string; name?: string };

export type EmailMessageBuilder = {
  readonly to: EmailAddress | readonly EmailAddress[];
  readonly from: EmailAddress;
  readonly subject: string;
  readonly html?: string;
  readonly text?: string;
  readonly cc?: EmailAddress | readonly EmailAddress[];
  readonly bcc?: EmailAddress | readonly EmailAddress[];
  readonly replyTo?: EmailAddress;
  readonly headers?: Record<string, string>;
};

export type CloudflareEmailBinding = {
  send(message: EmailMessageBuilder): Promise<unknown>;
};

export type ContactFormEnv = {
  readonly EMAIL?: CloudflareEmailBinding;
  readonly CONTACT_TURNSTILE_SECRET_KEY?: string;
};

export type ContactFormConfig = {
  readonly siteName: string;
  readonly from: string;
  readonly internalRecipients: readonly string[];
  readonly fields: readonly ContactFieldConfig[];
  readonly customerEmailField: string;
  readonly customerNameField?: string;
  readonly redirectPath: string;
  readonly subjects: {
    readonly internal: string;
    readonly confirmation: string;
  };
  readonly internalIntro?: string;
  readonly confirmationText?: (values: Record<string, string>) => string;
};

export type ContactValidationResult =
  | { readonly ok: true; readonly values: Record<string, string> }
  | { readonly ok: false; readonly error: "invalid_fields"; readonly fields: readonly string[] };

export type TurnstileVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: "captcha_failed"; readonly turnstileCodes: readonly string[] };

export type ContactFormHandlerOptions = {
  readonly fetcher?: typeof fetch;
  readonly logger?: Pick<Console, "warn">;
};

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const DEFAULT_MAX_LENGTH = 2_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function collapseInlineWhitespace(value: string): string {
  return value.replace(/[\t\f\v ]+/gu, " ");
}

export function sanitizeContactValue(value: FormDataEntryValue | null, field?: ContactFieldConfig): string {
  if (typeof value !== "string") return "";
  const withoutControls = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
  const normalized = field?.type === "textarea"
    ? withoutControls.replace(/\r\n?/gu, "\n").split("\n").map((line) => collapseInlineWhitespace(line).trim()).join("\n")
    : collapseInlineWhitespace(withoutControls.replace(/[\r\n]+/gu, " "));
  const trimmed = normalized.trim();
  const capped = trimmed.slice(0, field?.maxLength ?? DEFAULT_MAX_LENGTH);
  return field?.type === "email" ? capped.toLowerCase() : capped;
}

export function validateContactForm(config: ContactFormConfig, data: FormData): ContactValidationResult {
  const invalid: string[] = [];
  const values: Record<string, string> = {};

  for (const field of config.fields) {
    const value = sanitizeContactValue(data.get(field.name), field);
    values[field.name] = value;
    if (field.required === true && value.length === 0) invalid.push(field.name);
    if (field.type === "email" && value.length > 0 && !EMAIL_PATTERN.test(value)) invalid.push(field.name);
  }

  const customerEmail = values[config.customerEmailField] ?? "";
  if (customerEmail.length === 0 || !EMAIL_PATTERN.test(customerEmail)) {
    if (!invalid.includes(config.customerEmailField)) invalid.push(config.customerEmailField);
  }

  return invalid.length > 0 ? { ok: false, error: "invalid_fields", fields: invalid } : { ok: true, values };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function fieldText(config: ContactFormConfig, values: Record<string, string>): string {
  return config.fields.map((field) => `${field.label}: ${values[field.name] ?? ""}`).join("\n");
}

export function buildInternalContactEmail(config: ContactFormConfig, values: Record<string, string>): EmailMessageBuilder {
  const intro = config.internalIntro ?? `New contact form submission from ${config.siteName}.`;
  const rows = config.fields
    .map((field) => `<tr><th align="left" valign="top">${escapeHtml(field.label)}</th><td>${escapeHtml(values[field.name] ?? "").replace(/\n/gu, "<br>")}</td></tr>`)
    .join("");

  return {
    to: [...config.internalRecipients],
    from: config.from,
    replyTo: values[config.customerEmailField],
    subject: config.subjects.internal,
    text: `${intro}\n\n${fieldText(config, values)}`,
    html: `<p>${escapeHtml(intro)}</p><table>${rows}</table>`,
  };
}

export function buildContactConfirmationEmail(config: ContactFormConfig, values: Record<string, string>): EmailMessageBuilder {
  const customerName = config.customerNameField ? values[config.customerNameField] : "";
  const greeting = customerName ? `Hi ${customerName},` : "Hello,";
  const text = config.confirmationText?.(values) ?? [
    greeting,
    "",
    `We received your message to ${config.siteName}.`,
    "We will review it and reply as soon as possible.",
  ].join("\n");

  return {
    to: values[config.customerEmailField] ?? "",
    from: config.from,
    replyTo: config.from,
    subject: config.subjects.confirmation,
    text,
    html: `<p>${escapeHtml(greeting)}</p><p>We received your message to ${escapeHtml(config.siteName)}. We will review it and reply as soon as possible.</p>`,
  };
}

function turnstileCodes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export async function verifyTurnstileToken({
  secret,
  token,
  remoteIp,
  fetcher = fetch,
}: {
  readonly secret: string;
  readonly token: string;
  readonly remoteIp?: string | null;
  readonly fetcher?: typeof fetch;
}): Promise<TurnstileVerifyResult> {
  if (secret.length === 0 || token.length === 0) {
    return { ok: false, error: "captcha_failed", turnstileCodes: ["missing-input"] };
  }

  try {
    const body: Record<string, string> = { secret, response: token };
    if (remoteIp != null && remoteIp.length > 0) body.remoteip = remoteIp;
    const response = await fetcher(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { success?: unknown; "error-codes"?: unknown };
    if (result.success === true) return { ok: true };
    return { ok: false, error: "captcha_failed", turnstileCodes: turnstileCodes(result["error-codes"]) };
  } catch {
    return { ok: false, error: "captcha_failed", turnstileCodes: ["internal-error"] };
  }
}

function redirectWithStatus(path: string, status: "success" | "invalid" | "captcha" | "email"): Response {
  const url = new URL(path, "https://local.invalid");
  url.searchParams.set("contact", status);
  return new Response(null, { status: 303, headers: { location: `${url.pathname}${url.search}${url.hash}` } });
}

function redirectTarget(config: ContactFormConfig, data: FormData): string {
  const raw = sanitizeContactValue(data.get("_redirect"));
  if (raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return config.redirectPath;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
  return "unknown";
}

export function createCloudflareContactFormHandler(
  config: ContactFormConfig,
  options: ContactFormHandlerOptions = {},
): (request: Request, env: ContactFormEnv) => Promise<Response> {
  return async (request, env) => {
    if (request.method !== "POST") return redirectWithStatus(config.redirectPath, "invalid");

    const data = await request.formData();
    const target = redirectTarget(config, data);
    const validation = validateContactForm(config, data);
    if (!validation.ok) return redirectWithStatus(target, "invalid");

    const token = sanitizeContactValue(data.get("cf-turnstile-response"));
    const turnstile = await verifyTurnstileToken({
      secret: env.CONTACT_TURNSTILE_SECRET_KEY ?? "",
      token,
      remoteIp: request.headers.get("CF-Connecting-IP") ?? request.headers.get("X-Forwarded-For"),
      fetcher: options.fetcher,
    });
    if (!turnstile.ok) return redirectWithStatus(target, "captcha");

    if (env.EMAIL == null) return redirectWithStatus(target, "email");

    try {
      await env.EMAIL.send(buildInternalContactEmail(config, validation.values));
    } catch {
      return redirectWithStatus(target, "email");
    }

    try {
      await env.EMAIL.send(buildContactConfirmationEmail(config, validation.values));
    } catch (error) {
      options.logger?.warn("contact_confirmation_failed", { code: errorCode(error), site: config.siteName });
    }

    return redirectWithStatus(target, "success");
  };
}
