import * as XLSX from "xlsx";

// @ts-expect-error cpexcel module does not have dedicated type definitions
import * as cptableModule from "xlsx/dist/cpexcel.full.mjs";

export type DelimiterType = "," | "\t" | ";" | "|";

export type EncodingType = "euc-kr" | "utf-8-bom" | "utf-8";

export type SheetMetadata = {
  name: string;
  rowCount: number;
  colCount: number;
  previewHeaders: string[];
  previewRows: (string | number | boolean | null)[][];
};

export type ParsedExcelFile = {
  fileName: string;
  fileSize: number;
  sheets: SheetMetadata[];
  workbook: XLSX.WorkBook;
};

export type CsvConvertOptions = {
  delimiter: DelimiterType;
  encoding: EncodingType;
  skipBlankRows: boolean;
  rawFormatted: boolean;
};

/**
 * Format raw file size into human-readable string.
 */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Parses an Excel or CSV file into workbook metadata and preview rows.
 */
export async function parseExcelFile(file: File): Promise<ParsedExcelFile> {
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, {
    type: "array",
    cellDates: true,
  });

  const sheets: SheetMetadata[] = workbook.SheetNames.map((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet || !worksheet["!ref"]) {
      return {
        name: sheetName,
        rowCount: 0,
        colCount: 0,
        previewHeaders: [],
        previewRows: [],
      };
    }

    const range = XLSX.utils.decode_range(worksheet["!ref"]);
    const rowCount = range.e.r - range.s.r + 1;
    const colCount = range.e.c - range.s.c + 1;

    // Convert preview slice (first 25 rows)
    const rawData = XLSX.utils.sheet_to_json<(string | number | boolean | null)[]>(worksheet, {
      header: 1,
      blankrows: false,
      raw: false,
      defval: "",
    });

    const previewSlice = rawData.slice(0, 25);
    let previewHeaders: string[] = [];
    let previewRows: (string | number | boolean | null)[][] = [];

    if (previewSlice.length > 0) {
      previewHeaders = (previewSlice[0] ?? []).map((header, idx) =>
        header !== "" && header !== undefined && header !== null
          ? String(header)
          : `열 ${idx + 1}`
      );
      previewRows = previewSlice.slice(1);
    }

    return {
      name: sheetName,
      rowCount,
      colCount,
      previewHeaders,
      previewRows,
    };
  });

  return {
    fileName: file.name,
    fileSize: file.size,
    sheets,
    workbook,
  };
}

/**
 * Converts a worksheet to CSV text with specified delimiter.
 */
export function convertSheetToCsvText(
  worksheet: XLSX.WorkSheet,
  options: { delimiter: DelimiterType; skipBlankRows: boolean; rawFormatted: boolean }
): string {
  const opts: XLSX.Sheet2CSVOpts = {
    FS: options.delimiter,
    blankrows: !options.skipBlankRows,
  };
  if (options.rawFormatted) {
    opts.dateNF = "yyyy-mm-dd hh:mm:ss";
  }
  return XLSX.utils.sheet_to_csv(worksheet, opts);
}

/**
 * Generates a downloadable CSV Blob from text and encoding option.
 */
export function createCsvBlob(csvText: string, encoding: EncodingType): Blob {
  if (encoding === "euc-kr") {
    const encoded = cptableModule.utils.encode(949, csvText);
    return new Blob([encoded], {
      type: "text/csv;charset=euc-kr;",
    });
  }

  if (encoding === "utf-8-bom") {
    // 0xEF, 0xBB, 0xBF BOM for Excel UTF-8 recognition
    return new Blob(["\uFEFF", csvText], {
      type: "text/csv;charset=utf-8;",
    });
  }
  return new Blob([csvText], {
    type: "text/csv;charset=utf-8;",
  });
}

/**
 * Triggers a browser file download.
 */
export function triggerFileDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Generates an appropriate CSV filename from base file name and sheet name.
 */
export function getCsvFileName(
  originalFileName: string,
  sheetName: string,
  isSingleSheet: boolean,
  delimiter: DelimiterType
): string {
  const extension = delimiter === "\t" ? ".tsv" : ".csv";
  const baseName = originalFileName.replace(/\.[^/.]+$/, "");
  if (isSingleSheet) {
    return `${baseName}${extension}`;
  }
  const cleanSheet = sheetName.replace(/[/\\?%*:|"<>]/g, "_");
  return `${baseName}_${cleanSheet}${extension}`;
}
