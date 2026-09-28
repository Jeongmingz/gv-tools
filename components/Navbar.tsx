"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  {
    name: "WebP 변환기",
    href: "/webp",
    badge: "이미지",
  },
  {
    name: "Excel ➜ CSV",
    href: "/excel-to-csv",
    badge: "데이터",
  },
  {
    name: "시리얼 매칭",
    href: "/serial",
    badge: "업무",
  },
];

export default function Navbar() {
  const pathname = usePathname();

  return (
    <nav className="w-full border-b border-slate-200/80 bg-white/80 backdrop-blur sticky top-0 z-30">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-3">
          <Link
            href="/webp"
            className="flex items-center gap-2 font-bold tracking-tight text-slate-900 transition hover:opacity-80"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-600 text-xs font-black text-white shadow-sm">
              GV
            </span>
            <span className="text-base font-semibold">GV Tools</span>
          </Link>
        </div>

        <div className="flex items-center gap-1 sm:gap-2">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`relative flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs sm:text-sm font-medium transition ${
                  isActive
                    ? "bg-slate-900 text-white shadow-sm"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <span>{item.name}</span>
                <span
                  className={`hidden sm:inline-block rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                    isActive
                      ? "bg-white/20 text-white"
                      : "bg-slate-100 text-slate-500"
                  }`}
                >
                  {item.badge}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
