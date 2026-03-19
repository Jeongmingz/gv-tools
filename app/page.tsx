"use client";

import { ChangeEvent, DragEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";

const ACCEPTED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/x-png",
]);

const ACCEPT_LABEL = "PNG, JPG, JPEG";
const MAX_WEBP_BYTES = 4 * 1024 * 1024; // 4MB limit
const MIN_QUALITY = 0.2;
const MAX_QUALITY = 1;
const MAX_SIZE_LABEL = "4MB";

type ConvertedImage = {
  id: string;
  name: string;
  originalSize: number;
  outputSize: number;
  url: string;
  width: number;
  height: number;
  quality: number; // 실제 적용된 품질(%)
  limited: boolean; // 4MB 제한에 의해 품질이 낮아졌는지 여부
};

type RawConversion = Omit<ConvertedImage, "quality" | "limited">;

const readableId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const formatBytes = (bytes: number) => {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const idx = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** idx).toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
};

const readFileAsDataURL = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("파일을 읽지 못했어요."));
    reader.readAsDataURL(file);
  });

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("이미지를 불러오지 못했어요."));
    image.src = src;
  });

async function convertToWebP(file: File, quality: number): Promise<RawConversion> {
  const dataUrl = await readFileAsDataURL(file);
  const imageElement = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = imageElement.naturalWidth;
  canvas.height = imageElement.naturalHeight;
  const ctx = canvas.getContext("2d");

  if (!ctx) {
    throw new Error("캔버스를 초기화할 수 없어요.");
  }

  ctx.drawImage(imageElement, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => {
        if (!result) {
          reject(new Error("WebP 이미지를 생성하지 못했어요."));
          return;
        }
        resolve(result);
      },
      "image/webp",
      quality,
    );
  });

  return {
    id: readableId(),
    name: file.name.replace(/\.[^.]+$/, ""),
    originalSize: file.size,
    outputSize: blob.size,
    url: URL.createObjectURL(blob),
    width: imageElement.naturalWidth,
    height: imageElement.naturalHeight,
  };
}

const clampQuality = (value: number) => Math.min(Math.max(value, MIN_QUALITY), MAX_QUALITY);

async function convertWithLimit(file: File, desiredQualityPercent: number): Promise<ConvertedImage> {
  let attempt = 0;
  const desired = clampQuality(desiredQualityPercent / 100);
  let quality = desired;
  let lastResult: RawConversion | null = null;

  while (attempt < 5) {
    const result = await convertToWebP(file, quality);
    lastResult = result;

    if (result.outputSize <= MAX_WEBP_BYTES) {
      return {
        ...result,
        quality: Math.round(quality * 100),
        limited: quality < desired - 0.005,
      };
    }

    const ratio = MAX_WEBP_BYTES / result.outputSize;
    const nextQuality = clampQuality(quality * ratio * 0.9);

    if (nextQuality >= quality - 0.01 || nextQuality <= MIN_QUALITY) {
      break;
    }

    quality = nextQuality;
    attempt += 1;
  }

  if (lastResult && lastResult.outputSize <= MAX_WEBP_BYTES) {
    return {
      ...lastResult,
      quality: Math.round(quality * 100),
      limited: quality < desired,
    };
  }

  throw new Error("이미지를 4MB 이하로 줄일 수 없어요. 해상도를 줄여 다시 시도해 주세요.");
}

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const objectUrls = useRef(new Set<string>());
  const [converted, setConverted] = useState<ConvertedImage[]>([]);
  const [quality, setQuality] = useState(80);
  const [isDragging, setIsDragging] = useState(false);
  const [isPageDragging, setIsPageDragging] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanupUrls = useCallback(() => {
    objectUrls.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.current.clear();
  }, []);

  useEffect(() => {
    return () => {
      cleanupUrls();
    };
  }, [cleanupUrls]);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const picked = Array.from(files);

      if (!picked.length) return;

      const supported = picked.filter((file) => {
        if (file.type && ACCEPTED_MIME_TYPES.has(file.type)) return true;
        const lower = file.name.toLowerCase();
        return lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg");
      });

      if (!supported.length) {
        setError("PNG 또는 JPG 파일만 변환할 수 있어요.");
        return;
      }

      setError(null);
      setIsConverting(true);

      try {
        const results = await Promise.all(
          supported.map((file) => convertWithLimit(file, Math.min(Math.max(quality, 40), 100))),
        );
        results.forEach((item) => objectUrls.current.add(item.url));
        setConverted((prev) => [...results, ...prev]);
      } catch (err) {
        const message = err instanceof Error ? err.message : "알 수 없는 문제가 발생했어요.";
        setError(message);
      } finally {
        setIsConverting(false);
      }
    },
    [quality],
  );

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      void handleFiles(event.target.files);
      event.target.value = "";
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement | HTMLElement>) => {
    event.preventDefault();
    setIsDragging(false);
    setIsPageDragging(false);
    if (event.dataTransfer.files) {
      void handleFiles(event.dataTransfer.files);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInputRef.current?.click();
    }
  };

  const handleRemove = (id: string) => {
    setConverted((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) {
        URL.revokeObjectURL(target.url);
        objectUrls.current.delete(target.url);
      }
      return prev.filter((item) => item.id !== id);
    });
  };

  const handleClearAll = () => {
    cleanupUrls();
    setConverted([]);
  };

  const handlePageDragOver = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (!isPageDragging) {
      setIsPageDragging(true);
    }
  };

  const handlePageDragLeave = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (event.currentTarget === event.target) {
      setIsPageDragging(false);
      setIsDragging(false);
    }
  };

  return (
    <main
      className="relative flex min-h-screen justify-center bg-slate-50 px-4 py-14 text-slate-900"
      onDragOver={handlePageDragOver}
      onDragLeave={handlePageDragLeave}
      onDrop={handleDrop}
    >
      {isPageDragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-blue-500/5 backdrop-blur-sm">
          <div className="rounded-2xl border border-blue-400/70 bg-white/90 px-6 py-3 text-center text-sm font-medium text-blue-600 shadow">
            어디에나 파일을 놓으면 자동으로 업로드됩니다
          </div>
        </div>
      )}
      <div className="flex w-full max-w-4xl flex-col gap-10">
        <header className="space-y-3 text-center sm:text-left">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
            GV Tools
          </p>
          <h1 className="text-3xl font-semibold text-slate-900">PNG/JPG ➜ WebP 변환기</h1>
          <p className="text-base text-slate-600">
            용량을 줄이고 웹에 최적화된 포맷으로 저장하세요. PNG 또는 JPG 파일을 올리면 브라우저에서
            즉시 WebP로 변환합니다.
          </p>
        </header>

        <section className="rounded-3xl border border-dashed border-slate-300 bg-white/80 p-8 shadow-sm backdrop-blur">
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={handleKeyDown}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={(event) => {
              event.preventDefault();
              setIsDragging(false);
            }}
            onDrop={handleDrop}
            className={`flex cursor-pointer flex-col items-center gap-4 rounded-2xl border-2 border-dashed px-6 py-10 text-center outline-none transition ${
              isDragging ? "border-blue-500 bg-blue-50" : "border-slate-200 bg-white"
            } focus-visible:ring-2 focus-visible:ring-blue-500/70`}
          >
            <span className="rounded-full bg-slate-100 px-4 py-1 text-xs font-medium text-slate-500">
              {ACCEPT_LABEL} 지원 · 결과 {MAX_SIZE_LABEL} 이하
            </span>
            <div className="space-y-2">
              <p className="text-xl font-semibold text-slate-900">파일을 끌어다 놓거나 클릭해서 선택하세요</p>
              <p className="text-sm text-slate-500">최대 여러 장의 이미지를 한 번에 처리할 수 있어요.</p>
            </div>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="rounded-full bg-slate-900 px-6 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
            >
              파일 선택
            </button>
          </div>
          <input
            ref={fileInputRef}
            id="fileInput"
            type="file"
            accept=".png,.jpg,.jpeg,image/png,image/jpeg"
            multiple
            onChange={onInputChange}
            className="sr-only"
          />

          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            <div>
              <p className="text-sm font-medium text-slate-600">
                출력 품질 ({quality}%) · 결과는 자동으로 {MAX_SIZE_LABEL} 이하로 맞춰집니다.
              </p>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={40}
                  max={100}
                  value={quality}
                  onChange={(event) => setQuality(Number(event.target.value))}
                  className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-slate-200"
                />
                <span className="text-sm text-slate-500">웹 권장</span>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-slate-600">상태</p>
              <p className="text-sm text-slate-500">
                {isConverting
                  ? "이미지를 4MB 이하로 맞추는 중입니다..."
                  : `총 ${converted.length}개의 WebP가 준비되었습니다.`}
              </p>
              {error && <p className="text-sm font-medium text-rose-500">{error}</p>}
            </div>
          </div>
          {converted.length > 0 && (
            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={handleClearAll}
                className="text-sm font-medium text-slate-500 underline-offset-4 hover:text-slate-700 hover:underline"
              >
                변환 목록 비우기
              </button>
            </div>
          )}
        </section>

        <section className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">변환 결과</h2>
              <p className="text-sm text-slate-500">파일을 업로드하면 바로 이 아래에서 다운로드할 수 있어요.</p>
            </div>
            {converted.length > 0 && (
              <p className="text-sm text-slate-500">
                평균 압축률 {(
                  converted.reduce((acc, item) => acc + item.outputSize / item.originalSize, 0) /
                  converted.length
                )
                  .toLocaleString(undefined, { style: "percent", maximumFractionDigits: 0 })}
              </p>
            )}
          </div>

          {converted.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white/80 p-8 text-center text-slate-500">
              아직 변환된 이미지가 없습니다. PNG 또는 JPG 파일을 올려보세요!
            </div>
          ) : (
            <ul className="grid gap-4">
              {converted.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white/90 p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="space-y-1">
                    <p className="text-base font-semibold text-slate-900">
                      {item.name}
                      <span className="ml-2 text-xs font-medium text-slate-400">{item.width}×{item.height}</span>
                    </p>
                    <p className="text-sm text-slate-500">
                      {formatBytes(item.originalSize)} → {formatBytes(item.outputSize)} · 품질 {item.quality}%
                      {item.limited ? " (4MB 제한 적용)" : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <a
                      href={item.url}
                      download={`${item.name}.webp`}
                      className="rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600"
                    >
                      다운로드
                    </a>
                    <button
                      type="button"
                      onClick={() => handleRemove(item.id)}
                      className="text-sm font-medium text-slate-400 underline-offset-4 hover:text-slate-600 hover:underline"
                    >
                      제거
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
