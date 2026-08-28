import { MAX_FINDINGS, MAX_RECORDS } from "./limits.js";
import { inventoryProject } from "./inventory.js";
import type {
  AuditResult,
  Citation,
  Confidence,
  DetectedRecord,
  ExtractedSource,
  Finding,
  FindingType
} from "./types.js";

const CHANGE_MARKER = /\b(?:change\s+(?:order|request|event)|potential\s+change\s+order|extra\s+work|(?:pco|cor|co)[-\s#:]?\d+)\b/i;
const ID_PATTERN = /\b(change\s+(?:order|request|event)|potential\s+change\s+order|pco|cor|co)\s*(?:no\.?|number|#|:|-)?\s*([a-z0-9][a-z0-9._-]{0,20})\b/gi;
const INVALID_IDS = new Set(["is", "was", "status", "request", "order", "date", "for", "to"]);
const AMOUNT_PATTERN = /(?:\$|usd\s*)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.\d{2})?|[0-9]+(?:\.\d{2})?)/gi;
const ISO_DATE_PATTERN = /\b(20\d{2})-(0[1-9]|1[0-2])-([0-2]\d|3[01])\b/g;
const US_DATE_PATTERN = /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(20\d{2})\b/g;
const APPROVAL_PATTERN = /\b(?:approved|authorized|executed|fully\s+signed|signed\s+by\s+(?:owner|client|gc))\b/i;
const NEGATED_APPROVAL_PATTERN = /\b(?:not\s+approved|unapproved|not\s+signed|unsigned|approval\s+pending|awaiting\s+(?:approval|signature))\b/i;
const PENDING_PATTERN = /\b(?:pending|open|submitted|awaiting|unsigned|unapproved|under\s+review)\b/i;
const REJECTED_PATTERN = /\b(?:rejected|denied|void|cancelled|canceled)\b/i;
const BILLING_PATTERN = /\b(?:billed|invoiced|included\s+in\s+(?:invoice|pay\s*app)|pay\s*app\s*#?\s*\d+)\b/i;
const NEGATED_BILLING_PATTERN = /\b(?:unbilled|not\s+billed|not\s+invoiced|excluded\s+from\s+(?:invoice|pay\s*app))\b/i;

interface AuditOptions {
  asOfDate?: string;
  agingDays?: number;
}

function snippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 320);
}

function citation(source: ExtractedSource, context: string): Citation {
  return {
    path: source.relativePath,
    locator: source.locator,
    snippet: snippet(context)
  };
}

function normalizeId(id: string): string {
  return id.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function displayId(rawId: string): string {
  return rawId.toUpperCase();
}

function findIds(line: string): string[] {
  const ids: string[] = [];
  for (const match of line.matchAll(ID_PATTERN)) {
    const raw = match[2];
    if (!raw || INVALID_IDS.has(raw.toLowerCase()) || !/\d/.test(raw)) continue;
    const alreadyPrefixed = /^(?:pco|cor|co)[-_.]?\d/i.test(raw);
    ids.push(alreadyPrefixed ? raw : `CO-${raw}`);
  }
  return [...new Set(ids)];
}

function findAmounts(text: string): number[] {
  const values: number[] = [];
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const raw = match[1];
    if (!raw) continue;
    const value = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) values.push(value);
  }
  return values;
}

function findDates(text: string): string[] {
  const dates: string[] = [];
  for (const match of text.matchAll(ISO_DATE_PATTERN)) dates.push(match[0]);
  for (const match of text.matchAll(US_DATE_PATTERN)) {
    const month = match[1]?.padStart(2, "0");
    const day = match[2]?.padStart(2, "0");
    const year = match[3];
    if (year && month && day) dates.push(`${year}-${month}-${day}`);
  }
  return [...new Set(dates)].filter((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));
}

function statusLabels(text: string): string[] {
  const labels: string[] = [];
  if (APPROVAL_PATTERN.test(text) && !NEGATED_APPROVAL_PATTERN.test(text)) labels.push("approved");
  if (PENDING_PATTERN.test(text) || NEGATED_APPROVAL_PATTERN.test(text)) labels.push("pending");
  if (REJECTED_PATTERN.test(text)) labels.push("rejected");
  if (BILLING_PATTERN.test(text) && !NEGATED_BILLING_PATTERN.test(text)) labels.push("billed");
  if (NEGATED_BILLING_PATTERN.test(text)) labels.push("unbilled");
  return labels;
}

function mergeRecord(target: DetectedRecord, context: string, source: ExtractedSource): void {
  target.amounts.push(...findAmounts(context));
  target.dates.push(...findDates(context));
  target.statuses.push(...statusLabels(context));
  target.hasApprovalEvidence ||= APPROVAL_PATTERN.test(context) && !NEGATED_APPROVAL_PATTERN.test(context);
  target.hasPendingEvidence ||= PENDING_PATTERN.test(context) || NEGATED_APPROVAL_PATTERN.test(context);
  target.hasBillingEvidence ||= BILLING_PATTERN.test(context) && !NEGATED_BILLING_PATTERN.test(context);
  target.citations.push(citation(source, context));
}

export function detectRecords(sources: ExtractedSource[]): DetectedRecord[] {
  const records = new Map<string, DetectedRecord>();
  for (const source of sources) {
    const lines = source.text.split(/\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!CHANGE_MARKER.test(line)) continue;
      // Keep evidence scoped to the matching row/line so neighboring log entries cannot contaminate it.
      const context = line;
      const ids = findIds(line);
      if (ids.length === 0) {
        const filenameMatch = source.relativePath.match(/\b(?:pco|cor|co)[-_ ]?(\d{1,8})\b/i);
        if (filenameMatch?.[1]) ids.push(`CO-${filenameMatch[1]}`);
      }
      for (const rawId of ids) {
        if (records.size >= MAX_RECORDS && !records.has(normalizeId(rawId))) continue;
        const key = normalizeId(rawId);
        const current = records.get(key) ?? {
          key,
          displayId: displayId(rawId),
          amounts: [],
          dates: [],
          statuses: [],
          hasApprovalEvidence: false,
          hasPendingEvidence: false,
          hasBillingEvidence: false,
          citations: []
        };
        mergeRecord(current, context, source);
        records.set(key, current);
      }
    }
  }
  return [...records.values()].map((record) => ({
    ...record,
    amounts: [...new Set(record.amounts)],
    dates: [...new Set(record.dates)],
    statuses: [...new Set(record.statuses)],
    citations: record.citations.slice(0, 5)
  }));
}

function makeFinding(
  record: DetectedRecord,
  type: FindingType,
  reason: string,
  confidence: Confidence,
  humanCheck: string
): Finding {
  return {
    type,
    changeOrderId: record.displayId,
    reason,
    confidence,
    humanCheck,
    citations: record.citations.slice(0, 3)
  };
}

function ageInDays(record: DetectedRecord, asOf: Date): number | null {
  const dates = record.dates
    .map((value) => new Date(`${value}T00:00:00Z`))
    .filter((date) => !Number.isNaN(date.valueOf()) && date <= asOf)
    .sort((a, b) => b.valueOf() - a.valueOf());
  const latest = dates[0];
  return latest ? Math.floor((asOf.valueOf() - latest.valueOf()) / 86_400_000) : null;
}

export function buildFindings(records: DetectedRecord[], asOf: Date, agingDays: number): Finding[] {
  const findings: Finding[] = [];
  for (const record of records) {
    if (record.amounts.length === 0) {
      findings.push(makeFinding(record, "missing_price", "No monetary amount was detected in the cited record context.", "medium", "Confirm whether pricing exists in another file or is still required."));
    }
    if (!record.hasApprovalEvidence) {
      findings.push(makeFinding(record, "missing_approval", "No affirmative approval or signature evidence was detected.", "medium", "Confirm the current approval state and locate the signed authorization if it exists."));
    }
    const age = ageInDays(record, asOf);
    if (record.hasPendingEvidence && age !== null && age >= agingDays) {
      findings.push(makeFinding(record, "aging_pending", `Pending evidence is ${age} days old using the latest detected date.`, "high", "Verify whether the record is still open and who owns the next action."));
    }
    const statusSet = new Set(record.statuses);
    if ((statusSet.has("approved") && statusSet.has("rejected")) || (statusSet.has("approved") && statusSet.has("pending"))) {
      findings.push(makeFinding(record, "status_conflict", `Cited sources contain conflicting status signals: ${[...statusSet].join(", ")}.`, "high", "Resolve the authoritative current status and preserve the supporting record."));
    }
    if (record.hasApprovalEvidence && record.amounts.length > 0 && !record.hasBillingEvidence) {
      findings.push(makeFinding(record, "apparently_unbilled", "Approval and an amount were detected, but no billing or invoice evidence was found in the selected folder.", "medium", "Check the accounting or pay-application system before treating this as unbilled."));
    }
  }
  const order: Record<FindingType, number> = {
    status_conflict: 0,
    apparently_unbilled: 1,
    aging_pending: 2,
    missing_approval: 3,
    missing_price: 4
  };
  return findings
    .sort((a, b) => order[a.type] - order[b.type] || a.changeOrderId.localeCompare(b.changeOrderId))
    .slice(0, MAX_FINDINGS);
}

export async function auditFolder(projectRoot: string, options: AuditOptions = {}): Promise<AuditResult> {
  const agingDays = options.agingDays ?? 30;
  if (!Number.isInteger(agingDays) || agingDays < 7 || agingDays > 365) {
    throw new Error("agingDays must be a whole number from 7 to 365");
  }
  const asOfText = options.asOfDate ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfText)) throw new Error("asOfDate must use YYYY-MM-DD");
  const asOf = new Date(`${asOfText}T23:59:59Z`);
  if (Number.isNaN(asOf.valueOf()) || asOf.toISOString().slice(0, 10) !== asOfText) {
    throw new Error("asOfDate is not a valid calendar date");
  }

  const inventory = await inventoryProject(projectRoot);
  const records = detectRecords(inventory.sources);
  const findings = buildFindings(records, asOf, agingDays);
  const truncatedSources = [...new Set(inventory.sources.filter((item) => item.truncated).map((item) => item.relativePath))];
  const limitations = [
    "The audit checks only supported text found in the selected folder; it cannot see accounting systems, email, cloud drives, oral directives, or omitted records.",
    "Detected status, amount, and billing language may be historical or contextual. Open the cited source and confirm the current state.",
    "A clean result is not a certification, and a finding is not proof of entitlement or recoverability."
  ];
  if (inventory.limitReached) limitations.push("The scan stopped at an input limit, so the result is incomplete.");
  if (records.length >= MAX_RECORDS) limitations.push(`Detected records were capped at ${MAX_RECORDS}.`);
  if (findings.length >= MAX_FINDINGS) limitations.push(`Findings were capped at ${MAX_FINDINGS}.`);

  return {
    project: inventory.project,
    auditedAt: new Date().toISOString(),
    asOfDate: asOfText,
    agingDays,
    scannedSources: inventory.scannedFiles,
    skippedSources: inventory.skipped,
    truncatedSources,
    detectedRecords: records.length,
    findings,
    limitations,
    humanReviewRequired: "Human review is required before pricing, billing, notice, approval, collection, or legal action."
  };
}
