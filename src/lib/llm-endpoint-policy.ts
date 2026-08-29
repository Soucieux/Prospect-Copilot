import { DEFAULT_LLM_BASE_URL } from "@/lib/constants";

/** Environment variable containing comma-separated, server-approved LLM URLs. */
export const LLM_ALLOWED_BASE_URLS_ENV = "LLM_ALLOWED_BASE_URLS";

/** Configuration error raised before an unapproved provider can be contacted. */
export class LlmEndpointPolicyError extends Error {
  /**
   * Create an unapproved-provider configuration failure.
   * @param message operator-facing detail naming the approval env var
   */
  public constructor(message: string) {
    super(message);
    this.name = "LlmEndpointPolicyError";
  }
}

/**
 * Parse and canonicalize an OpenAI-compatible provider base URL.
 * Credentials, query strings, and fragments are not valid endpoint config.
 */
function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (caught) {
    throw new LlmEndpointPolicyError("The configured LLM base URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LlmEndpointPolicyError("The LLM base URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new LlmEndpointPolicyError(
      "The LLM base URL cannot contain credentials, a query, or a fragment",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

/**
 * Validate a browser-supplied provider against the server-owned allowlist.
 * The default DeepSeek endpoint is always enabled. Administrators can opt in
 * additional endpoints, including local HTTP providers, through the env var.
 */
export function resolveAllowedLlmBaseUrl(
  requested: string | null | undefined,
  configuredAllowlist: string | undefined =
    process.env[LLM_ALLOWED_BASE_URLS_ENV],
): string {
  const candidate = normalizeBaseUrl(requested?.trim() || DEFAULT_LLM_BASE_URL);
  const approved = new Set<string>([normalizeBaseUrl(DEFAULT_LLM_BASE_URL)]);
  for (const entry of configuredAllowlist?.split(",") ?? []) {
    if (entry.trim()) approved.add(normalizeBaseUrl(entry.trim()));
  }
  if (!approved.has(candidate)) {
    throw new LlmEndpointPolicyError(
      `The requested LLM base URL is not approved by ${LLM_ALLOWED_BASE_URLS_ENV}`,
    );
  }
  return candidate;
}
