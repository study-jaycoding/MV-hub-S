// PM 대시보드 독립 창 (embed 모드) — `/?embed=manage` 분리 브라우저 창.
// 요약 / 작업(칸반) / 분석 탭으로 구성. AssetsWindow 와 동일한 분리형 모듈 패턴.
import { useEffect, useState } from "react";
import { api } from "../api";
import { loadString, saveString } from "../lib/storage";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { ExportView } from "./manage/ExportView";
import { ProjectDashboard } from "./manage/ProjectDashboard";
import { TeamOverview } from "./manage/TeamOverview";
import { WorkBoard } from "./manage/WorkBoard";

type Tab = "summary" | "tasks" | "export" | "team";

const TABS: { v: Tab; label: string }[] = [
  { v: "summary", label: "요약" },
  { v: "tasks", label: "작업" },
  { v: "export", label: "완료" },
  { v: "team", label: "팀 전체" },
];

export function ManageWindow() {
  // 마지막 본 탭 기억 — 창을 껐다 켜도 그 화면으로 이어서 작업(없어진 탭이면 요약으로).
  const [tab, setTab] = useState<Tab>(() => {
    const saved = loadString(STORAGE_KEYS.manageTab, "summary") as Tab;
    return TABS.some((t) => t.v === saved) ? saved : "summary";
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
      {tab === "summary" && <ProjectDashboard />}
      {tab === "tasks" && <WorkBoard />}
      {tab === "export" && <ExportView />}
      {tab === "team" && <TeamOverview />}
    </div>
  );
}
