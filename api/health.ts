import { configFrom, json } from "./_lib.js";

export function GET(request: Request): Response {
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  const configured = Boolean(configFrom());
  return json({ ok: true, configured }, configured ? 200 : 503);
}
