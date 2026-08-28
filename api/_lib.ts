import { createHash, createPublicKey, timingSafeEqual, verify } from "node:crypto";

import { createRecoveryToken, type RecoveryTokenPayload, verifyRecoveryToken } from "../src/recovery-token.js";
import { normalizeSubscription, type EntitlementDecision } from "../src/subscription-state.js";

export const MAX_REQUEST_BYTES = 4096;
const MAX_CLOCK_SKEW_MS = 60_000;
export type InstallationProofPurpose = "license_validate" | "billing_portal";

export interface AppConfig {
  mode: "test" | "live";
  siteUrl: string;
  stripeSecret: string;
  monthlyPriceId: string;
  annualPriceId: string;
  signingSecret: string;
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_end?: number;
  metadata?: Record<string, string>;
  priceIds: string[];
}

export interface AuthorizedSubscription {
  subscription: StripeSubscription;
  decision: EntitlementDecision;
  proofNonce?: string;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });
}

export function problem(status: number, message: string): Response {
  return json({ error: message }, status);
}

export function configFrom(environment: NodeJS.ProcessEnv = process.env): AppConfig | undefined {
  const mode = environment.APP_MODE;
  const siteUrl = environment.SITE_URL;
  const stripeSecret = environment.STRIPE_SECRET_KEY;
  const monthlyPriceId = environment.STRIPE_MONTHLY_PRICE_ID;
  const annualPriceId = environment.STRIPE_ANNUAL_PRICE_ID;
  const signingSecret = environment.LICENSE_SIGNING_SECRET;
  if ((mode !== "test" && mode !== "live") || !siteUrl || !stripeSecret || !monthlyPriceId || !annualPriceId || !signingSecret) return undefined;
  const stripeKeyMatchesMode = mode === "test"
    ? stripeSecret.startsWith("sk_test_") || stripeSecret.startsWith("rk_test_")
    : stripeSecret.startsWith("sk_live_") || stripeSecret.startsWith("rk_live_");
  if (!stripeKeyMatchesMode) return undefined;
  try {
    const parsed = new URL(siteUrl);
    if (parsed.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return { mode, siteUrl: siteUrl.replace(/\/$/, ""), stripeSecret, monthlyPriceId, annualPriceId, signingSecret };
}

export async function readBody(request: Request): Promise<Record<string, unknown> | undefined> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length < 0 || length > MAX_REQUEST_BYTES) return undefined;
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) return undefined;
  try {
    const body: unknown = JSON.parse(text);
    return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function asString(value: unknown, maximum: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : undefined;
}

export async function stripeRequest(
  config: AppConfig,
  path: string,
  options: { method?: "GET" | "POST"; form?: URLSearchParams; idempotencyKey?: string } = {},
  fetcher: typeof fetch = fetch
): Promise<Record<string, unknown> | undefined> {
  const response = await fetcher(`https://api.stripe.com${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${config.stripeSecret}`,
      ...(options.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {})
    },
    body: options.form?.toString()
  });
  if (!response.ok) return undefined;
  const payload: unknown = await response.json();
  return typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : undefined;
}

function asSubscription(value: Record<string, unknown>): StripeSubscription | undefined {
  const id = asString(value.id, 255);
  const customer = asString(value.customer, 255);
  const status = asString(value.status, 64);
  if (!id || !customer || !status) return undefined;
  const metadata = value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
    ? Object.fromEntries(Object.entries(value.metadata).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  const items = value.items && typeof value.items === "object" && "data" in value.items
    ? (value.items as { data?: unknown }).data
    : undefined;
  const priceIds = Array.isArray(items) ? items.flatMap((item) => {
    if (typeof item !== "object" || item === null || !("price" in item)) return [];
    const price = (item as { price?: unknown }).price;
    const priceId = typeof price === "string" ? price : price && typeof price === "object" && "id" in price ? (price as { id?: unknown }).id : undefined;
    return typeof priceId === "string" ? [priceId] : [];
  }) : [];
  const itemPeriodEnds = Array.isArray(items) ? items.flatMap((item) => {
    if (typeof item !== "object" || item === null || !("current_period_end" in item)) return [];
    const periodEnd = (item as { current_period_end?: unknown }).current_period_end;
    return typeof periodEnd === "number" ? [periodEnd] : [];
  }) : [];
  const legacyPeriodEnd = typeof value.current_period_end === "number" ? value.current_period_end : undefined;
  return {
    id,
    customer,
    status,
    current_period_end: legacyPeriodEnd ?? (itemPeriodEnds.length > 0 ? Math.max(...itemPeriodEnds) : undefined),
    metadata,
    priceIds
  };
}

async function lookupSubscription(config: AppConfig, id: string, fetcher?: typeof fetch): Promise<StripeSubscription | undefined> {
  const response = await stripeRequest(config, `/v1/subscriptions/${encodeURIComponent(id)}?expand[]=items.data.price`, {}, fetcher);
  return response ? asSubscription(response) : undefined;
}

export function subscriptionMatchesConfiguration(subscription: StripeSubscription, config: AppConfig): boolean {
  return subscription.metadata?.cora_mode === config.mode &&
    subscription.priceIds.some((priceId) => priceId === config.monthlyPriceId || priceId === config.annualPriceId);
}

function proofMessage(mode: string, purpose: InstallationProofPurpose, requestId: string, activationId: string, publicKey: string, timestamp: string, nonce: string): Buffer {
  return Buffer.from(`cora-install-v2\n${mode}\n${purpose}\n${requestId}\n${activationId}\n${publicKey}\n${timestamp}\n${nonce}`);
}

function verifiedInstallationProof(body: Record<string, unknown>, config: AppConfig, now: Date, expectedPurpose: InstallationProofPurpose): { activationId: string; publicKey: string; nonce: string } | undefined {
  const mode = asString(body.mode, 8);
  const purpose = asString(body.purpose, 32);
  const requestId = asString(body.requestId, 64);
  const activationId = asString(body.activationId, 64);
  const publicKey = asString(body.publicKey, 512);
  const timestamp = asString(body.timestamp, 40);
  const nonce = asString(body.nonce, 64);
  const signature = asString(body.signature, 256);
  if (!mode || mode !== config.mode || purpose !== expectedPurpose || !requestId || !/^[A-Za-z0-9_-]{16,64}$/.test(requestId) || !activationId || !/^[A-Za-z0-9_-]{16,64}$/.test(activationId) || !publicKey || !timestamp || !nonce || !signature) return undefined;
  const timestampValue = new Date(timestamp);
  if (Number.isNaN(timestampValue.valueOf()) || Math.abs(now.valueOf() - timestampValue.valueOf()) > MAX_CLOCK_SKEW_MS) return undefined;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64url"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") return undefined;
    return verify(null, proofMessage(mode, expectedPurpose, requestId, activationId, publicKey, timestamp, nonce), key, Buffer.from(signature, "base64url"))
      ? { activationId, publicKey, nonce }
      : undefined;
  } catch {
    return undefined;
  }
}

const SEARCH_RETRY_DELAYS_MS = [200, 400, 800] as const;

async function findInstallationSubscription(
  config: AppConfig,
  activationId: string,
  publicKey: string,
  options: { fetcher?: typeof fetch; sleep?: (milliseconds: number) => Promise<void> } = {}
): Promise<StripeSubscription | undefined> {
  const query = `metadata['cora_activation_id']:'${activationId.replace(/'/g, "")}'`;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  for (let attempt = 0; attempt <= SEARCH_RETRY_DELAYS_MS.length; attempt += 1) {
    const results = await stripeRequest(config, `/v1/subscriptions/search?query=${encodeURIComponent(query)}&limit=10&expand[]=data.items.data.price`, {}, options.fetcher);
    const data = results?.data;
    if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item !== "object" || item === null) continue;
        const found = asSubscription(item as Record<string, unknown>);
        if (found?.metadata?.cora_public_key !== publicKey || !subscriptionMatchesConfiguration(found, config)) continue;
        const expanded = await lookupSubscription(config, found.id, options.fetcher);
        if (expanded && subscriptionMatchesConfiguration(expanded, config)) return expanded;
      }
    }
    const delay = SEARCH_RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await sleep(delay);
  }
  return undefined;
}

function decisionFor(subscription: StripeSubscription, now: Date): EntitlementDecision | undefined {
  if (!subscription.current_period_end) return undefined;
  return normalizeSubscription({ status: subscription.status, paidThrough: new Date(subscription.current_period_end * 1000).toISOString() }, now);
}

export async function authorizeSubscription(
  body: Record<string, unknown>,
  config: AppConfig,
  options: { fetcher?: typeof fetch; now?: Date; sleep?: (milliseconds: number) => Promise<void>; expectedPurpose?: InstallationProofPurpose } = {}
): Promise<AuthorizedSubscription | undefined> {
  const now = options.now ?? new Date();
  const expectedPurpose = options.expectedPurpose ?? "license_validate";
  const recoveryKey = asString(body.recoveryKey, 2048);
  let subscription: StripeSubscription | undefined;
  let proofNonce: string | undefined;
  if (recoveryKey) {
    const token = verifyRecoveryToken(recoveryKey, config.signingSecret);
    if (!token) return undefined;
    subscription = await lookupSubscription(config, token.subscriptionId, options.fetcher);
    if (!subscription || subscription.customer !== token.customerId || !subscriptionMatchesConfiguration(subscription, config)) return undefined;
  } else {
    const proof = verifiedInstallationProof(body, config, now, expectedPurpose);
    if (!proof) return undefined;
    proofNonce = proof.nonce;
    subscription = await findInstallationSubscription(config, proof.activationId, proof.publicKey, options);
  }
  const decision = subscription ? decisionFor(subscription, now) : undefined;
  return subscription && decision ? { subscription, decision, proofNonce } : undefined;
}

export function portalIdempotencyKey(nonce: string): string {
  return `cora-portal-${createHash("sha256").update(nonce).digest("base64url")}`;
}

export function recoveryTokenFor(subscription: StripeSubscription, config: AppConfig, now = new Date()): string {
  const payload: RecoveryTokenPayload = {
    version: 1,
    customerId: subscription.customer,
    subscriptionId: subscription.id,
    issuedAt: now.toISOString()
  };
  return createRecoveryToken(payload, config.signingSecret);
}

export function opaqueEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
