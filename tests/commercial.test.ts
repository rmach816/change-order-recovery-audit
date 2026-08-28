import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { POST as billingHandler } from "../api/billing.js";
import { POST as checkoutHandler } from "../api/checkout.js";
import { GET as activateHandler } from "../api/activate.js";
import { authorizeSubscription, configFrom, portalIdempotencyKey, readBody, subscriptionMatchesConfiguration } from "../api/_lib.js";
import {
  authorizeAudit,
  createFileStateStore,
  createInstallationProof,
  loadOrCreateState,
  openBillingPortal,
  recordCompletedTrial,
  type LocalState,
  type StateStore
} from "../src/entitlement.js";
import { createRecoveryToken, verifyRecoveryToken } from "../src/recovery-token.js";
import { allowsCachedOutage, normalizeSubscription } from "../src/subscription-state.js";
import { createServer } from "../src/index.js";
import type { AuditResult } from "../src/types.js";

function memoryStore(initial?: LocalState): StateStore & { value?: LocalState } {
  let value = initial;
  let trialClaimed = false;
  return {
    get value() { return value; },
    async load() { return value; },
    async save(next) { value = structuredClone(next); },
    async claimTrial() {
      if (value?.trialCompleted) return { status: "completed" as const };
      if (trialClaimed) return { status: "busy" as const };
      if (!value) throw new Error("State must be initialized before claiming a trial");
      trialClaimed = true;
      let released = false;
      const release = async () => { released = true; trialClaimed = false; };
      return {
        status: "claimed" as const,
        claim: {
          state: value,
          async complete() {
            try {
              value!.trialCompleted = true;
            } finally {
              await release();
            }
          },
          release: async () => { if (!released) await release(); }
        }
      };
    }
  };
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T | PromiseLike<T>): void; reject(reason?: unknown): void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

const testConfig = {
  mode: "test" as const,
  siteUrl: "https://recoveryaudit.m2ai.tech",
  stripeSecret: "sk_test_example",
  monthlyPriceId: "price_monthly",
  annualPriceId: "price_annual",
  signingSecret: "test-signing-secret"
};

test("first completed audit is free and state survives a restart without plaintext recovery data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cora-state-"));
  try {
    const environment = { M2AI_STATE_DIR: directory } as NodeJS.ProcessEnv;
    const store = createFileStateStore(environment);
    const initial = await authorizeAudit({ store, environment });
    assert.equal(initial.allowed, true);
    assert.equal(initial.source, "trial");
    assert.ok(initial.state);
    await recordCompletedTrial(store, initial.state!);
    const restart = await loadOrCreateState(createFileStateStore(environment));
    assert.equal(restart.trialCompleted, true);
    const source = await readFile(join(directory, "state.json"), "utf8");
    assert.ok(!source.includes("cora_v1."));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an old malformed local trial claim is reclaimed while a fresh malformed claim stays busy", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cora-malformed-claim-"));
  const claimPath = join(directory, "trial-claim.json");
  try {
    const environment = { M2AI_STATE_DIR: directory } as NodeJS.ProcessEnv;
    await writeFile(claimPath, "{", "utf8");
    const staleAt = new Date(Date.now() - 3 * 60_000);
    await utimes(claimPath, staleAt, staleAt);
    const reclaimed = await authorizeAudit({ store: createFileStateStore(environment), environment });
    assert.equal(reclaimed.source, "trial");
    await reclaimed.trialClaim?.release();

    await writeFile(claimPath, "{", "utf8");
    const fresh = await authorizeAudit({ store: createFileStateStore(environment), environment });
    assert.equal(fresh.allowed, false);
    assert.match(fresh.message ?? "", /already running/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a renewable trial lease remains busy beyond its stale bound and reclaims only after release or heartbeat cessation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cora-renewable-claim-"));
  try {
    let clock = Date.now();
    const heartbeats: Array<() => Promise<void>> = [];
    const environment = { M2AI_STATE_DIR: directory } as NodeJS.ProcessEnv;
    const timing = {
      now: () => clock,
      heartbeatMs: 1,
      schedule: (callback: () => Promise<void>) => {
        heartbeats.push(callback);
        return { cancel() {} };
      }
    };
    const owner = await authorizeAudit({ store: createFileStateStore(environment, timing), environment });
    assert.equal(owner.source, "trial");
    clock += 3 * 60_000;
    await heartbeats[0]!();
    const held = await authorizeAudit({ store: createFileStateStore(environment, timing), environment });
    assert.equal(held.allowed, false);
    assert.match(held.message ?? "", /already running/);

    await owner.trialClaim?.release();
    const released = await authorizeAudit({ store: createFileStateStore(environment, timing), environment });
    assert.equal(released.source, "trial");

    clock += 3 * 60_000;
    const successor = await authorizeAudit({ store: createFileStateStore(environment, timing), environment });
    assert.equal(successor.source, "trial");
    await heartbeats[2]!();
    await heartbeats[1]!();
    const formerOwnerAttempt = await authorizeAudit({ store: createFileStateStore(environment, timing), environment });
    assert.equal(formerOwnerAttempt.allowed, false);
    await successor.trialClaim?.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("only one concurrent free audit can scan, and a failed audit releases its local claim", async () => {
  const store = memoryStore();
  const started = deferred<void>();
  const finish = deferred<void>();
  let scans = 0;
  const auditResult: AuditResult = {
    project: "synthetic",
    auditedAt: "2026-08-27T12:00:00.000Z",
    asOfDate: "2026-08-27",
    agingDays: 30,
    scannedSources: 0,
    detectedRecords: 0,
    findings: [],
    skippedSources: [],
    truncatedSources: [],
    limitations: [],
    humanReviewRequired: "Human review required."
  };
  const server = createServer(join(tmpdir(), "cora-concurrent-never-read"), {
    stateStore: store,
    environment: {} as NodeJS.ProcessEnv,
    auditFolder: async () => {
      scans += 1;
      started.resolve();
      await finish.promise;
      return auditResult;
    }
  });
  const client = new Client({ name: "commercial-trial-concurrency-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const first = client.callTool({ name: "audit_change_order_folder", arguments: {} });
    await started.promise;
    const second = await client.callTool({ name: "audit_change_order_folder", arguments: {} });
    assert.equal(second.isError, true);
    const secondText = (second.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
    assert.match(secondText, /already running/);
    assert.equal(scans, 1);
    finish.resolve();
    assert.notEqual((await first).isError, true);
    assert.equal(store.value?.trialCompleted, true);
  } finally {
    await client.close();
    await server.close();
  }

  const directory = await mkdtemp(join(tmpdir(), "cora-trial-claim-"));
  try {
    const environment = { M2AI_STATE_DIR: directory } as NodeJS.ProcessEnv;
    const firstStore = createFileStateStore(environment);
    const secondStore = createFileStateStore(environment);
    const firstClaim = await authorizeAudit({ store: firstStore, environment });
    const secondClaim = await authorizeAudit({ store: secondStore, environment });
    assert.equal(firstClaim.source, "trial");
    assert.equal(secondClaim.allowed, false);
    assert.match(secondClaim.message ?? "", /already running/);
    await firstClaim.trialClaim?.release();
    const retryClaim = await authorizeAudit({ store: secondStore, environment });
    assert.equal(retryClaim.source, "trial");
    await retryClaim.trialClaim?.release();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const retryStore = memoryStore();
  const failedServer = createServer(join(tmpdir(), "cora-failed-audit"), {
    stateStore: retryStore,
    environment: {} as NodeJS.ProcessEnv,
    auditFolder: async () => { throw new Error("synthetic interrupted audit"); }
  });
  const retryServer = createServer(join(tmpdir(), "cora-retry-audit"), {
    stateStore: retryStore,
    environment: {} as NodeJS.ProcessEnv,
    auditFolder: async () => auditResult
  });
  const failedClient = new Client({ name: "commercial-trial-failure-test", version: "1.0.0" });
  const retryClient = new Client({ name: "commercial-trial-retry-test", version: "1.0.0" });
  const [failedClientTransport, failedServerTransport] = InMemoryTransport.createLinkedPair();
  const [retryClientTransport, retryServerTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([failedServer.connect(failedServerTransport), failedClient.connect(failedClientTransport)]);
    assert.equal((await failedClient.callTool({ name: "audit_change_order_folder", arguments: {} })).isError, true);
    assert.equal(retryStore.value?.trialCompleted, false);
    await Promise.all([retryServer.connect(retryServerTransport), retryClient.connect(retryClientTransport)]);
    const retry = await retryClient.callTool({ name: "audit_change_order_folder", arguments: {} });
    assert.notEqual(retry.isError, true, JSON.stringify(retry));
    assert.equal(retryStore.value?.trialCompleted, true);
  } finally {
    await failedClient.close();
    await failedServer.close();
    await retryClient.close();
    await retryServer.close();
  }
});

test("subscription status, paid grace, and provider outage cache stay bounded", () => {
  const now = new Date("2026-08-27T12:00:00.000Z");
  assert.equal(normalizeSubscription({ status: "active", paidThrough: "2026-08-01T00:00:00.000Z" }, now).allowed, true);
  const grace = normalizeSubscription({ status: "past_due", paidThrough: "2026-08-24T12:00:00.000Z" }, now);
  assert.equal(grace.state, "grace");
  assert.equal(grace.allowed, true);
  assert.equal(normalizeSubscription({ status: "past_due", paidThrough: "2026-08-01T00:00:00.000Z" }, now).allowed, false);
  assert.equal(normalizeSubscription({ status: "canceled", paidThrough: "2026-09-01T00:00:00.000Z" }, now).allowed, false);
  assert.equal(allowsCachedOutage({ allowed: true, state: "active", paidThrough: "2026-09-01T00:00:00.000Z" }, "2026-08-21T12:00:00.000Z", now), true);
  assert.equal(allowsCachedOutage({ allowed: true, state: "active", paidThrough: "2026-09-01T00:00:00.000Z" }, "2026-08-20T11:59:59.000Z", now), false);
});

test("outage allows only recent cached proof; an unconfigured later request blocks before scan", async () => {
  const store = memoryStore();
  const environment = {} as NodeJS.ProcessEnv;
  const first = await authorizeAudit({ store, environment });
  await recordCompletedTrial(store, first.state!);
  store.value!.paidProof = { allowed: true, state: "active", paidThrough: "2026-09-01T00:00:00.000Z", checkedAt: "2026-08-26T12:00:00.000Z" };
  await store.save(store.value!);
  const cached = await authorizeAudit({ store, environment, now: new Date("2026-08-27T12:00:00.000Z") });
  assert.equal(cached.source, "outage-cache");
  const stale = await authorizeAudit({ store, environment, now: new Date("2026-09-03T12:00:01.000Z") });
  assert.equal(stale.allowed, false);
  assert.equal(stale.source, "blocked");
});

test("a consumed trial blocks at entitlement before an invalid project path can be read", async () => {
  const store = memoryStore();
  const state = await loadOrCreateState(store);
  state.trialCompleted = true;
  await store.save(state);
  const server = createServer(join(tmpdir(), "cora-never-read"), { stateStore: store, environment: {} as NodeJS.ProcessEnv });
  const client = new Client({ name: "commercial-boundary-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "audit_change_order_folder", arguments: {} });
    assert.equal(result.isError, true);
    const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
    assert.match(text, /Unable to verify access/);
    assert.doesNotMatch(text, /Configured project root|ENOENT|directory/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("an unpaid installation fails closed as subscription required, not as a provider outage", async () => {
  const store = memoryStore();
  const state = await loadOrCreateState(store);
  state.trialCompleted = true;
  await store.save(state);
  const result = await authorizeAudit({
    store,
    environment: { LICENSE_SERVICE_URL: "https://recoveryaudit.m2ai.tech", APP_MODE: "live" } as NodeJS.ProcessEnv,
    now: new Date("2026-08-28T17:30:00.000Z"),
    fetcher: async () => new Response(JSON.stringify({ error: "Access could not be verified" }), { status: 403 })
  });
  assert.equal(result.allowed, false);
  assert.equal(result.source, "blocked");
  assert.equal(result.message, "An active subscription is required before the folder can be read.");
});

test("recovery tokens and installation signatures reject tampering before any Stripe call", async () => {
  const token = createRecoveryToken({ version: 1, customerId: "cus_123", subscriptionId: "sub_123", issuedAt: "2026-08-27T00:00:00.000Z" }, testConfig.signingSecret);
  assert.equal(verifyRecoveryToken(token, testConfig.signingSecret)?.subscriptionId, "sub_123");
  assert.equal(verifyRecoveryToken(`${token}x`, testConfig.signingSecret), undefined);
  const store = memoryStore();
  const state = await loadOrCreateState(store);
  const proof = createInstallationProof(state, "test", "license_validate", new Date("2026-08-27T12:00:00.000Z"));
  let calls = 0;
  const alteredFirstByte = proof.signature.startsWith("A") ? "B" : "A";
  const result = await authorizeSubscription({ mode: "test", ...proof, signature: `${alteredFirstByte}${proof.signature.slice(1)}` }, testConfig, {
    now: new Date("2026-08-27T12:00:00.000Z"),
    fetcher: async () => { calls += 1; return new Response("{}", { status: 200 }); }
  });
  assert.equal(result, undefined);
  assert.equal(calls, 0);
  const wrongPurpose = createInstallationProof(state, "test", "billing_portal", new Date("2026-08-27T12:00:00.000Z"));
  assert.equal(await authorizeSubscription({ mode: "test", ...wrongPurpose }, testConfig, {
    now: new Date("2026-08-27T12:00:00.000Z"),
    fetcher: async () => { calls += 1; return Response.json({}); }
  }), undefined);
  const stale = createInstallationProof(state, "test", "license_validate", new Date("2026-08-27T11:58:59.000Z"));
  assert.equal(await authorizeSubscription({ mode: "test", ...stale }, testConfig, {
    now: new Date("2026-08-27T12:00:00.000Z"),
    fetcher: async () => { calls += 1; return Response.json({}); }
  }), undefined);
  const alteredRequest = proof.requestId.startsWith("A") ? `B${proof.requestId.slice(1)}` : `A${proof.requestId.slice(1)}`;
  assert.equal(await authorizeSubscription({ mode: "test", ...proof, requestId: alteredRequest }, testConfig, {
    now: new Date("2026-08-27T12:00:00.000Z"),
    fetcher: async () => { calls += 1; return Response.json({}); }
  }), undefined);
  assert.equal(calls, 0);
});

test("subscription search retries bounded propagation and then validates the expanded configured Price", async () => {
  const store = memoryStore();
  const state = await loadOrCreateState(store);
  const now = new Date("2026-08-27T12:00:00.000Z");
  const proof = createInstallationProof(state, "test", "license_validate", now);
  let searches = 0;
  const pauses: number[] = [];
  const subscription = {
    id: "sub_123", customer: "cus_123", status: "active", current_period_end: 1_788_134_400,
    metadata: { cora_activation_id: proof.activationId, cora_public_key: proof.publicKey, cora_mode: "test" },
    items: { data: [{ price: { id: "price_monthly" } }] }
  };
  const result = await authorizeSubscription({ mode: "test", ...proof }, testConfig, {
    now,
    sleep: async (milliseconds) => { pauses.push(milliseconds); },
    fetcher: async (input) => {
      const url = String(input);
      if (url.includes("/search?")) {
        searches += 1;
        return Response.json({ data: searches === 1 ? [] : [subscription] });
      }
      return Response.json(subscription);
    }
  });
  assert.equal(result?.decision.allowed, true);
  assert.equal(searches, 2);
  assert.deepEqual(pauses, [200]);
});

test("subscription validation accepts Stripe item-level billing periods", async () => {
  const store = memoryStore();
  const state = await loadOrCreateState(store);
  const proof = createInstallationProof(state, "test", "license_validate", new Date("2026-08-28T01:00:00.000Z"));
  const subscription = {
    id: "sub_item_period",
    customer: "cus_item_period",
    status: "active",
    metadata: { cora_activation_id: proof.activationId, cora_public_key: proof.publicKey, cora_mode: "test" },
    items: { data: [{ price: { id: "price_monthly" }, current_period_end: 1_788_134_400 }] }
  };
  const result = await authorizeSubscription({ mode: "test", ...proof }, testConfig, {
    now: new Date("2026-08-28T01:00:00.000Z"),
    sleep: async () => undefined,
    fetcher: async (input) => Response.json(String(input).includes("/search?") ? { data: [subscription] } : subscription)
  });
  assert.equal(result?.decision.allowed, true);
  assert.equal(result?.subscription.current_period_end, 1_788_134_400);
});

test("customer, mode, and configured Price mismatches fail closed for recovery and portal validation", async () => {
  const token = createRecoveryToken({ version: 1, customerId: "cus_expected", subscriptionId: "sub_expected", issuedAt: "2026-08-27T00:00:00.000Z" }, testConfig.signingSecret);
  const scenarios = [
    { customer: "cus_other", metadata: { cora_mode: "test" }, price: "price_monthly" },
    { customer: "cus_expected", metadata: { cora_mode: "live" }, price: "price_monthly" },
    { customer: "cus_expected", metadata: { cora_mode: "test" }, price: "price_other" }
  ];
  for (const scenario of scenarios) {
    const result = await authorizeSubscription({ recoveryKey: token }, testConfig, {
      fetcher: async () => Response.json({ id: "sub_expected", customer: scenario.customer, status: "active", current_period_end: 1_788_134_400, metadata: scenario.metadata, items: { data: [{ price: { id: scenario.price } }] } })
    });
    assert.equal(result, undefined);
  }
  assert.equal(subscriptionMatchesConfiguration({ id: "sub_ok", customer: "cus_ok", status: "active", current_period_end: 1, metadata: { cora_mode: "test" }, priceIds: ["price_annual"] }, testConfig), true);
});

test("purchasing-computer billing management signs fresh proof and does not need a project read", async () => {
  const store = memoryStore();
  let received: Record<string, unknown> | undefined;
  const result = await openBillingPortal({
    store,
    environment: { LICENSE_SERVICE_URL: "https://recoveryaudit.m2ai.tech", APP_MODE: "test" } as NodeJS.ProcessEnv,
    now: new Date("2026-08-27T12:00:00.000Z"),
    fetcher: async (_input, init) => {
      received = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ url: "https://billing.stripe.com/p/session" });
    }
  });
  assert.equal(result.url, "https://billing.stripe.com/p/session");
  assert.equal(received?.action, "portal");
  assert.equal(received?.mode, "test");
  assert.equal(typeof received?.signature, "string");
  assert.equal("recoveryKey" in (received ?? {}), false);
  const rejected = await openBillingPortal({
    store,
    environment: { LICENSE_SERVICE_URL: "https://recoveryaudit.m2ai.tech", APP_MODE: "test" } as NodeJS.ProcessEnv,
    fetcher: async () => new Response("{}", { status: 403 })
  });
  assert.equal(rejected.url, undefined);
});

test("portal accepts only a portal-purpose proof and sends Stripe a nonce-derived idempotency key", async () => {
  const savedEnvironment = { ...process.env };
  const savedFetch = globalThis.fetch;
  try {
    Object.assign(process.env, {
      APP_MODE: "test", SITE_URL: "https://recoveryaudit.m2ai.tech", STRIPE_SECRET_KEY: "sk_test_example",
      STRIPE_MONTHLY_PRICE_ID: "price_monthly", STRIPE_ANNUAL_PRICE_ID: "price_annual", LICENSE_SIGNING_SECRET: "secret"
    });
    const store = memoryStore();
    const state = await loadOrCreateState(store);
    const proof = createInstallationProof(state, "test", "billing_portal");
    const subscription = {
      id: "sub_portal", customer: "cus_portal", status: "active", current_period_end: Math.floor(Date.now() / 1000) + 86_400,
      metadata: { cora_activation_id: proof.activationId, cora_public_key: proof.publicKey, cora_mode: "test" },
      items: { data: [{ price: { id: "price_monthly" } }] }
    };
    let idempotencyKey: string | null = null;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/search?")) return Response.json({ data: [subscription] });
      if (url.includes("/v1/subscriptions/")) return Response.json(subscription);
      idempotencyKey = new Headers(init?.headers).get("idempotency-key");
      return Response.json({ url: "https://billing.stripe.com/p/session" });
    };
    const accepted = await billingHandler(new Request("https://example.test/api/billing", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "portal", mode: "test", ...proof })
    }));
    assert.equal(accepted.status, 200);
    assert.equal(idempotencyKey, portalIdempotencyKey(proof.nonce));
    const wrongPurpose = createInstallationProof(state, "test", "license_validate");
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return Response.json({}); };
    const rejected = await billingHandler(new Request("https://example.test/api/billing", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "portal", mode: "test", ...wrongPurpose })
    }));
    assert.equal(rejected.status, 403);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
    Object.assign(process.env, savedEnvironment);
  }
});

test("billing-management MCP tool returns the portal URL without touching an invalid project path", async () => {
  const store = memoryStore();
  let calls = 0;
  const server = createServer(join(tmpdir(), "cora-billing-never-read"), {
    stateStore: store,
    environment: { LICENSE_SERVICE_URL: "https://recoveryaudit.m2ai.tech", APP_MODE: "test" } as NodeJS.ProcessEnv,
    fetcher: async () => { calls += 1; return Response.json({ url: "https://billing.stripe.com/p/session" }); }
  });
  const client = new Client({ name: "commercial-billing-tool-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = await client.callTool({ name: "manage_change_order_subscription", arguments: {} });
    assert.notEqual(result.isError, true);
    const text = (result.content as Array<{ type: string; text?: string }>).find((item) => item.type === "text")?.text ?? "";
    assert.match(text, /https:\/\/billing\.stripe\.com\/p\/session/);
    assert.equal(calls, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("request bodies are bounded and test/live mode mismatches fail before Stripe", async () => {
  const oversized = new Request("https://example.test", { method: "POST", body: JSON.stringify({ value: "x".repeat(4096) }) });
  assert.equal(await readBody(oversized), undefined);
  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      APP_MODE: "test", SITE_URL: "https://recoveryaudit.m2ai.tech", STRIPE_SECRET_KEY: "sk_test_example",
      STRIPE_MONTHLY_PRICE_ID: "price_monthly", STRIPE_ANNUAL_PRICE_ID: "price_annual", LICENSE_SIGNING_SECRET: "secret"
    });
    assert.ok(configFrom());
    process.env.STRIPE_SECRET_KEY = "rk_test_example";
    assert.ok(configFrom(), "test-mode restricted Stripe keys are accepted");
    process.env.STRIPE_SECRET_KEY = "rk_live_example";
    assert.equal(configFrom(), undefined, "live-mode keys fail closed in test mode");
    process.env.STRIPE_SECRET_KEY = "rk_test_example";
    const response = await billingHandler(new Request("https://example.test/api/billing", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "checkout", mode: "live" }) }));
    assert.equal(response.status, 400);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("activation renders a safe failure page when the serverless runtime supplies a relative request URL", async () => {
  const response = await activateHandler({ method: "GET", url: "/activate" } as Request);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Activation could not be confirmed/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("activation confirms current Stripe item-level billing periods", async () => {
  const savedEnvironment = { ...process.env };
  const savedFetch = globalThis.fetch;
  try {
    Object.assign(process.env, {
      APP_MODE: "test", SITE_URL: "https://recoveryaudit.example", STRIPE_SECRET_KEY: "rk_test_example",
      STRIPE_MONTHLY_PRICE_ID: "price_monthly", STRIPE_ANNUAL_PRICE_ID: "price_annual", LICENSE_SIGNING_SECRET: "secret"
    });
    globalThis.fetch = async () => Response.json({
      payment_status: "paid",
      livemode: false,
      subscription: {
        id: "sub_item_period", customer: "cus_item_period", status: "active",
        metadata: { cora_mode: "test" },
        items: { data: [{ price: { id: "price_monthly" }, current_period_end: 1_788_134_400 }] }
      }
    });
    const response = await activateHandler(new Request("https://recoveryaudit.example/activate?session_id=cs_test_example"));
    assert.match(await response.text(), /Payment confirmed\. This computer is ready\./);
  } finally {
    globalThis.fetch = savedFetch;
    for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
    Object.assign(process.env, savedEnvironment);
  }
});

test("static public routes carry accurate metadata and crawler boundaries", async () => {
  const root = new URL("../public/", import.meta.url);
  const landing = await readFile(new URL("index.html", root), "utf8");
  const robots = await readFile(new URL("robots.txt", root), "utf8");
  const sitemap = await readFile(new URL("sitemap.xml", root), "utf8");
  const styles = await readFile(new URL("site.css", root), "utf8");
  const terms = await readFile(new URL("terms/index.html", root), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const reviewerGuide = await readFile(new URL("../docs/reviewer-guide.md", import.meta.url), "utf8");
  const security = await readFile(new URL("../SECURITY.md", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8")) as {
    manifest_version: string;
    version: string;
    server: { mcp_config: { env: Record<string, string> } };
    tools: Array<{ name: string }>;
    privacy_policies: string[];
  };
  assert.match(landing, /<title>Change Order Audit for Contractors \| M2 AI<\/title>/);
  assert.match(landing, /A private change-order audit for contractors/);
  assert.match(landing, /https:\/\/recoveryaudit\.m2ai\.tech\//);
  assert.match(landing, /\$99/);
  assert.match(landing, /Windows/);
  assert.match(landing, /Download for Windows/);
  assert.match(landing, /fetch\("\/api\/checkout"/);
  assert.doesNotMatch(landing, /fetch\("\/api\/billing"/);
  assert.match(landing, /github\.com\/rmach816\/change-order-recovery-audit\/releases\/download\/v1\.0\.1\/claude-change-order-recovery-audit\.mcpb/);
  assert.match(landing, /src="\/icon\.png"/);
  assert.match(landing, /Skip to main content/);
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, /Disallow: \/activate/);
  assert.match(sitemap, /\/privacy/);
  assert.match(sitemap, /\/terms/);
  assert.match(sitemap, /\/support/);
  assert.match(styles, /@media \(max-width:700px\)/);
  assert.match(styles, /prefers-reduced-motion:reduce/);
  assert.equal(manifest.server.mcp_config.env.LICENSE_SERVICE_URL, "https://recoveryaudit.m2ai.tech");
  assert.equal(manifest.server.mcp_config.env.APP_MODE, "live");
  assert.equal(manifest.manifest_version, "0.4");
  assert.equal(manifest.version, "1.0.1");
  assert.deepEqual(manifest.privacy_policies, ["https://recoveryaudit.m2ai.tech/privacy"]);
  assert.deepEqual(manifest.tools.map((tool) => tool.name), ["audit_change_order_folder", "manage_change_order_subscription"]);
  assert.match(readme, /^## Privacy Policy$/m);
  assert.match(readme, /https:\/\/recoveryaudit\.m2ai\.tech\/privacy/);
  assert.match(readme, /Stripe processes subscription and billing information/);
  assert.match(readme, /Vercel hosts the licensing endpoints/);
  assert.match(readme, /richard@m2ai\.tech/);
  assert.doesNotMatch(readme, /\.\.\/\.\.\/docs\//);
  assert.match(terms, /Texas law/);
  assert.match(terms, /Fort Bend County, Texas/);
  assert.match(reviewerGuide, /fixtures\/demo-project\//);
  assert.match(reviewerGuide, /audit_change_order_folder/);
  assert.match(reviewerGuide, /manage_change_order_subscription/);
  assert.match(reviewerGuide, /CORA_REVIEWER_ENTITLEMENT_TOKEN/);
  assert.match(security, /richard@m2ai\.tech/);
});

test("browser-safe Checkout alias uses the guarded billing handler", async () => {
  const response = await checkoutHandler(new Request("https://example.test/api/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "checkout" })
  }));
  assert.equal(response.status, 503);
});
