// @ts-expect-error cpexcel module does not have dedicated type definitions
import * as cptableModule from "xlsx/dist/cpexcel.full.mjs";

export type EncodingType = "euc-kr" | "utf-8-bom" | "utf-8";
export type LineTerminatorType = "\r\n" | "\n";
export type DelimiterType = "," | "\t" | ";" | "|";

export type ColumnMappingType = "column" | "fixed" | "empty";

export type ColumnMapping = {
  templateColumn: string;
  sourceType: ColumnMappingType;
  sourceColumn?: string;
  fixedValue?: string;
};

export type SampleAnalysisResult = {
  fileName: string;
  encoding: EncodingType;
  lineTerminator: LineTerminatorType;
  delimiter: DelimiterType;
  headers: string[];
  rawFirstLine: string;
  sampleRows: string[][];
};

/**
 * Built-in default preset based on '송장번호 샘플.csv'
 */
export const DEFAULT_INVOICE_TEMPLATE: SampleAnalysisResult = {
  fileName: "송장번호 샘플.csv",
  encoding: "euc-kr",
  lineTerminator: "\r\n",
  delimiter: ",",
  headers: ["주문번호", "배송지번호", "PP코드", "배송업체", "송장번호"],
  rawFirstLine: "주문번호,배송지번호,PP코드,배송업체,송장번호",
  sampleRows: [["20241026-1506A", "1", "OB034B", "CJ대한통운", "597000123456"]],
};

/**
 * Decode Uint8Array buffer based on detected or specified encoding.
 */
export function decodeBuffer(bytes: Uint8Array, preferredEncoding?: EncodingType): { text: string; encoding: EncodingType } {
  // Check UTF-8 BOM: EF BB BF
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = new TextDecoder("utf-8").decode(bytes.subarray(3));
    return { text, encoding: "utf-8-bom" };
  }

  if (preferredEncoding === "euc-kr") {
    try {
      const decoded = cptableModule.utils.decode(949, bytes);
      return { text: decoded, encoding: "euc-kr" };
    } catch {
      // fallback
    }
  }

  // Try UTF-8 first (strict)
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { text, encoding: "utf-8" };
  } catch {
    // If invalid UTF-8, it is CP949 / EUC-KR
    try {
      const decoded = cptableModule.utils.decode(949, bytes);
      return { text: decoded, encoding: "euc-kr" };
    } catch {
      const text = new TextDecoder("utf-8").decode(bytes);
      return { text, encoding: "utf-8" };
    }
  }
}

/**
 * Analyzes an uploaded sample CSV file to extract its encoding, line terminator, delimiter, and headers.
 */
export async function analyzeSampleCsv(file: File): Promise<SampleAnalysisResult> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  const { text, encoding } = decodeBuffer(bytes);

  // Detect Line Terminator
  const lineTerminator: LineTerminatorType = text.includes("\r\n") ? "\r\n" : "\n";

  // Split lines
  const lines = text
    .split(lineTerminator)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    throw new Error("샘플 CSV 파일이 비어 있습니다.");
  }

  const headerLine = lines[0];

  // Detect Delimiter
  const delimiters: DelimiterType[] = [",", "\t", ";", "|"];
  let bestDelimiter: DelimiterType = ",";
  let maxCount = -1;
  for (const delim of delimiters) {
    const count = headerLine.split(delim).length - 1;
    if (count > maxCount) {
      maxCount = count;
      bestDelimiter = delim;
    }
  }

  // Parse Headers
  const headers = parseCsvLine(headerLine, bestDelimiter);

  // Sample Rows (up to 5 rows)
  const sampleRows: string[][] = [];
  for (let i = 1; i < Math.min(lines.length, 6); i++) {
    sampleRows.push(parseCsvLine(lines[i], bestDelimiter));
  }

  return {
    fileName: file.name,
    encoding,
    lineTerminator,
    delimiter: bestDelimiter,
    headers,
    rawFirstLine: headerLine,
    sampleRows,
  };
}

/**
 * Simple CSV line parser respecting quotes.
 */
export function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let cur = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += char;
    }
  }
  result.push(cur.trim());
  return result.map((col) => col.replace(/^"(.*)"$/, "$1"));
}

/**
 * Auto-matches template columns with source Excel columns based on name similarity.
 */
export function autoMatchColumns(
  templateHeaders: string[],
  sourceHeaders: string[]
): ColumnMapping[] {
  const normalize = (s: string) => s.toLowerCase().replace(/[^0-9a-z가-힣]/g, "");

  const aliases: Record<string, string[]> = {
    주문번호: ["주문번호", "주문 번호", "orderno", "order_no", "order", "주문고유번호"],
    배송지번호: ["배송지번호", "배송번호", "배송지", "배송", "수령자번호"],
    pp코드: ["pp코드", "품번", "상품코드", "자사코드", "모델코드", "itemcode"],
    배송업체: ["배송업체", "택배사", "배송사", "택배", "배송업체명"],
    송장번호: ["송장번호", "송장", "운송장번호", "운송장", "tracking", "trackingnumber", "바코드"],
  };

  return templateHeaders.map((tHeader) => {
    const tNorm = normalize(tHeader);

    // 1. Exact match
    const exact = sourceHeaders.find((s) => normalize(s) === tNorm);
    if (exact) {
      return { templateColumn: tHeader, sourceType: "column", sourceColumn: exact };
    }

    // 2. Alias match
    const aliasList = aliases[tNorm] ?? [];
    const aliasMatch = sourceHeaders.find((s) => {
      const sNorm = normalize(s);
      return aliasList.some((alias) => sNorm.includes(alias) || alias.includes(sNorm));
    });
    if (aliasMatch) {
      return { templateColumn: tHeader, sourceType: "column", sourceColumn: aliasMatch };
    }

    // 3. Substring match
    const subMatch = sourceHeaders.find((s) => {
      const sNorm = normalize(s);
      return sNorm.includes(tNorm) || tNorm.includes(sNorm);
    });
    if (subMatch) {
      return { templateColumn: tHeader, sourceType: "column", sourceColumn: subMatch };
    }

    // 4. Default smart fixed values for common invoice fields
    if (tNorm.includes("배송지번호")) {
      return { templateColumn: tHeader, sourceType: "fixed", fixedValue: "1" };
    }
    if (tNorm.includes("배송업체")) {
      return { templateColumn: tHeader, sourceType: "fixed", fixedValue: "CJ대한통운" };
    }

    return { templateColumn: tHeader, sourceType: "empty" };
  });
}

/**
 * Formats a value safely for CSV, preserving long digits without scientific notation.
 */
export function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";

  // If number or numeric string, format without scientific notation
  if (typeof value === "number") {
    // If it's a large integer (like tracking number), prevent exponential notation
    if (Number.isInteger(value)) {
      return value.toLocaleString("fullwide", { useGrouping: false });
    }
    return String(value);
  }

  const str = String(value).trim();
  // Check if string is exponential notation (e.g. 5.97E+11)
  if (/^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/.test(str)) {
    try {
      const num = Number(str);
      if (!Number.isNaN(num) && Number.isInteger(num)) {
        return num.toLocaleString("fullwide", { useGrouping: false });
      }
    } catch {
      // keep original
    }
  }

  return str;
}

/**
 * Escapes a cell for CSV according to RFC 4180.
 */
export function escapeCsvCell(value: string, delimiter: string): string {
  const needsQuotes =
    value.includes(delimiter) ||
    value.includes('"') ||
    value.includes("\n") ||
    value.includes("\r");

  if (needsQuotes) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Builds the mapped CSV string from source rows and mappings.
 */
export function generateMappedCsvText(
  sourceRows: Record<string, unknown>[],
  mappings: ColumnMapping[],
  options: {
    delimiter: DelimiterType;
    lineTerminator: LineTerminatorType;
  }
): { csvText: string; rowCount: number } {
  const headers = mappings.map((m) => escapeCsvCell(m.templateColumn, options.delimiter));
  const lines: string[] = [headers.join(options.delimiter)];

  let rowCount = 0;

  for (const row of sourceRows) {
    // Check if row is entirely empty
    const cells = mappings.map((m) => {
      if (m.sourceType === "column" && m.sourceColumn) {
        return formatCellValue(row[m.sourceColumn]);
      }
      if (m.sourceType === "fixed") {
        return m.fixedValue ?? "";
      }
      return "";
    });

    const hasAnyValue = cells.some((c) => c !== "");
    if (!hasAnyValue) continue;

    const line = cells
      .map((c) => escapeCsvCell(c, options.delimiter))
      .join(options.delimiter);
    lines.push(line);
    rowCount++;
  }

  const csvText = lines.join(options.lineTerminator) + options.lineTerminator;
  return { csvText, rowCount };
}

/**
 * Creates a downloadable Blob with the specified encoding.
 */
export function createEncodedBlob(csvText: string, encoding: EncodingType): Blob {
  if (encoding === "euc-kr") {
    const encoded = cptableModule.utils.encode(949, csvText);
    return new Blob([encoded], {
      type: "text/csv;charset=euc-kr;",
    });
  }

  if (encoding === "utf-8-bom") {
    return new Blob(["\uFEFF", csvText], {
      type: "text/csv;charset=utf-8;",
    });
  }

  // Standard UTF-8
  return new Blob([csvText], {
    type: "text/csv;charset=utf-8;",
  });
}
