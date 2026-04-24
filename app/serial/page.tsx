"use client";

import { ChangeEvent, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { STORE_DATA } from "@/lib/store-data";

const BASE_REQUIRED_COLUMNS = ["시리얼", "품번", "수취인/주문예약일", "주소/주문매장코드", "매장코드"] as const;
const DATA_REQUIRED_COLUMNS = [
  "상품코드",
  "주문자",
  "수령자",
  "배송지주소",
  "판매처",
  "주문번호",
  "C/S 내역",
] as const;
type BaseRow = Record<string, unknown>;
type DataRow = Record<string, unknown>;

type ParsedWorkbook = {
  fileName: string;
  workbook: XLSX.WorkBook;
  sheetName: string;
  rows: Record<string, unknown>[];
};

type MatchIssue = {
  rowNumber: number;
  reason: string;
  productCode: string;
  recipient: string;
  storeCode: string;
};

type MatchPreview = {
  rowNumber: number;
  productCode: string;
  recipient: string;
  address: string;
  serial: string;
  storeName: string;
  seller: string;
  orderNumber: string;
};

type ProcessResult = {
  fileName: string;
  workbook: XLSX.WorkBook;
  matchedCount: number;
  issueCount: number;
  previews: MatchPreview[];
  issues: MatchIssue[];
};

type StoreProfile = {
  code: string;
  name: string;
  branchCompact: string;
  chainCompact: string;
  aliases: string[];
};

type CandidateScore = {
  candidate: DataRow;
  serial: string;
  score: number;
  recipientMatched: boolean;
  addressMatched: boolean;
  storeMatched: boolean;
};

function normalizeValue(value: unknown) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function normalizeCompact(value: unknown) {
  return normalizeValue(value).replace(/[^0-9a-z가-힣]/g, "");
}

function normalizeCode(value: unknown) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.replace(/^0+/, "") || digits;
}

function includesEitherWay(left: string, right: string) {
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
}

function extractSerial(detail: unknown) {
  const text = String(detail ?? "");
  const matched = text.match(/\[시리얼(?:번호|파일)\]\s*([^\s\]]+)/);
  return matched?.[1]?.trim() ?? "";
}

function extractNameTokens(value: unknown) {
  const source = String(value ?? "").trim();
  if (!source) return [];

  const tokens = new Set<string>();
  const compactSource = normalizeCompact(source);
  if (compactSource) tokens.add(compactSource);

  const outer = source.replace(/\([^)]*\)/g, " ").trim();
  const outerCompact = normalizeCompact(outer);
  if (outerCompact) tokens.add(outerCompact);

  const innerMatches = [...source.matchAll(/\(([^)]*)\)/g)];
  innerMatches.forEach((match) => {
    const compact = normalizeCompact(match[1]);
    if (compact) tokens.add(compact);
  });

  source
    .split(/[(/,]/)
    .map((part) => normalizeCompact(part))
    .filter(Boolean)
    .forEach((part) => tokens.add(part));

  return [...tokens];
}

function getBranchName(storeName: string) {
  const cleaned = storeName.replace(/^\([^)]*\)/, "").trim();
  const matched = cleaned.match(/([가-힣a-zA-Z0-9]+점)$/);
  return matched?.[1] ?? "";
}

function getChainName(storeName: string) {
  const cleaned = storeName.replace(/^\([^)]*\)/, "").trim();
  const chains = ["현대백화점", "신세계백화점", "롯데백화점", "갤러리아", "현대", "신세계", "롯데"];
  return chains.find((chain) => cleaned.includes(chain)) ?? "";
}

function buildStoreProfile(code: string, name: string): StoreProfile {
  const cleaned = name.replace(/^\([^)]*\)/, "").trim();
  const branch = getBranchName(cleaned);
  const chain = getChainName(cleaned);

  const aliasSet = new Set<string>();
  [name, cleaned, branch, chain].forEach((value) => {
    const compact = normalizeCompact(value);
    if (compact) aliasSet.add(compact);
  });

  return {
    code,
    name,
    branchCompact: normalizeCompact(branch),
    chainCompact: normalizeCompact(chain),
    aliases: [...aliasSet],
  };
}

async function readWorkbook(file: File): Promise<ParsedWorkbook> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  return {
    fileName: file.name,
    workbook,
    sheetName,
    rows,
  };
}

function assertColumns(rows: Record<string, unknown>[], requiredColumns: readonly string[], label: string) {
  if (!rows.length) {
    throw new Error(`${label} 파일에 데이터가 없습니다.`);
  }

  const headers = Object.keys(rows[0] ?? {});
  const missing = requiredColumns.filter((column) => !headers.includes(column));

  if (missing.length > 0) {
    throw new Error(`${label} 파일에 필요한 컬럼이 없습니다: ${missing.join(", ")}`);
  }
}

function downloadWorkbook(workbook: XLSX.WorkBook, fileName: string) {
  const output = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  const blob = new Blob([output], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function scoreCandidate(
  row: BaseRow,
  candidate: DataRow,
  storeProfile: StoreProfile | null,
): CandidateScore | null {
  const serial = extractSerial(candidate["C/S 내역"]);
  if (!serial) return null;

  const recipientTokens = extractNameTokens(row["수취인/주문예약일"]);
  const candidateOrderer = normalizeCompact(candidate["주문자"]);
  const candidateReceiver = normalizeCompact(candidate["수령자"]);
  const candidateAddress = normalizeCompact(candidate["배송지주소"]);
  const candidateSeller = normalizeCompact(candidate["판매처"]);
  const candidateOrderNumber = normalizeCompact(candidate["주문번호"]);

  const recipientMatched = recipientTokens.some(
    (token) => includesEitherWay(token, candidateOrderer) || includesEitherWay(token, candidateReceiver),
  );
  const addressMatched = includesEitherWay(normalizeCompact(row["주소/주문매장코드"]), candidateAddress);

  let storeSignalCount = 0;

  if (storeProfile) {
    const branchMatched =
      Boolean(storeProfile.branchCompact) &&
      [candidateSeller, candidateOrderNumber, candidateOrderer, candidateAddress].some((value) =>
        value.includes(storeProfile.branchCompact),
      );

    const chainMatched =
      Boolean(storeProfile.chainCompact) && candidateSeller.includes(storeProfile.chainCompact);

    const fullStoreMatched = storeProfile.aliases.some((alias) =>
      [candidateSeller, candidateOrderNumber, candidateOrderer, candidateAddress].some((value) =>
        value.includes(alias),
      ),
    );

    storeSignalCount += branchMatched ? 2 : 0;
    storeSignalCount += chainMatched ? 1 : 0;
    storeSignalCount += fullStoreMatched ? 1 : 0;
  }

  const storeMatched = storeSignalCount > 0;
  const score =
    (recipientMatched ? 4 : 0) +
    (addressMatched ? 5 : 0) +
    storeSignalCount +
    (recipientMatched && addressMatched ? 2 : 0);

  const isValid =
    (recipientMatched && addressMatched) ||
    (addressMatched && storeSignalCount >= 2) ||
    (recipientMatched && storeSignalCount >= 2);

  if (!isValid || score < 6) {
    return null;
  }

  return {
    candidate,
    serial,
    score,
    recipientMatched,
    addressMatched,
    storeMatched,
  };
}

function processSerialFiles(
  baseFile: ParsedWorkbook,
  dataFile: ParsedWorkbook,
): ProcessResult {
  assertColumns(baseFile.rows, BASE_REQUIRED_COLUMNS, "베이스");
  assertColumns(dataFile.rows, DATA_REQUIRED_COLUMNS, "데이터");

  const baseSheet = baseFile.workbook.Sheets[baseFile.sheetName];
  const dataRows = dataFile.rows as DataRow[];
  const groupedByCode = new Map<string, DataRow[]>();
  const usedRows = new WeakSet<DataRow>();
  const storesByCode = new Map<string, StoreProfile>();

  STORE_DATA.forEach(({ code, name }) => {
    storesByCode.set(code, buildStoreProfile(code, name));
  });

  dataRows.forEach((row) => {
    const code = normalizeCode(row["상품코드"]);
    const serial = extractSerial(row["C/S 내역"]);

    if (!code || !serial) return;

    const group = groupedByCode.get(code) ?? [];
    group.push(row);
    groupedByCode.set(code, group);
  });

  const baseHeaderRow = 1;
  const serialColumnIndex = 7;
  const baseRows = baseFile.rows as BaseRow[];
  const issues: MatchIssue[] = [];
  const previews: MatchPreview[] = [];
  let matchedCount = 0;

  baseRows.forEach((row, index) => {
    const rowNumber = index + baseHeaderRow + 1;
    const productCode = normalizeCode(row["품번"]);
    const recipientRaw = String(row["수취인/주문예약일"] ?? "").trim();
    const addressRaw = String(row["주소/주문매장코드"] ?? "").trim();
    const storeCode = String(row["매장코드"] ?? "").trim();
    const storeProfile = storesByCode.get(storeCode) ?? null;

    if (!productCode) {
      issues.push({
        rowNumber,
        reason: "품번이 비어 있습니다.",
        productCode: "",
        recipient: recipientRaw,
        storeCode,
      });
      return;
    }

    if (String(row["시리얼"] ?? "").trim()) {
      issues.push({
        rowNumber,
        reason: "시리얼이 이미 채워져 있어 건너뛰었습니다.",
        productCode,
        recipient: recipientRaw,
        storeCode,
      });
      return;
    }

    const candidates = (groupedByCode.get(productCode) ?? []).filter((candidate) => !usedRows.has(candidate));

    if (candidates.length === 0) {
      issues.push({
        rowNumber,
        reason: "같은 상품코드의 시리얼 데이터가 없습니다.",
        productCode,
        recipient: recipientRaw,
        storeCode,
      });
      return;
    }

    const scoredCandidates = candidates
      .map((candidate) => scoreCandidate(row, candidate, storeProfile))
      .filter((candidate): candidate is CandidateScore => Boolean(candidate))
      .sort((left, right) => right.score - left.score);

    if (scoredCandidates.length === 0) {
      const storeMessage = storeProfile
        ? `매장(${storeProfile.name}) 포함 기준으로도 자동 확정할 수 없습니다.`
        : "주문자/수령자/주소 기준으로 자동 확정할 수 없습니다.";

      issues.push({
        rowNumber,
        reason: storeMessage,
        productCode,
        recipient: recipientRaw,
        storeCode,
      });
      return;
    }

    const selected = scoredCandidates[0];
    usedRows.add(selected.candidate);

    const cellAddress = XLSX.utils.encode_cell({ r: rowNumber - 1, c: serialColumnIndex });
    baseSheet[cellAddress] = {
      t: "s",
      v: selected.serial,
    };

    previews.push({
      rowNumber,
      productCode,
      recipient: recipientRaw,
      address: addressRaw,
      serial: selected.serial,
      storeName: storeProfile?.name ?? "",
      seller: String(selected.candidate["판매처"] ?? ""),
      orderNumber: String(selected.candidate["주문번호"] ?? ""),
    });
    matchedCount += 1;
  });

  return {
    fileName: baseFile.fileName.replace(/\.xlsx?$/i, "") + "_filled.xlsx",
    workbook: baseFile.workbook,
    matchedCount,
    issueCount: issues.length,
    previews,
    issues,
  };
}

export default function SerialPage() {
  const [baseWorkbook, setBaseWorkbook] = useState<ParsedWorkbook | null>(null);
  const [dataWorkbook, setDataWorkbook] = useState<ParsedWorkbook | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canProcess = Boolean(baseWorkbook && dataWorkbook && !isProcessing);
  const previewRows = useMemo(() => result?.previews.slice(0, 12) ?? [], [result]);
  const issueRows = useMemo(() => result?.issues.slice(0, 12) ?? [], [result]);

  const handleFileChange =
    (type: "base" | "data") => async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;

      setError(null);
      setResult(null);

      try {
        const workbook = await readWorkbook(file);

        if (type === "base") {
          assertColumns(workbook.rows, BASE_REQUIRED_COLUMNS, "베이스");
          setBaseWorkbook(workbook);
          return;
        }

        assertColumns(workbook.rows, DATA_REQUIRED_COLUMNS, "데이터");
        setDataWorkbook(workbook);
      } catch (err) {
        const message = err instanceof Error ? err.message : "엑셀 파일을 읽는 중 문제가 발생했습니다.";
        setError(message);
      }
    };

  const handleProcess = async () => {
    if (!baseWorkbook || !dataWorkbook) return;

    setIsProcessing(true);
    setError(null);

    try {
      const nextResult = processSerialFiles(baseWorkbook, dataWorkbook);
      setResult(nextResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : "시리얼 매칭 중 문제가 발생했습니다.";
      setError(message);
      setResult(null);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <main className="min-h-screen bg-stone-100 px-4 py-10 text-stone-900">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
        <header className="rounded-[2rem] border border-stone-200 bg-[linear-gradient(135deg,#fff8ef_0%,#ffffff_45%,#eef6ff_100%)] p-8 shadow-[0_20px_80px_-50px_rgba(0,0,0,0.35)]">
          <p className="text-sm font-semibold uppercase tracking-[0.24em] text-stone-500">GV Tools</p>
          <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="max-w-4xl space-y-3">
              <h1 className="text-3xl font-semibold tracking-tight text-stone-950">시리얼 매칭 도구</h1>
              <p className="text-sm leading-6 text-stone-600 sm:text-base">
                `Serial_base.xlsx`의 <strong>시리얼</strong> 컬럼을 채웁니다. 기본 기준은
                <strong> 상품코드 ↔ 품번</strong>, <strong>주문자/수령자 ↔ 수취인/주문예약일</strong>,
                <strong> 배송지주소 ↔ 주소/주문매장코드</strong>이고, 여기에
                <strong> 내부 매장 DB의 매장코드/매장명 ↔ 판매처/주문번호</strong>를 보조 조건으로 추가합니다.
              </p>
            </div>
            <div className="rounded-2xl bg-stone-950 px-5 py-4 text-sm text-stone-50">
              <p>1. 베이스 업로드</p>
              <p>2. 시리얼 데이터 업로드</p>
              <p>3. 자동 매칭 후 다운로드</p>
            </div>
          </div>
        </header>

        <section className="grid gap-4 lg:grid-cols-2">
          <label className="flex min-h-52 cursor-pointer flex-col justify-between rounded-[1.75rem] border border-stone-200 bg-white p-6 shadow-sm transition hover:border-stone-300 hover:shadow-md">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">Base File</p>
              <h2 className="text-2xl font-semibold text-stone-950">Serial_base.xlsx</h2>
              <p className="text-sm leading-6 text-stone-600">
                필수 컬럼: 시리얼, 품번, 수취인/주문예약일, 주소/주문매장코드, 매장코드
              </p>
            </div>
            <div className="space-y-3">
              <div className="rounded-2xl bg-stone-100 px-4 py-3 text-sm text-stone-600">
                {baseWorkbook ? baseWorkbook.fileName : "파일을 클릭해서 업로드"}
              </div>
              <span className="inline-flex w-fit rounded-full bg-amber-500 px-4 py-2 text-sm font-semibold text-white">
                베이스 선택
              </span>
            </div>
            <input
              type="file"
              accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              onChange={handleFileChange("base")}
            />
          </label>

          <label className="flex min-h-52 cursor-pointer flex-col justify-between rounded-[1.75rem] border border-stone-200 bg-white p-6 shadow-sm transition hover:border-stone-300 hover:shadow-md">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-700">Serial Data</p>
              <h2 className="text-2xl font-semibold text-stone-950">Serial_data.xls</h2>
              <p className="text-sm leading-6 text-stone-600">
                필수 컬럼: 상품코드, 주문자, 수령자, 배송지주소, 판매처, 주문번호, C/S 내역
              </p>
            </div>
            <div className="space-y-3">
              <div className="rounded-2xl bg-stone-100 px-4 py-3 text-sm text-stone-600">
                {dataWorkbook ? dataWorkbook.fileName : "파일을 클릭해서 업로드"}
              </div>
              <span className="inline-flex w-fit rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white">
                데이터 선택
              </span>
            </div>
            <input
              type="file"
              accept=".xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              onChange={handleFileChange("data")}
            />
          </label>

        </section>

        <section className="rounded-[1.75rem] border border-stone-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="space-y-2">
              <h2 className="text-xl font-semibold text-stone-950">실행</h2>
              <p className="text-sm text-stone-600">
                두 파일 업로드가 끝나면 내부 매장 DB를 포함해 시리얼을 채웁니다.
              </p>
              {error && <p className="text-sm font-medium text-rose-600">{error}</p>}
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleProcess}
                disabled={!canProcess}
                className="rounded-full bg-stone-950 px-5 py-3 text-sm font-semibold text-white transition enabled:hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300"
              >
                {isProcessing ? "매칭 중..." : "시리얼 채우기"}
              </button>
              <button
                type="button"
                onClick={() => result && downloadWorkbook(result.workbook, result.fileName)}
                disabled={!result}
                className="rounded-full bg-emerald-600 px-5 py-3 text-sm font-semibold text-white transition enabled:hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-stone-300"
              >
                결과 다운로드
              </button>
            </div>
          </div>
        </section>

        {result && (
          <section className="grid gap-4 xl:grid-cols-[1.3fr_0.7fr]">
            <div className="rounded-[1.75rem] border border-stone-200 bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <h2 className="text-xl font-semibold text-stone-950">매칭 결과</h2>
                  <p className="mt-1 text-sm text-stone-600">자동으로 채운 시리얼 미리보기입니다.</p>
                </div>
                <div className="flex gap-3 text-sm">
                  <span className="rounded-full bg-emerald-100 px-3 py-1 font-medium text-emerald-700">
                    성공 {result.matchedCount}건
                  </span>
                  <span className="rounded-full bg-amber-100 px-3 py-1 font-medium text-amber-700">
                    검토 필요 {result.issueCount}건
                  </span>
                </div>
              </div>

              <div className="mt-5 overflow-x-auto">
                <table className="min-w-full border-separate border-spacing-0 text-left text-sm">
                  <thead>
                    <tr className="text-stone-500">
                      <th className="border-b border-stone-200 px-3 py-3 font-medium">행</th>
                      <th className="border-b border-stone-200 px-3 py-3 font-medium">품번</th>
                      <th className="border-b border-stone-200 px-3 py-3 font-medium">수취인</th>
                      <th className="border-b border-stone-200 px-3 py-3 font-medium">매장</th>
                      <th className="border-b border-stone-200 px-3 py-3 font-medium">판매처 / 주문번호</th>
                      <th className="border-b border-stone-200 px-3 py-3 font-medium">시리얼</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previewRows.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-6 text-center text-stone-500">
                          자동으로 채워진 항목이 없습니다.
                        </td>
                      </tr>
                    ) : (
                      previewRows.map((item) => (
                        <tr key={`${item.rowNumber}-${item.serial}`} className="align-top">
                          <td className="border-b border-stone-100 px-3 py-3">{item.rowNumber}</td>
                          <td className="border-b border-stone-100 px-3 py-3">{item.productCode}</td>
                          <td className="border-b border-stone-100 px-3 py-3">
                            <p>{item.recipient}</p>
                            <p className="mt-1 text-xs text-stone-500">{item.address}</p>
                          </td>
                          <td className="border-b border-stone-100 px-3 py-3 text-stone-600">
                            {item.storeName || "-"}
                          </td>
                          <td className="border-b border-stone-100 px-3 py-3 text-stone-600">
                            <p>{item.seller || "-"}</p>
                            <p className="mt-1 text-xs text-stone-500">{item.orderNumber || "-"}</p>
                          </td>
                          <td className="border-b border-stone-100 px-3 py-3 font-mono text-xs text-emerald-700">
                            {item.serial}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="rounded-[1.75rem] border border-stone-200 bg-white p-6 shadow-sm">
              <h2 className="text-xl font-semibold text-stone-950">검토 필요</h2>
              <p className="mt-1 text-sm text-stone-600">
                자동 확정이 어려운 항목입니다. 상위 12건만 표시합니다.
              </p>
              <ul className="mt-5 space-y-3">
                {issueRows.length === 0 ? (
                  <li className="rounded-2xl bg-emerald-50 px-4 py-4 text-sm text-emerald-700">
                    검토가 필요한 항목이 없습니다.
                  </li>
                ) : (
                  issueRows.map((item) => (
                    <li key={`${item.rowNumber}-${item.reason}`} className="rounded-2xl bg-stone-100 px-4 py-4">
                      <p className="text-sm font-semibold text-stone-900">
                        {item.rowNumber}행 · 품번 {item.productCode || "-"} · 매장코드 {item.storeCode || "-"}
                      </p>
                      <p className="mt-1 text-sm text-stone-600">{item.recipient || "수취인 정보 없음"}</p>
                      <p className="mt-2 text-sm text-rose-600">{item.reason}</p>
                    </li>
                  ))
                )}
              </ul>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
