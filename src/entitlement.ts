import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { allowsCachedOutage, type EntitlementDecision } from "./subscription-state.js";

const STATE_VERSION = 1;
const REQUEST_TIMEOUT_MS = 5_000;
const TRIAL_CLAIM_STALE_MS = 2 * 60_000;
const TRIAL_CLAIM_HEARTBEAT_MS = 30_000;

interface ClaimLeaseTiming {
  now?: () => number;
  heartbeatMs?: number;
  schedule?: (callback: () => Promise<void>, intervalMs: number) => { cancel(): void };
}

export type InstallationProofPurpose = "license_validate" | "billing_portal";

export interface LocalState {
  version: 1;
  activationId: string;
  publicKey: string;
  privateKey: string;
  trialCompleted: boolean;
  recoveryKeyFingerprint?: string;
  paidProof?: EntitlementDecision & { checkedAt: string };
}

export interface StateStore {
  load(): Promise<LocalState | undefined>;
  save(state: LocalState): Promise<void>;
  claimTrial(): Promise<TrialClaimResult>;
}

export interface TrialClaim {
  state: LocalState;
  complete(): Promise<void>;
  release(): Promise<void>;
}

export type TrialClaimResult =
  | { status: "claimed"; claim: TrialClaim }
  | { status: "busy" }
  | { status: "completed" };

export interface EntitlementResult {
  allowed: boolean;
  source: "trial" | "remote" | "outage-cache" | "blocked";
  message?: string;
  state?: LocalState;
  trialClaim?: TrialClaim;
}

export interface BillingPortalResult {
  url?: string;
  message?: string;
}

interface ValidateResponse extends EntitlementDecision {
  checkedAt: string;
}

function stateDirectory(environment: NodeJS.ProcessEnv): string {
  return environment.M2AI_STATE_DIR?.trim() || join(environment.LOCALAPPDATA?.trim() || homedir() || tmpdir(), "M2AI", "ChangeOrderRecoveryAudit");
}

function createState(): LocalState {
  const keys = generateKeyPairSync("ed25519");
  return {
    version: STATE_VERSION,
    activationId: randomBytes(18).toString("base64url"),
    publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
    trialCompleted: false
  };
}

function validState(value: unknown): value is LocalState {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<LocalState>;
  return item.version === STATE_VERSION && typeof item.activationId === "string" && item.activationId.length >= 16 &&
    typeof item.publicKey === "string" && item.publicKey.length > 20 && typeof item.privateKey === "string" &&
    item.privateKey.length > 20 && typeof item.trialCompleted === "boolean";
}

export function createFileStateStore(environment: NodeJS.ProcessEnv = process.env, timing: ClaimLeaseTiming = {}): StateStore {
  const directory = stateDirectory(environment);
  const path = join(directory, "state.json");
  const claimPath = join(directory, "trial-claim.json");
  const now = timing.now ?? Date.now;
  const heartbeatMs = timing.heartbeatMs ?? TRIAL_CLAIM_HEARTBEAT_MS;
  const schedule = timing.schedule ?? ((callback, intervalMs) => {
    const timer = setInterval(() => { void callback(); }, intervalMs);
    timer.unref();
    return { cancel: () => clearInterval(timer) };
  });
  const claimId = () => randomBytes(18).toString("base64url");
  const releaseClaim = async (id: string): Promise<void> => {
    try {
      const handle = await open(claimPath, "r+");
      try {
        const raw = JSON.parse(await handle.readFile({ encoding: "utf8" })) as { id?: unknown };
        if (raw.id !== id) return;
        const released = Buffer.from(JSON.stringify({ id, releasedAt: new Date(now()).toISOString() }));
        await handle.write(released, 0, released.length, 0);
        await handle.truncate(released.length);
      } finally {
        await handle.close();
      }
    } catch {
      // A missing or unreadable claim cannot be renewed or removed by this owner.
    }
  };
  const refreshClaim = async (id: string): Promise<void> => {
    try {
      const handle = await open(claimPath, "r+");
      try {
        const raw = JSON.parse(await handle.readFile({ encoding: "utf8" })) as { id?: unknown; releasedAt?: unknown };
        if (raw.id !== id || raw.releasedAt !== undefined) return;
        const refreshedAt = new Date(now());
        await handle.utimes(refreshedAt, refreshedAt);
      } finally {
        await handle.close();
      }
    } catch {
      // The owner may have crashed or a successor may already own the path.
    }
  };
  const staleClaim = async (): Promise<boolean> => {
    try {
      const raw = JSON.parse(await readFile(claimPath, "utf8")) as { releasedAt?: unknown };
      if (typeof raw.releasedAt === "string" && Number.isFinite(new Date(raw.releasedAt).valueOf())) return true;
    } catch {
      // A crash can leave the exclusively created file empty or malformed. Its mtime
      // is the bounded fallback; a fresh malformed claim deliberately stays busy.
    }
    try {
      return now() - (await stat(claimPath)).mtimeMs > TRIAL_CLAIM_STALE_MS;
    } catch {
      return false;
    }
  };
  return {
    async load() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        return validState(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    async save(state) {
      await mkdir(directory, { recursive: true });
      const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    },
    async claimTrial() {
      await mkdir(directory, { recursive: true });
      let id: string | undefined;
      for (let attempt = 0; attempt < 2 && !id; attempt += 1) {
        const candidate = claimId();
        try {
          const handle = await open(claimPath, "wx", 0o600);
          await handle.writeFile(JSON.stringify({ id: candidate, createdAt: new Date(now()).toISOString() }), "utf8");
          await handle.close();
          id = candidate;
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
          if (code !== "EEXIST" || !(await staleClaim())) return { status: "busy" };
          await rm(claimPath, { force: true });
        }
      }
      if (!id) return { status: "busy" };
      try {
        const existing = await this.load();
        if (existing?.trialCompleted) {
          await releaseClaim(id);
          return { status: "completed" };
        }
        const state = existing ?? createState();
        if (!existing) await this.save(state);
        let released = false;
        let heartbeat: { cancel(): void } | undefined;
        const release = async (): Promise<void> => {
          if (released) return;
          released = true;
          heartbeat?.cancel();
          await releaseClaim(id!);
        };
        heartbeat = schedule(async () => {
          if (!released) await refreshClaim(id!);
        }, heartbeatMs);
        return {
          status: "claimed",
          claim: {
            state,
            async complete() {
              try {
                state.trialCompleted = true;
                const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
                await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
                await rename(temporary, path);
              } finally {
                await release();
              }
            },
            release
          }
        };
      } catch (error) {
        await releaseClaim(id);
        throw error;
      }
    }
  };
}

export async function loadOrCreateState(store: StateStore): Promise<LocalState> {
  const existing = await store.load();
  if (existing) return existing;
  const created = createState();
  await store.save(created);
  return created;
}

export function recoveryKeyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("base64url");
}

export function createInstallationProof(state: LocalState, mode: string, purpose: InstallationProofPurpose, now = new Date()): {
  activationId: string;
  publicKey: string;
  purpose: InstallationProofPurpose;
  requestId: string;
  timestamp: string;
  nonce: string;
  signature: string;
} {
  const timestamp = now.toISOString();
  const requestId = randomBytes(18).toString("base64url");
  const nonce = randomBytes(18).toString("base64url");
  const message = `cora-install-v2\n${mode}\n${purpose}\n${requestId}\n${state.activationId}\n${state.publicKey}\n${timestamp}\n${nonce}`;
  const privateKey = Buffer.from(state.privateKey, "base64url");
  return {
    activationId: state.activationId,
    publicKey: state.publicKey,
    purpose,
    requestId,
    timestamp,
    nonce,
    signature: sign(null, Buffer.from(message), { key: privateKey, format: "der", type: "pkcs8" }).toString("base64url")
  };
}

async function callValidation(
  state: LocalState,
  environment: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
  now: Date
): Promise<ValidateResponse> {
  const serviceUrl = environment.LICENSE_SERVICE_URL?.trim();
  const mode = environment.APP_MODE?.trim();
  if (!serviceUrl || (mode !== "test" && mode !== "live")) throw new Error("Licensing service is not configured");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const proof = createInstallationProof(state, mode, "license_validate", now);
    const recoveryKey = environment.LICENSE_KEY?.trim();
    const response = await fetcher(new URL("/api/license/validate", serviceUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ mode, ...proof, ...(recoveryKey ? { recoveryKey } : {}) }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error("Licensing service rejected validation");
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null) throw new Error("Licensing service returned an invalid response");
    const result = payload as Partial<ValidateResponse>;
    if (typeof result.allowed !== "boolean" || (result.state !== "active" && result.state !== "grace" && result.state !== "inactive") ||
      typeof result.paidThrough !== "string" || typeof result.checkedAt !== "string") {
      throw new Error("Licensing service returned an invalid response");
    }
    return result as ValidateResponse;
  } finally {
    clearTimeout(timer);
  }
}

export async function openBillingPortal(options: {
  store?: StateStore;
  environment?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  now?: Date;
} = {}): Promise<BillingPortalResult> {
  const environment = options.environment ?? process.env;
  const serviceUrl = environment.LICENSE_SERVICE_URL?.trim();
  const mode = environment.APP_MODE?.trim();
  if (!serviceUrl || (mode !== "test" && mode !== "live")) return { message: "Licensing service is not configured." };
  const store = options.store ?? createFileStateStore(environment);
  const state = await loadOrCreateState(store);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const proof = createInstallationProof(state, mode, "billing_portal", options.now ?? new Date());
    const response = await (options.fetcher ?? fetch)(new URL("/api/billing", serviceUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ action: "portal", mode, ...proof }),
      signal: controller.signal
    });
    if (!response.ok) return { message: "Billing access could not be verified." };
    const payload: unknown = await response.json();
    const url = typeof payload === "object" && payload !== null && "url" in payload && typeof payload.url === "string" ? payload.url : undefined;
    if (!url) return { message: "Billing access could not be verified." };
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return { message: "Billing access could not be verified." };
    return { url };
  } catch {
    return { message: "Unable to open billing management. Check your connection and try again." };
  } finally {
    clearTimeout(timer);
  }
}

export async function authorizeAudit(options: {
  store?: StateStore;
  environment?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  now?: Date;
} = {}): Promise<EntitlementResult> {
  const environment = options.environment ?? process.env;
  const store = options.store ?? createFileStateStore(environment);
  let state = await loadOrCreateState(store);
  if (!state.trialCompleted) {
    const claim = await store.claimTrial();
    if (claim.status === "claimed") return { allowed: true, source: "trial", state: claim.claim.state, trialClaim: claim.claim };
    if (claim.status === "busy") return { allowed: false, source: "blocked", message: "A free audit is already running on this computer. Wait for it to finish before trying again.", state };
    state = await loadOrCreateState(store);
  }
  try {
    const validated = await callValidation(state, environment, options.fetcher ?? fetch, options.now ?? new Date());
    if (!validated.allowed) {
      delete state.paidProof;
      await store.save(state);
      return { allowed: false, source: "blocked", message: "An active subscription is required before the folder can be read.", state };
    }
    state.paidProof = validated;
    const recoveryKey = environment.LICENSE_KEY?.trim();
    if (recoveryKey) state.recoveryKeyFingerprint = recoveryKeyFingerprint(recoveryKey);
    await store.save(state);
    return { allowed: true, source: "remote", state };
  } catch {
    if (state.paidProof && allowsCachedOutage(state.paidProof, state.paidProof.checkedAt, options.now ?? new Date())) {
      return { allowed: true, source: "outage-cache", state };
    }
    return { allowed: false, source: "blocked", message: "Unable to verify access. Check your connection or try again later.", state };
  }
}

export async function recordCompletedTrial(store: StateStore, state: LocalState): Promise<void> {
  if (!state.trialCompleted) {
    state.trialCompleted = true;
    await store.save(state);
  }
}
