import { extname } from "node:path";

import ExcelJS from "exceljs";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

import { MAX_TEXT_CHARACTERS } from "./limits.js";
import type { ExtractedSource } from "./types.js";

export interface ExtractInput {
  relativePath: string;
  buffer: Buffer;
  modifiedAt: string;
}

function bounded(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\u0000/g, "").replace(/\r\n/g, "\n").trim();
  if (normalized.length <= MAX_TEXT_CHARACTERS) {
    return { text: normalized, truncated: false };
  }
  return {
    text: normalized.slice(0, MAX_TEXT_CHARACTERS),
    truncated: true
  };
}

function source(
  input: ExtractInput,
  extension: string,
  text: string,
  locator?: string
): ExtractedSource {
  const limited = bounded(text);
  return {
    relativePath: input.relativePath,
    extension,
    text: limited.text,
    locator,
    truncated: limited.truncated,
    modifiedAt: input.modifiedAt
  };
}

async function extractPdf(input: ExtractInput): Promise<ExtractedSource[]> {
  const parser = new PDFParse({
    data: new Uint8Array(input.buffer),
    stopAtErrors: true,
    isEvalSupported: false,
    useWasm: false
  });
  try {
    const result = await parser.getText();
    if (!result.text.trim()) {
      throw new Error("PDF contains no text layer; image-only PDFs are not supported");
    }
    return result.pages.map((page) =>
      source(input, ".pdf", page.text, `Page ${page.num}`)
    );
  } finally {
    await parser.destroy();
  }
}

async function extractDocx(input: ExtractInput): Promise<ExtractedSource[]> {
  const result = await mammoth.extractRawText({ buffer: input.buffer });
  if (!result.value.trim()) {
    throw new Error("DOCX contains no readable text");
  }
  return [source(input, ".docx", result.value)];
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("text" in value && typeof value.text === "string") return value.text;
    if ("result" in value && value.result !== undefined) return String(value.result);
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("");
    }
  }
  return String(value);
}

async function extractXlsx(input: ExtractInput): Promise<ExtractedSource[]> {
  const workbook = new ExcelJS.Workbook();
  const bytes = input.buffer.buffer.slice(
    input.buffer.byteOffset,
    input.buffer.byteOffset + input.buffer.byteLength
  ) as ArrayBuffer;
  // ExcelJS's published Buffer type predates generic Node Buffers; runtime input is a normal Buffer.
  await workbook.xlsx.load(Buffer.from(bytes) as never);
  const sources: ExtractedSource[] = [];
  workbook.eachSheet((worksheet) => {
    const lines: string[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const values = row.values;
      const cells = Array.isArray(values)
        ? values.slice(1).map((value) => cellText(value as ExcelJS.CellValue))
        : [];
      lines.push(`[Row ${rowNumber}] ${cells.join(" | ")}`);
    });
    if (lines.length > 0) {
      sources.push(source(input, ".xlsx", lines.join("\n"), `Sheet ${worksheet.name}`));
    }
  });
  if (sources.length === 0) throw new Error("XLSX contains no readable cells");
  return sources;
}

export async function extractSources(input: ExtractInput): Promise<ExtractedSource[]> {
  const extension = extname(input.relativePath).toLowerCase();
  switch (extension) {
    case ".pdf":
      return extractPdf(input);
    case ".docx":
      return extractDocx(input);
    case ".xlsx":
      return extractXlsx(input);
    case ".txt":
    case ".md":
    case ".csv":
    case ".json":
      return [source(input, extension, input.buffer.toString("utf8"))];
    default:
      throw new Error(`Unsupported file type: ${extension || "no extension"}`);
  }
}
