export const SUPPORTED_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".pdf",
  ".docx",
  ".xlsx"
]);

export const MAX_FILES = 100;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const MAX_TEXT_CHARACTERS = 10_000;
export const MAX_RESPONSE_CHARACTERS = 80_000;
export const MAX_RECORDS = 500;
export const MAX_FINDINGS = 200;
