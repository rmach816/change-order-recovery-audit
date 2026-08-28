import { asString, configFrom, recoveryTokenFor, stripeRequest, subscriptionMatchesConfiguration } from "./_lib.js";

function page(message: string, recoveryKey?: string): Response {
  const keySection = recoveryKey
    ? `<section class="backup"><h2>Backup for another computer</h2><p>Save this recovery key somewhere secure. You do not need it on this purchasing computer.</p><code>${recoveryKey}</code></section>`
    : "";
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Cache-Control" content="no-store"><title>Activation | Change Order Recovery Audit</title><link rel="stylesheet" href="/site.css"></head><body><main class="activation"><p class="eyebrow">CHANGE ORDER RECOVERY AUDIT</p><h1>${message}</h1><p>Return to Claude Desktop and rerun the audit. This computer activates automatically.</p>${keySection}<p><a href="/">Back to the product page</a></p></main><script>history.replaceState(null,'',location.pathname)</script></body></html>`;
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" } });
}

export async function GET(request: Request): Promise<Response> {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const config = configFrom();
  const requestUrl = new URL(request.url, config?.siteUrl ?? "https://recoveryaudit.m2ai.tech");
  const sessionId = asString(requestUrl.searchParams.get("session_id"), 255);
  if (!config || !sessionId) return page("Activation could not be confirmed.");
  const session = await stripeRequest(config, `/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=subscription&expand[]=subscription.items.data.price`);
  const subscriptionValue = session?.subscription;
  const subscription = typeof subscriptionValue === "object" && subscriptionValue !== null ? subscriptionValue as Record<string, unknown> : undefined;
  const id = subscription ? asString(subscription.id, 255) : undefined;
  const customer = subscription ? asString(subscription.customer, 255) : undefined;
  if (!subscription || !id || !customer || session?.payment_status !== "paid" || session?.livemode !== (config.mode === "live")) return page("Activation could not be confirmed.");
  const status = asString(subscription.status, 64) ?? "";
  const items = subscription.items && typeof subscription.items === "object" && "data" in subscription.items ? (subscription.items as { data?: unknown }).data : undefined;
  const itemPeriodEnds = Array.isArray(items) ? items.flatMap((item) => {
    const periodEnd = item && typeof item === "object" && "current_period_end" in item ? (item as { current_period_end?: unknown }).current_period_end : undefined;
    return typeof periodEnd === "number" ? [periodEnd] : [];
  }) : [];
  const legacyPeriodEnd = typeof subscription.current_period_end === "number" ? subscription.current_period_end : undefined;
  const periodEnd = legacyPeriodEnd ?? (itemPeriodEnds.length > 0 ? Math.max(...itemPeriodEnds) : undefined);
  const priceIds = Array.isArray(items) ? items.flatMap((item) => {
    const price = item && typeof item === "object" && "price" in item ? (item as { price?: unknown }).price : undefined;
    return typeof price === "string" ? [price] : price && typeof price === "object" && "id" in price && typeof (price as { id?: unknown }).id === "string" ? [(price as { id: string }).id] : [];
  }) : [];
  const metadata = subscription.metadata && typeof subscription.metadata === "object" ? subscription.metadata as Record<string, string> : undefined;
  const checkedSubscription = { id, customer, status, current_period_end: periodEnd, priceIds, metadata };
  if (!periodEnd || (status !== "active" && status !== "trialing") || !subscriptionMatchesConfiguration(checkedSubscription, config)) return page("Activation is pending. Return to Claude and retry shortly.");
  const recoveryKey = recoveryTokenFor(checkedSubscription, config);
  return page("Payment confirmed. This computer is ready.", recoveryKey);
}
