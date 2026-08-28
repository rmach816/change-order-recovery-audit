import { createHmac, timingSafeEqual } from "node:crypto";

export interface RecoveryTokenPayload {
  version: 1;
  customerId: string;
  subscriptionId: string;
  issuedAt: string;
}

const MAX_ID_LENGTH = 255;

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function decodeJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function validPayload(value: unknown): value is RecoveryTokenPayload {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 &&
    typeof item.customerId === "string" && item.customerId.length > 0 && item.customerId.length <= MAX_ID_LENGTH &&
    typeof item.subscriptionId === "string" && item.subscriptionId.length > 0 && item.subscriptionId.length <= MAX_ID_LENGTH &&
    typeof item.issuedAt === "string" && !Number.isNaN(new Date(item.issuedAt).valueOf());
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function createRecoveryToken(payload: RecoveryTokenPayload, secret: string): string {
  if (!secret) throw new Error("LICENSE_SIGNING_SECRET is required");
  if (!validPayload(payload)) throw new Error("Invalid recovery token payload");
  const encoded = base64url(JSON.stringify(payload));
  return `cora_v1.${encoded}.${base64url(signature(encoded, secret))}`;
}

export function verifyRecoveryToken(token: string, secret: string): RecoveryTokenPayload | undefined {
  if (!secret || token.length > 2048) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "cora_v1" || !parts[1] || !parts[2]) return undefined;
  try {
    const supplied = Buffer.from(parts[2], "base64url");
    const expected = signature(parts[1], secret);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
    const payload = decodeJson(parts[1]);
    return validPayload(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}
