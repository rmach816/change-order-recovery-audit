import { asString, authorizeSubscription, configFrom, json, portalIdempotencyKey, problem, readBody, recoveryTokenFor, stripeRequest } from "./_lib.js";

export async function POST(request: Request): Promise<Response> {
  if (request.method !== "POST") return problem(405, "Method not allowed");
  const config = configFrom();
  if (!config) return problem(503, "Billing is not configured");
  const body = await readBody(request);
  if (!body || (body.mode !== undefined && asString(body.mode, 8) !== config.mode)) return problem(400, "Invalid request");
  const action = asString(body.action, 16);
  if (action === "checkout") {
    const plan = asString(body.plan, 16);
    const activationId = asString(body.activationId, 64);
    const publicKey = asString(body.publicKey, 512);
    if ((plan !== "monthly" && plan !== "annual") || !activationId || !/^[A-Za-z0-9_-]{16,64}$/.test(activationId) || !publicKey) {
      return problem(400, "Invalid activation request");
    }
    const price = plan === "monthly" ? config.monthlyPriceId : config.annualPriceId;
    const form = new URLSearchParams({
      mode: "subscription",
      allow_promotion_codes: "true",
      "line_items[0][price]": price,
      "line_items[0][quantity]": "1",
      success_url: `${config.siteUrl}/activate?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.siteUrl}/?checkout=canceled`,
      client_reference_id: activationId,
      "subscription_data[metadata][cora_activation_id]": activationId,
      "subscription_data[metadata][cora_public_key]": publicKey,
      "subscription_data[metadata][cora_mode]": config.mode
    });
    const session = await stripeRequest(config, "/v1/checkout/sessions", { method: "POST", form });
    const url = session ? asString(session.url, 2048) : undefined;
    return url ? json({ url }) : problem(502, "Unable to start Checkout");
  }
  if (action === "portal") {
    const authorized = await authorizeSubscription(body, config, { expectedPurpose: "billing_portal" });
    if (!authorized || !authorized.decision.allowed) return problem(403, "Access could not be verified");
    const form = new URLSearchParams({ customer: authorized.subscription.customer, return_url: `${config.siteUrl}/manage` });
    const session = await stripeRequest(config, "/v1/billing_portal/sessions", {
      method: "POST",
      form,
      ...(authorized.proofNonce ? { idempotencyKey: portalIdempotencyKey(authorized.proofNonce) } : {})
    });
    const url = session ? asString(session.url, 2048) : undefined;
    return url ? json({ url }) : problem(502, "Unable to open billing management");
  }
  if (action === "recovery_key") {
    const authorized = await authorizeSubscription(body, config, { expectedPurpose: "recovery_key" });
    if (!authorized || !authorized.decision.allowed) return problem(403, "Access could not be verified");
    return json({ recoveryKey: recoveryTokenFor(authorized.subscription, config) });
  }
  return problem(400, "Invalid billing action");
}
