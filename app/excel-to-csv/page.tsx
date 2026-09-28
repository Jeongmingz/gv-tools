"use client";

import { useId, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  ParsedExcelFile,
  DelimiterType,
  EncodingType,
  parseExcelFile,
  convertSheetToCsvText,
  createCsvBlob,
  triggerFileDownload,
  getCsvFileName,
  formatFileSize,
} from "@/lib/excel-utils";
import { createZipBlob } from "@/lib/zip-utils";
import {
  DEFAULT_INVOICE_TEMPLATE,
  SampleAnalysisResult,
  ColumnMapping,
  analyzeSampleCsv,
  autoMatchColumns,
  generateMappedCsvText,
  createEncodedBlob,
} from "@/lib/template-csv";

const DELIMITER_OPTIONS: { label: string; value: DelimiterType; desc: string }[] = [
  { label: "쉼표 ( , )", value: ",", desc: "표준 CSV" },
  { label: "탭 ( Tab )", value: "\t", desc: "TSV 파일" },
  { label: "세미콜론 ( ; )", value: ";", desc: "유럽 로케일 CSV" },
  { label: "파이프 ( | )", value: "|", desc: "파이프 구분" },
];

export default function ExcelToCsvPage() {
  const [activeTab, setActiveTab] = useState<"template" | "direct">("template");

  // ==========================================
  // TAB 1: Template Mapping Mode State
  // ==========================================
  const [template, setTemplate] = useState<SampleAnalysisResult | null>(DEFAULT_INVOICE_TEMPLATE);
  const [sourceWorkbook, setSourceWorkbook] = useState<ParsedExcelFile | null>(null);
  const [sourceSheetIndex, setSourceSheetIndex] = useState<number>(0);
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [templateStatusMsg, setTemplateStatusMsg] = useState<string | null>(
    "기본 '송장번호 샘플' 세팅이 적용되어 있습니다. 원본 엑셀 파일을 업로드하세요."
  );
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [isTemplateProcessing, setIsTemplateProcessing] = useState(false);

  const sampleFileInputRef = useRef<HTMLInputElement>(null);
  const sourceFileInputRef = useRef<HTMLInputElement>(null);

  // ==========================================
  // TAB 2: Direct Sheet Convert Mode State
  // ==========================================
  const directFileInputId = useId();
  const directFileInputRef = useRef<HTMLInputElement>(null);

  const [excelData, setExcelData] = useState<ParsedExcelFile | null>(null);
  const [activeSheetIndex, setActiveSheetIndex] = useState<number>(0);
  const [isPageDragging, setIsPageDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const [directStatusMessage, setDirectStatusMessage] = useState<string | null>(null);

  // Direct conversion options
  const [delimiter, setDelimiter] = useState<DelimiterType>(",");
  const [encoding, setEncoding] = useState<EncodingType>("utf-8-bom");
  const [skipBlankRows, setSkipBlankRows] = useState<boolean>(true);
  const [rawFormatted, setRawFormatted] = useState<boolean>(true);

  // ==========================================
  // TAB 1 Handlers (Template Mapping Mode)
  // ==========================================
  const handleLoadDefaultTemplate = () => {
    setTemplate(DEFAULT_INVOICE_TEMPLATE);
    setTemplateStatusMsg("'송장번호 샘플.csv' 기본 템플릿(EUC-KR, CRLF)으로 복원되었습니다.");
    setTemplateError(null);

    // If source workbook already exists, re-match
    if (sourceWorkbook) {
      const activeSheet = sourceWorkbook.sheets[sourceSheetIndex];
      const sourceHeaders = activeSheet ? activeSheet.previewHeaders : [];
      setMappings(autoMatchColumns(DEFAULT_INVOICE_TEMPLATE.headers, sourceHeaders));
    }
  };

  const handleSampleFileUpload = async (file: File) => {
    setIsTemplateProcessing(true);
    setTemplateError(null);
    try {
      const result = await analyzeSampleCsv(file);
      setTemplate(result);
      setTemplateStatusMsg(
        `샘플 파일 "${file.name}"의 세팅(인코딩: ${result.encoding.toUpperCase()}, 줄바꿈: ${
          result.lineTerminator === "\r\n" ? "CRLF" : "LF"
        }, 컬럼 ${result.headers.length}개)을 완벽하게 분석했습니다.`
      );

      // If source workbook exists, re-match
      if (sourceWorkbook) {
        const activeSheet = sourceWorkbook.sheets[sourceSheetIndex];
        const sourceHeaders = activeSheet ? activeSheet.previewHeaders : [];
        setMappings(autoMatchColumns(result.headers, sourceHeaders));
      }
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : "샘플 파일 분석 중 오류가 발생했습니다.");
    } finally {
      setIsTemplateProcessing(false);
    }
  };

  const handleSourceExcelUpload = async (file: File) => {
    setIsTemplateProcessing(true);
    setTemplateError(null);
    try {
      const parsed = await parseExcelFile(file);
      if (parsed.sheets.length === 0) {
        throw new Error("엑셀 파일에 시트가 존재하지 않습니다.");
      }
      setSourceWorkbook(parsed);
      setSourceSheetIndex(0);

      // Auto match
      const activeSheet = parsed.sheets[0];
      const templateHeaders = template ? template.headers : DEFAULT_INVOICE_TEMPLATE.headers;
      const initialMappings = autoMatchColumns(templateHeaders, activeSheet.previewHeaders);
      setMappings(initialMappings);

      setTemplateStatusMsg(
        `데이터 파일 "${file.name}"을 불러왔으며, ${templateHeaders.length}개 컬럼에 대해 자동 매핑을 완료했습니다.`
      );
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : "데이터 파일 읽기 중 오류가 발생했습니다.");
    } finally {
      setIsTemplateProcessing(false);
    }
  };

  const handleSheetChangeInTemplateMode = (idx: number) => {
    if (!sourceWorkbook) return;
    setSourceSheetIndex(idx);
    const sheet = sourceWorkbook.sheets[idx];
    const templateHeaders = template ? template.headers : DEFAULT_INVOICE_TEMPLATE.headers;
    setMappings(autoMatchColumns(templateHeaders, sheet.previewHeaders));
  };

  const handleUpdateMapping = (index: number, partial: Partial<ColumnMapping>) => {
    setMappings((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], ...partial };
      return copy;
    });
  };

  const handleDownloadMappedCsv = () => {
    if (!sourceWorkbook || !template) return;

    try {
      const activeSheetMeta = sourceWorkbook.sheets[sourceSheetIndex];
      const worksheet = sourceWorkbook.workbook.Sheets[activeSheetMeta.name];
      if (!worksheet) throw new Error("시트 데이터를 찾을 수 없습니다.");

      // Parse all rows from worksheet
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
        raw: false,
        defval: "",
        blankrows: false,
      });

      const { csvText, rowCount } = generateMappedCsvText(rawRows, mappings, {
        delimiter: template.delimiter,
        lineTerminator: template.lineTerminator,
      });

      const blob = createEncodedBlob(csvText, template.encoding);
      const baseName = sourceWorkbook.fileName.replace(/\.[^/.]+$/, "");
      const outputFileName = `${baseName}_${template.fileName.replace(/\.[^/.]+$/, "")}.csv`;

      triggerFileDownload(blob, outputFileName);
      setTemplateStatusMsg(
        `총 ${rowCount.toLocaleString()}개 행이 포함된 "${outputFileName}" 파일(${template.encoding.toUpperCase()}, ${
          template.lineTerminator === "\r\n" ? "CRLF" : "LF"
        }) 다운로드를 시작했습니다.`
      );
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : "CSV 생성 중 오류가 발생했습니다.");
    }
  };

  // Preview generated rows (top 5 rows)
  const currentSheetPreviewRows = sourceWorkbook?.sheets[sourceSheetIndex]?.previewRows ?? [];
  const currentSheetHeaders = sourceWorkbook?.sheets[sourceSheetIndex]?.previewHeaders ?? [];

  const previewMappedRows = currentSheetPreviewRows.slice(0, 8).map((row) => {
    const rowObj: Record<string, unknown> = {};
    currentSheetHeaders.forEach((h, i) => {
      rowObj[h] = row[i];
    });

    return mappings.map((m) => {
      if (m.sourceType === "column" && m.sourceColumn) {
        return String(rowObj[m.sourceColumn] ?? "");
      }
      if (m.sourceType === "fixed") {
        return m.fixedValue ?? "";
      }
      return "";
    });
  });

  // ==========================================
  // TAB 2 Handlers (Direct Sheet Convert Mode)
  // ==========================================
  const activeSheet = excelData?.sheets[activeSheetIndex] ?? null;

  const handleProcessDirectFile = async (file: File) => {
    setDirectError(null);
    setDirectStatusMessage(null);
    setIsProcessing(true);

    try {
      const parsed = await parseExcelFile(file);
      if (parsed.sheets.length === 0) {
        throw new Error("엑셀 파일에 읽을 수 있는 시트가 없습니다.");
      }
      setExcelData(parsed);
      setActiveSheetIndex(0);
      setDirectStatusMessage(`"${file.name}" 파일을 성공적으로 불러왔습니다.`);
    } catch (err) {
      setDirectError(
        err instanceof Error ? err.message : "파일을 파싱하는 중 오류가 발생했습니다."
      );
      setExcelData(null);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDownloadActiveSheet = () => {
    if (!excelData || !activeSheet) return;

    try {
      const worksheet = excelData.workbook.Sheets[activeSheet.name];
      if (!worksheet) return;

      const csvText = convertSheetToCsvText(worksheet, {
        delimiter,
        skipBlankRows,
        rawFormatted,
      });

      const blob = createCsvBlob(csvText, encoding);
      const isSingleSheet = excelData.sheets.length === 1;
      const fileName = getCsvFileName(
        excelData.fileName,
        activeSheet.name,
        isSingleSheet,
        delimiter
      );

      triggerFileDownload(blob, fileName);
      setDirectStatusMessage(`"${fileName}" 다운로드를 시작했습니다.`);
    } catch (err) {
      setDirectError(
        err instanceof Error ? err.message : "CSV 생성 중 오류가 발생했습니다."
      );
    }
  };

  const handleDownloadAllZip = () => {
    if (!excelData) return;

    try {
      const zipEntries = excelData.sheets.map((sheet) => {
        const worksheet = excelData.workbook.Sheets[sheet.name];
        const csvText = worksheet
          ? convertSheetToCsvText(worksheet, {
              delimiter,
              skipBlankRows,
              rawFormatted,
            })
          : "";

        const blob = createCsvBlob(csvText, encoding);
        const fileName = getCsvFileName(
          excelData.fileName,
          sheet.name,
          false,
          delimiter
        );

        return {
          name: fileName,
          data: blob,
        };
      });

      void Promise.all(
        zipEntries.map(async (entry) => {
          const ab = await entry.data.arrayBuffer();
          return {
            name: entry.name,
            data: new Uint8Array(ab),
          };
        })
      ).then((files) => {
        const zipBlob = createZipBlob(files);
        const baseName = excelData.fileName.replace(/\.[^/.]+$/, "");
        triggerFileDownload(zipBlob, `${baseName}_csv_sheets.zip`);
        setDirectStatusMessage(`"${baseName}_csv_sheets.zip" 압축 다운로드를 완료했습니다.`);
      });
    } catch (err) {
      setDirectError(
        err instanceof Error ? err.message : "ZIP 압축 생성 중 오류가 발생했습니다."
      );
    }
  };

  return (
    <main
      className="relative flex min-h-screen flex-col items-center bg-slate-50 px-4 py-8 sm:py-12 text-slate-900"
      onDragOver={(e) => {
        e.preventDefault();
        if (!isPageDragging) setIsPageDragging(true);
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        if (e.currentTarget === e.target) {
          setIsPageDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsPageDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
          const droppedFile = e.dataTransfer.files[0];
          if (activeTab === "template") {
            if (droppedFile.name.endsWith(".csv")) {
              void handleSampleFileUpload(droppedFile);
            } else {
              void handleSourceExcelUpload(droppedFile);
            }
          } else {
            void handleProcessDirectFile(droppedFile);
          }
        }
      }}
    >
      {/* Full-page drag overlay */}
      {isPageDragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-emerald-600/10 backdrop-blur-sm">
          <div className="rounded-2xl border border-emerald-400 bg-white/95 px-8 py-5 text-center shadow-xl">
            <p className="text-base font-semibold text-emerald-700">
              여기에 파일을 놓으면 자동으로 감지하여 업로드됩니다
            </p>
            <p className="mt-1 text-xs text-slate-500">.xlsx, .xls, .csv 등 지원</p>
          </div>
        </div>
      )}

      <div className="flex w-full max-w-5xl flex-col gap-6">
        {/* Header */}
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-emerald-100 px-3 py-0.5 text-xs font-semibold text-emerald-800">
              클라이언트 100% 안전 처리
            </span>
            <span className="text-xs text-slate-500">외부 서버 전송 없이 브라우저에서 즉시 처리</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
            Excel ➜ CSV 변환 도구
          </h1>
          <p className="text-sm text-slate-600 sm:text-base">
            기준 샘플(송장번호 양식 등)의 <strong>인코딩(EUC-KR/CP949)</strong>과 <strong>CRLF 줄바꿈</strong>,
            <strong>컬럼 구성</strong>을 그대로 복제하여 엑셀 데이터를 옮겨 새 CSV를 생성합니다.
          </p>
        </header>

        {/* Tab Navigation */}
        <div className="flex border-b border-slate-200">
          <button
            type="button"
            onClick={() => setActiveTab("template")}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition ${
              activeTab === "template"
                ? "border-emerald-600 text-emerald-700 bg-emerald-50/50 rounded-t-xl"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600 text-[11px] text-white">
              ★
            </span>
            <span>샘플 템플릿 매핑 변환 (추천)</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("direct")}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold border-b-2 transition ${
              activeTab === "direct"
                ? "border-emerald-600 text-emerald-700 bg-emerald-50/50 rounded-t-xl"
                : "border-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            <span>일반 시트 직접 변환</span>
          </button>
        </div>

        {/* ========================================================= */}
        {/* TAB 1: Template Mapping Mode Content                      */}
        {/* ========================================================= */}
        {activeTab === "template" && (
          <div className="flex flex-col gap-6">
            {/* Status / Error Alerts */}
            {templateError && (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 flex items-center gap-2">
                <span>⚠️</span>
                <span>{templateError}</span>
              </div>
            )}
            {templateStatusMsg && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 text-sm text-emerald-800 flex items-center gap-2">
                <span>✓</span>
                <span>{templateStatusMsg}</span>
              </div>
            )}

            {/* STEP 1 & 2 Cards Grid */}
            <div className="grid gap-6 md:grid-cols-2">
              {/* STEP 1: Reference Sample Template */}
              <div className="flex flex-col justify-between rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="rounded-md bg-amber-100 px-2 py-0.5 text-xs font-bold text-amber-800">
                      STEP 1
                    </span>
                    <button
                      type="button"
                      onClick={handleLoadDefaultTemplate}
                      className="text-xs text-amber-700 font-medium hover:underline"
                    >
                      기본 송장 샘플 적용
                    </button>
                  </div>
                  <h3 className="text-base font-bold text-slate-900">
                    기준 샘플 CSV (파일 세팅 & 컬럼)
                  </h3>
                  <p className="text-xs text-slate-500">
                    이 샘플의 인코딩(EUC-KR), 줄바꿈(CRLF), 구분자, 컬럼 구조를 그대로 복제합니다.
                  </p>

                  {template && (
                    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-slate-800 truncate">
                          📄 {template.fileName}
                        </span>
                        <span className="font-mono text-emerald-700 font-bold bg-emerald-100 px-2 py-0.5 rounded">
                          {template.encoding.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-[11px] text-slate-500">
                        <span className="rounded bg-white px-2 py-0.5 border border-slate-200">
                          줄바꿈: {template.lineTerminator === "\r\n" ? "CRLF (Windows)" : "LF"}
                        </span>
                        <span className="rounded bg-white px-2 py-0.5 border border-slate-200">
                          구분자: &apos;{template.delimiter}&apos;
                        </span>
                      </div>
                      <div className="pt-1">
                        <p className="text-[11px] font-semibold text-slate-600 mb-1">
                          추출된 헤더 컬럼 ({template.headers.length}개):
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {template.headers.map((h, i) => (
                            <span
                              key={i}
                              className="rounded-lg bg-amber-50 border border-amber-200 px-2 py-0.5 text-xs font-medium text-amber-900"
                            >
                              {h}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-4 pt-3 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => sampleFileInputRef.current?.click()}
                    className="w-full rounded-xl border border-slate-300 bg-white py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition"
                  >
                    다른 샘플 CSV 파일 업로드
                  </button>
                  <input
                    ref={sampleFileInputRef}
                    type="file"
                    accept=".csv,.txt"
                    className="sr-only"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        void handleSampleFileUpload(e.target.files[0]);
                        e.target.value = "";
                      }
                    }}
                  />
                </div>
              </div>

              {/* STEP 2: Source Data Excel File */}
              <div className="flex flex-col justify-between rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="rounded-md bg-sky-100 px-2 py-0.5 text-xs font-bold text-sky-800">
                      STEP 2
                    </span>
                    {sourceWorkbook && (
                      <span className="text-xs text-slate-500">
                        {formatFileSize(sourceWorkbook.fileSize)}
                      </span>
                    )}
                  </div>
                  <h3 className="text-base font-bold text-slate-900">
                    데이터 원본 엑셀 파일
                  </h3>
                  <p className="text-xs text-slate-500">
                    실제 옮겨 담을 주문/출고 데이터가 들어있는 엑셀 파일을 업로드하세요.
                  </p>

                  {sourceWorkbook ? (
                    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4 space-y-2">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-slate-800 truncate">
                          📊 {sourceWorkbook.fileName}
                        </span>
                        <span className="text-slate-500">
                          시트 {sourceWorkbook.sheets.length}개
                        </span>
                      </div>

                      {/* Sheet Select if multiple */}
                      {sourceWorkbook.sheets.length > 1 && (
                        <div className="pt-1">
                          <label className="text-[11px] font-semibold text-slate-600">
                            대상 시트 선택:
                          </label>
                          <select
                            value={sourceSheetIndex}
                            onChange={(e) => handleSheetChangeInTemplateMode(Number(e.target.value))}
                            className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-800"
                          >
                            {sourceWorkbook.sheets.map((s, i) => (
                              <option key={i} value={i}>
                                {s.name} ({s.rowCount}행)
                              </option>
                            ))}
                          </select>
                        </div>
                      )}

                      <div className="flex items-center gap-2 text-[11px] text-slate-500 pt-1">
                        <span>
                          전체 행 수: {sourceWorkbook.sheets[sourceSheetIndex]?.rowCount.toLocaleString()}행
                        </span>
                        <span>•</span>
                        <span>
                          컬럼 수: {sourceWorkbook.sheets[sourceSheetIndex]?.previewHeaders.length}개
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div
                      onClick={() => sourceFileInputRef.current?.click()}
                      className="cursor-pointer rounded-2xl border-2 border-dashed border-sky-200 bg-sky-50/50 p-6 text-center hover:bg-sky-50 transition"
                    >
                      <p className="text-sm font-semibold text-sky-900">
                        데이터 엑셀 파일을 클릭하거나 드래그하여 업로드
                      </p>
                      <p className="text-xs text-sky-600 mt-1">.xlsx, .xls 등 지원</p>
                    </div>
                  )}
                </div>

                <div className="mt-4 pt-3 border-t border-slate-100">
                  <button
                    type="button"
                    disabled={isTemplateProcessing}
                    onClick={() => sourceFileInputRef.current?.click()}
                    className="w-full rounded-xl bg-sky-600 py-2 text-xs font-semibold text-white hover:bg-sky-700 transition disabled:opacity-50"
                  >
                    {isTemplateProcessing
                      ? "데이터 분석 중..."
                      : sourceWorkbook
                      ? "다른 데이터 파일로 변경"
                      : "데이터 엑셀 파일 선택"}
                  </button>
                  <input
                    ref={sourceFileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.xlsm,.csv"
                    className="sr-only"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        void handleSourceExcelUpload(e.target.files[0]);
                        e.target.value = "";
                      }
                    }}
                  />
                </div>
              </div>
            </div>

            {/* STEP 3: Column Mapping & Customization */}
            {sourceWorkbook && template && (
              <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pb-2 border-b border-slate-100">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-800">
                        STEP 3
                      </span>
                      <h3 className="text-base font-bold text-slate-900">
                        컬럼 매핑 (기준 템플릿 ↔ 데이터 엑셀)
                      </h3>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      유사한 컬럼명은 자동으로 연결되었습니다. 필요 시 드롭다운 또는 고정값으로 변경하세요.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const activeSheet = sourceWorkbook.sheets[sourceSheetIndex];
                      setMappings(autoMatchColumns(template.headers, activeSheet.previewHeaders));
                    }}
                    className="rounded-xl border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                  >
                    자동 매칭 초기화
                  </button>
                </div>

                {/* Mapping List Table */}
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                        <th className="py-2.5 px-4 text-left font-semibold">
                          템플릿 컬럼 (최종 파일 헤더)
                        </th>
                        <th className="py-2.5 px-4 text-left font-semibold">데이터 연결 방식</th>
                        <th className="py-2.5 px-4 text-left font-semibold">
                          매핑된 원본 컬럼 / 고정값
                        </th>
                        <th className="py-2.5 px-4 text-left font-semibold">미리보기 (1행)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {mappings.map((m, idx) => {
                        const samplePreviewVal = previewMappedRows[0]?.[idx] ?? "-";
                        return (
                          <tr key={idx} className="hover:bg-slate-50/70 transition">
                            <td className="py-3 px-4 font-bold text-slate-900">
                              <span className="rounded-lg bg-amber-50 border border-amber-200 px-2.5 py-1 text-amber-950 font-mono text-xs">
                                {m.templateColumn}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              <select
                                value={m.sourceType}
                                onChange={(e) => {
                                  const newType = e.target.value as "column" | "fixed" | "empty";
                                  handleUpdateMapping(idx, {
                                    sourceType: newType,
                                    sourceColumn: newType === "column" ? currentSheetHeaders[0] : undefined,
                                    fixedValue: newType === "fixed" ? "" : undefined,
                                  });
                                }}
                                className="rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800"
                              >
                                <option value="column">엑셀 컬럼 연결</option>
                                <option value="fixed">고정값 직접 입력</option>
                                <option value="empty">공백 (비워두기)</option>
                              </select>
                            </td>
                            <td className="py-3 px-4">
                              {m.sourceType === "column" && (
                                <select
                                  value={m.sourceColumn ?? ""}
                                  onChange={(e) =>
                                    handleUpdateMapping(idx, { sourceColumn: e.target.value })
                                  }
                                  className="w-full max-w-xs rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 font-medium"
                                >
                                  <option value="">-- 컬럼 선택 --</option>
                                  {currentSheetHeaders.map((col, cIdx) => (
                                    <option key={cIdx} value={col}>
                                      {col}
                                    </option>
                                  ))}
                                </select>
                              )}
                              {m.sourceType === "fixed" && (
                                <input
                                  type="text"
                                  placeholder="고정값 입력 (예: CJ대한통운)"
                                  value={m.fixedValue ?? ""}
                                  onChange={(e) =>
                                    handleUpdateMapping(idx, { fixedValue: e.target.value })
                                  }
                                  className="w-full max-w-xs rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs text-slate-800"
                                />
                              )}
                              {m.sourceType === "empty" && (
                                <span className="text-slate-400 italic text-[11px]">(빈 값으로 생성)</span>
                              )}
                            </td>
                            <td className="py-3 px-4 font-mono text-slate-600 truncate max-w-xs">
                              {samplePreviewVal}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* STEP 4: Preview Table & Download Button */}
            {sourceWorkbook && template && (
              <div className="rounded-3xl border border-emerald-200 bg-emerald-50/50 p-6 shadow-sm space-y-6">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="rounded-md bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white">
                        STEP 4
                      </span>
                      <h3 className="text-lg font-bold text-emerald-950">
                        생성될 CSV 미리보기 및 다운로드
                      </h3>
                    </div>
                    <p className="text-xs text-emerald-800 mt-1">
                      설정: <strong>{template.encoding.toUpperCase()}</strong> 인코딩 ·{" "}
                      <strong>{template.lineTerminator === "\r\n" ? "CRLF" : "LF"}</strong> 줄바꿈 ·{" "}
                      <strong>쉼표 구분</strong> · 지수표기 없는 온전한 송장번호 유지
                    </p>
                  </div>

                  <button
                    type="button"
                    onClick={handleDownloadMappedCsv}
                    className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-6 py-3 text-sm font-bold text-white shadow-md transition hover:bg-emerald-700 active:scale-[0.98]"
                  >
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    <span>새로운 CSV 파일 다운로드</span>
                  </button>
                </div>

                {/* Preview Table */}
                <div className="overflow-x-auto rounded-2xl border border-emerald-200 bg-white">
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="bg-emerald-100/70 text-emerald-900 border-b border-emerald-200">
                        <th className="py-2 px-3 text-center w-10 text-emerald-700 font-mono">#</th>
                        {mappings.map((m, i) => (
                          <th key={i} className="py-2.5 px-3 text-left font-semibold whitespace-nowrap">
                            {m.templateColumn}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 font-mono text-slate-700">
                      {previewMappedRows.map((row, rIdx) => (
                        <tr key={rIdx} className="hover:bg-slate-50 transition">
                          <td className="py-2 px-3 text-center text-slate-400 bg-slate-50/50">
                            {rIdx + 1}
                          </td>
                          {row.map((cell, cIdx) => (
                            <td key={cIdx} className="py-2 px-3 whitespace-nowrap max-w-xs truncate">
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ========================================================= */}
        {/* TAB 2: Direct Sheet Convert Mode Content                  */}
        {/* ========================================================= */}
        {activeTab === "direct" && (
          <div className="flex flex-col gap-6">
            {!excelData && (
              <section className="rounded-3xl border border-dashed border-slate-300 bg-white p-6 sm:p-10 shadow-sm transition hover:border-slate-400">
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => directFileInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      directFileInputRef.current?.click();
                    }
                  }}
                  className="flex cursor-pointer flex-col items-center justify-center gap-4 rounded-2xl border-2 border-dashed border-slate-200 bg-slate-50/50 py-14 text-center hover:bg-slate-50 transition"
                >
                  <p className="text-lg font-semibold text-slate-900">
                    변환할 엑셀 파일을 클릭하거나 드래그하여 업로드하세요
                  </p>
                  <button
                    type="button"
                    disabled={isProcessing}
                    className="rounded-xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm disabled:opacity-50"
                  >
                    {isProcessing ? "분석 중..." : "파일 선택"}
                  </button>
                </div>
                <input
                  ref={directFileInputRef}
                  id={directFileInputId}
                  type="file"
                  accept=".xlsx,.xls,.xlsm,.xlsb,.csv,.tsv"
                  className="sr-only"
                  onChange={(e) => {
                    if (e.target.files && e.target.files[0]) {
                      void handleProcessDirectFile(e.target.files[0]);
                      e.target.value = "";
                    }
                  }}
                />
              </section>
            )}

            {directError && (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                {directError}
              </div>
            )}
            {directStatusMessage && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-4 text-sm text-emerald-800">
                {directStatusMessage}
              </div>
            )}

            {excelData && (
              <div className="flex flex-col gap-6">
                {/* File Header */}
                <div className="flex flex-col gap-4 rounded-3xl border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-4">
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700 font-bold">
                      XLS
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-slate-900">{excelData.fileName}</h2>
                      <p className="text-xs text-slate-500">
                        용량: {formatFileSize(excelData.fileSize)} · 시트 수: {excelData.sheets.length}개
                      </p>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => directFileInputRef.current?.click()}
                      className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      다른 파일
                    </button>
                    <button
                      type="button"
                      onClick={() => setExcelData(null)}
                      className="rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-red-600 hover:bg-red-50"
                    >
                      초기화
                    </button>
                  </div>
                </div>

                {/* Options */}
                <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
                  <h3 className="text-sm font-bold text-slate-900 uppercase tracking-wider mb-4">
                    변환 옵션
                  </h3>
                  <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-slate-700">구분자</label>
                      <select
                        value={delimiter}
                        onChange={(e) => setDelimiter(e.target.value as DelimiterType)}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-sm text-slate-800"
                      >
                        {DELIMITER_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-semibold text-slate-700">인코딩</label>
                      <select
                        value={encoding}
                        onChange={(e) => setEncoding(e.target.value as EncodingType)}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50/50 px-3 py-2 text-sm text-slate-800"
                      >
                        <option value="euc-kr">EUC-KR / CP949 (한국 송장/쇼핑몰 호환)</option>
                        <option value="utf-8-bom">UTF-8 with BOM (엑셀 한글 호환)</option>
                        <option value="utf-8">표준 UTF-8</option>
                      </select>
                    </div>
                    <div className="space-y-2 sm:col-span-2 flex flex-col justify-end">
                      <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={skipBlankRows}
                          onChange={(e) => setSkipBlankRows(e.target.checked)}
                          className="h-4 w-4 rounded border-slate-300 text-emerald-600"
                        />
                        <span>빈 행 건너뛰기</span>
                      </label>
                      <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={rawFormatted}
                          onChange={(e) => setRawFormatted(e.target.checked)}
                          className="h-4 w-4 rounded border-slate-300 text-emerald-600"
                        />
                        <span>날짜/숫자 서식 보존</span>
                      </label>
                    </div>
                  </div>
                </div>

                {/* Direct Action Bar */}
                <div className="rounded-3xl border border-emerald-200 bg-emerald-50/60 p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h3 className="text-base font-bold text-emerald-950">CSV 파일 다운로드</h3>
                    <p className="text-xs text-emerald-700 mt-0.5">
                      선택 시트: {activeSheet?.name} ({activeSheet?.rowCount.toLocaleString()}행)
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2.5">
                    <button
                      type="button"
                      onClick={handleDownloadActiveSheet}
                      className="rounded-2xl bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 transition"
                    >
                      현재 시트 다운로드
                    </button>
                    {excelData.sheets.length > 1 && (
                      <button
                        type="button"
                        onClick={handleDownloadAllZip}
                        className="rounded-2xl bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 transition"
                      >
                        모든 시트 ZIP 다운로드 ({excelData.sheets.length})
                      </button>
                    )}
                  </div>
                </div>

                {/* Sheet Tabs */}
                <div className="flex items-center gap-2 overflow-x-auto pb-2">
                  {excelData.sheets.map((sheet, idx) => (
                    <button
                      key={sheet.name}
                      type="button"
                      onClick={() => setActiveSheetIndex(idx)}
                      className={`whitespace-nowrap rounded-2xl px-4 py-2 text-xs font-semibold transition ${
                        idx === activeSheetIndex
                          ? "bg-slate-900 text-white"
                          : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-100"
                      }`}
                    >
                      {sheet.name} ({sheet.rowCount}행)
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
