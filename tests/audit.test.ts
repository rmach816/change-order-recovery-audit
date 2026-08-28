import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Document, Packer, Paragraph, TextRun } from "docx";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { auditFolder } from "../src/audit.js";

function hash(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

test("finds the five fixed exposure types without modifying source files", async () => {
  const root = await mkdtemp(join(tmpdir(), "change-order-audit-"));
  try {
    const records = [
      "Change Order CO-101 | 2026-06-10 | Approved by owner | $12,500.00",
      "Change Order CO-102 | 2026-01-10 | Pending approval | amount TBD",
      "Change Order CO-103 | 2026-05-01 | Approved | $4,200.00",
      "Change Order CO-103 | 2026-05-03 | Rejected by client | $4,200.00",
      "Change Order CO-104 | 2026-07-01 | Approved | $3,000.00 | Invoiced on pay app #8"
    ].join("\n");
    const path = join(root, "change-order-log.csv");
    await writeFile(path, records, "utf8");
    const before = hash(await readFile(path));

    const result = await auditFolder(root, { asOfDate: "2026-08-27", agingDays: 30 });
    const keys = new Set(result.findings.map((finding) => `${finding.changeOrderId}:${finding.type}`));

    assert.equal(result.detectedRecords, 4);
    assert.ok(keys.has("101:apparently_unbilled") || keys.has("CO-101:apparently_unbilled"));
    assert.ok(keys.has("102:missing_price") || keys.has("CO-102:missing_price"));
    assert.ok(keys.has("102:missing_approval") || keys.has("CO-102:missing_approval"));
    assert.ok(keys.has("102:aging_pending") || keys.has("CO-102:aging_pending"));
    assert.ok(keys.has("103:status_conflict") || keys.has("CO-103:status_conflict"));
    assert.ok(!keys.has("104:apparently_unbilled") && !keys.has("CO-104:apparently_unbilled"));
    assert.ok(result.findings.every((finding) => finding.citations[0]?.path === "change-order-log.csv"));
    assert.equal(hash(await readFile(path)), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extracts rows from XLSX sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "change-order-xlsx-"));
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Change Log");
    sheet.addRow(["ID", "Date", "Status", "Amount", "Billing"]);
    sheet.addRow(["CO-220", "2026-02-01", "Approved", "$8,500.00", "Not invoiced"]);
    await workbook.xlsx.writeFile(join(root, "change-orders.xlsx"));

    const result = await auditFolder(root, { asOfDate: "2026-08-27" });
    const finding = result.findings.find((item) => item.type === "apparently_unbilled");
    assert.ok(finding);
    assert.equal(finding.citations[0]?.locator, "Sheet Change Log");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extracts cited records from text-readable PDF and DOCX sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "change-order-documents-"));
  try {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage();
    page.drawText("Change Order CO-330 | Approved by owner | $6,400.00 | Not invoiced", {
      x: 40,
      y: 700,
      font,
      size: 12
    });
    await writeFile(join(root, "approved-change.pdf"), await pdf.save());

    const doc = new Document({
      sections: [{
        children: [new Paragraph({
          children: [new TextRun("Change Order CO-331 | 2026-01-15 | Pending approval | amount TBD")]
        })]
      }]
    });
    await writeFile(join(root, "pending-change.docx"), await Packer.toBuffer(doc));

    const result = await auditFolder(root, { asOfDate: "2026-08-27" });
    const pdfFinding = result.findings.find(
      (item) => item.changeOrderId.includes("330") && item.type === "apparently_unbilled"
    );
    const docxFinding = result.findings.find(
      (item) => item.changeOrderId.includes("331") && item.type === "aging_pending"
    );
    assert.equal(pdfFinding?.citations[0]?.locator, "Page 1");
    assert.equal(docxFinding?.citations[0]?.path, "pending-change.docx");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid audit options", async () => {
  const root = await mkdtemp(join(tmpdir(), "change-order-options-"));
  try {
    await assert.rejects(() => auditFolder(root, { agingDays: 2 }), /7 to 365/);
    await assert.rejects(() => auditFolder(root, { asOfDate: "08-27-2026" }), /YYYY-MM-DD/);
    await assert.rejects(() => auditFolder(root, { asOfDate: "2026-02-31" }), /valid calendar date/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
