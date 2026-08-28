export type BillingStatus =
  | "active"
  | "trialing"
  | "past_due"
  | "incomplete"
  | "unpaid"
  | "canceled"
  | "incomplete_expired"
  | "paused";

export interface SubscriptionSnapshot {
  status: BillingStatus | string;
  paidThrough: string;
}

export interface EntitlementDecision {
  allowed: boolean;
  state: "active" | "grace" | "inactive";
  paidThrough: string;
  graceUntil?: string;
}

const DAY_MS = 86_400_000;
export const OUTAGE_GRACE_MS = 7 * DAY_MS;

function validDate(value: string): Date | undefined {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? undefined : parsed;
}

export function normalizeSubscription(snapshot: SubscriptionSnapshot, now = new Date()): EntitlementDecision {
  const paidThrough = validDate(snapshot.paidThrough);
  if (!paidThrough) {
    return { allowed: false, state: "inactive", paidThrough: "" };
  }
  if (snapshot.status === "active" || snapshot.status === "trialing") {
    return { allowed: true, state: "active", paidThrough: paidThrough.toISOString() };
  }
  if (snapshot.status === "past_due") {
    const graceUntil = new Date(paidThrough.valueOf() + OUTAGE_GRACE_MS);
    if (now <= graceUntil) {
      return {
        allowed: true,
        state: "grace",
        paidThrough: paidThrough.toISOString(),
        graceUntil: graceUntil.toISOString()
      };
    }
  }
  return { allowed: false, state: "inactive", paidThrough: paidThrough.toISOString() };
}

export function allowsCachedOutage(
  decision: EntitlementDecision,
  checkedAt: string,
  now = new Date()
): boolean {
  const checked = validDate(checkedAt);
  if (!decision.allowed || !checked || now.valueOf() > checked.valueOf() + OUTAGE_GRACE_MS) return false;
  if (decision.state === "grace" && (!decision.graceUntil || now > new Date(decision.graceUntil))) return false;
  return true;
}
