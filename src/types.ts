export type FindingType =
  | "missing_price"
  | "missing_approval"
  | "aging_pending"
  | "status_conflict"
  | "apparently_unbilled";

export type Confidence = "high" | "medium" | "low";

export interface Citation {
  path: string;
  locator?: string;
  snippet: string;
}
export interface ExtractedSource {
  relativePath: string;
  extension: string;
  text: string;
  locator?: string;
  truncated: boolean;
  modifiedAt: string;
}

export interface SkippedSource {
  path: string;
  reason: string;
}

export interface DetectedRecord {
  key: string;
  displayId: string;
  amounts: number[];
  dates: string[];
  statuses: string[];
  hasApprovalEvidence: boolean;
  hasPendingEvidence: boolean;
  hasBillingEvidence: boolean;
  citations: Citation[];
}

export interface Finding {
  type: FindingType;
  changeOrderId: string;
  reason: string;
  confidence: Confidence;
  humanCheck: string;
  citations: Citation[];
}

export interface AuditResult {
  project: string;
  auditedAt: string;
  asOfDate: string;
  agingDays: number;
  scannedSources: number;
  skippedSources: SkippedSource[];
  truncatedSources: string[];
  detectedRecords: number;
  findings: Finding[];
  limitations: string[];
  humanReviewRequired: string;
}
