import { authorizeSubscription, configFrom, json, problem, readBody } from "../_lib.js";

export async function POST(request: Request): Promise<Response> {
  if (request.method !== "POST") return problem(405, "Method not allowed");
  const config = configFrom();
  if (!config) return problem(503, "Licensing service is not configured");
  const body = await readBody(request);
  if (!body) return problem(400, "Invalid request");
  const authorized = await authorizeSubscription(body, config, { expectedPurpose: "license_validate" });
  if (!authorized) return problem(403, "Access could not be verified");
  const { decision } = authorized;
  return json({
    allowed: decision.allowed,
    state: decision.state,
    paidThrough: decision.paidThrough,
    ...(decision.graceUntil ? { graceUntil: decision.graceUntil } : {}),
    checkedAt: new Date().toISOString()
  });
}
