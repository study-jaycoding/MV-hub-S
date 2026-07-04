// PM 대시보드 독립 창 (embed 모드) — `/?embed=manage` 분리 브라우저 창.
// 대시보드(요약+팀전체 통합) / 작업(칸반) / 완료 탭. AssetsWindow 와 동일한 분리형 모듈 패턴.
import { useEffect, useState } from "react";
import { api } from "../api";
import { loadString, saveString } from "../lib/storage";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { DashboardView } from "./manage/DashboardView";
import { ExportView } from "./manage/ExportView";
import { WorkBoard } from "./manage/WorkBoard";

type Tab = "dashboard" | "tasks" | "export";

const TABS: { v: Tab; label: string }[] = [
  { v: "dashboard", label: "대시보드" },
  { v: "tasks", label: "작업" },
  { v: "export", label: "완료" },
];

export function ManageWindow() {
  // 마지막 본 탭 기억 — 창을 껐다 켜도 그 화면으로 이어서 작업(없어진 탭이면 대시보드로).
  const [tab, setTab] = useState<Tab>(() => {
    let saved = loadString(STORAGE_KEYS.manageTab, "dashboard");
    if (saved === "summary" || saved === "team") saved = "dashboard"; // 구 탭(요약·팀전체) → 통합
    return TABS.some((t) => t.v === saved) ? (saved as Tab) : "dashboard";
  });
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => saveString(STORAGE_KEYS.manageTab, tab), [tab]);

  useEffect(() => {
    document.title = "Millionvolt Hub — 프로젝트 관리";
  }, []);

  useEffect(() => {
    let alive = true;
    api
      .authConfig()
      .then((config) => {
        if (alive) setEnabled(!!config.manage_enabled);
      })
      .catch(() => {
        if (alive) setEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (enabled === null) {
    return (
      <div className="manage-window">
        <div className="manage-empty">관리 기능 확인 중...</div>
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="manage-window">
        <div className="manage-empty">관리탭은 현재 비활성화되어 있습니다.</div>
      </div>
    );
  }

  return (
    <div className="manage-window">
      <nav className="manage-tabs">
        {TABS.map((t) => (
          <button
            key={t.v}
            className={tab === t.v ? "on" : ""}
            onClick={() => setTab(t.v)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "dashboard" && <DashboardView />}
      {tab === "tasks" && <WorkBoard />}
      {tab === "export" && <ExportView />}
    </div>
  );
}
