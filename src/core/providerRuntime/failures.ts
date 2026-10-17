export type ProviderFailureKind =
  | "model-unavailable"
  | "model-configuration"
  | "authentication"
  | "rate-limit"
  | "quota"
  | "network"
  | "temporary"
  | "setup"
  | "unknown";

/** Safe, optional evidence supplied by API adapters or native CLI errors. */
export interface ProviderFailure {
  kind: ProviderFailureKind;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export function isModelFailure(failure: ProviderFailure): boolean {
  return failure.kind === "model-unavailable" || failure.kind === "model-configuration";
}

/** Ambiguous failures must never become permanent model rejection evidence. */
export function classifyProviderFailure(
  message: string,
  evidence?: { code?: string; status?: number; retryAfterMs?: number },
): ProviderFailure {
  const text = `${evidence?.code ?? ""}\n${message}`;
  const status = evidence?.status ?? Number(message.match(/HTTP (\d{3})\b/i)?.[1]);
  let kind: ProviderFailureKind = "unknown";
  if (
    /insufficient[_ -]quota|quota.{0,40}(exceed|exhaust)|billing|credit.{0,20}(exhaust|insufficient)/i.test(
      text,
    )
  )
    kind = "quota";
  else if (status === 429 || /rate[_ -]?limit|too many requests|resource_exhausted/i.test(text))
    kind = "rate-limit";
  else if (
    status === 401 ||
    /unauthenticated|unauthorized|authentication|invalid[_ -]api[_ -]key|api[_ -]key.{0,20}(?:required|missing)|credentials?.{0,20}(?:required|missing)|not logged in|signed out|expired.{0,20}(token|credential)|sign in|log in/i.test(
      text,
    )
  )
    kind = "authentication";
  else if (
    /ECONN\w+|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|fetch failed|network|socket|connection (reset|refused)|timed? out/i.test(
      text,
    )
  )
    kind = "network";
  else if (status >= 500 || /temporar|service unavailable|overload|outage/i.test(text))
    kind = "temporary";
  else if (
    /model[_ -](not[_ -]found|not[_ -]available|retired|removed|access[_ -]denied)|\bmodel (?:is )?(?:not found|unavailable|retired|removed)\b|\bmodels?\/\S+.{0,60}(?:not found|not supported|not available)|(?:selected |Google )?model\s+\S+\s+(?:is |was |has been )?(?:not found|unavailable|retired|removed|does not exist|not available|not accessible)|(?:do not|does not|don't|doesn't) have access to.{0,40}model|model.{0,60}(?:not supported for|unsupported for|not available (?:for|to)|not accessible (?:for|to))/i.test(
      text,
    )
  )
    kind = "model-unavailable";
  else if (
    /unsupported[_ -]model|invalid[_ -]model|unsupported model (?:id|identifier)|invalid model (?:id|identifier)|no (?:verified|supported) selector for|model.{0,40}(?:invalid|unsupported).{0,20}(?:identifier|configuration)/i.test(
      text,
    )
  )
    kind = "model-configuration";
  else if (
    /not installed|not available on PATH|missing executable|could not be executed|routing is not configured/i.test(
      text,
    )
  )
    kind = "setup";
  else if (status === 403 || /forbidden/i.test(text)) kind = "authentication";
  return {
    kind,
    message,
    retryable: kind === "network" || kind === "temporary" || kind === "rate-limit",
    ...(evidence?.retryAfterMs != null ? { retryAfterMs: evidence.retryAfterMs } : {}),
  };
}

/** Carries API status/code evidence without exposing a raw response body or credentials. */
export class ProviderRequestError extends Error {
  constructor(readonly failure: ProviderFailure) {
    super(failure.message);
  }
}

export function apiRequestError(
  status: number,
  body: string,
  retryAfterMs?: number,
): ProviderRequestError {
  let code: string | undefined;
  let detail = "";
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      parsed.error &&
      typeof parsed.error === "object"
    ) {
      if ("code" in parsed.error && typeof parsed.error.code === "string") code = parsed.error.code;
      else if ("type" in parsed.error && typeof parsed.error.type === "string")
        code = parsed.error.type;
      if ("message" in parsed.error && typeof parsed.error.message === "string")
        detail = parsed.error.message;
    }
  } catch {
    /* Non-JSON gateways provide no reliable model evidence. */
  }
  return new ProviderRequestError(
    classifyProviderFailure(
      `Provider request failed (HTTP ${status}).${detail ? ` ${detail}` : ""}`,
      { code, status, retryAfterMs },
    ),
  );
}

export function failureFromError(error: unknown, message: string): ProviderFailure {
  return error instanceof ProviderRequestError ? error.failure : classifyProviderFailure(message);
}

export function modelRecoveryMessage(model: string): string {
  return `The selected model ${model} is unavailable or unsupported for this account. Choose another model with /model, or change provider with /providers.`;
}

export function retryAfterDelay(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}
