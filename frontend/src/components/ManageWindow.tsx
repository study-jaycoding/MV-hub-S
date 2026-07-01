// PM 대시보드 독립 창 (embed 모드) — `/?embed=manage` 분리 브라우저 창.
// 요약 / 작업(칸반) / 분석 탭으로 구성. AssetsWindow 와 동일한 분리형 모듈 패턴.
import { useEffect, useState } from "react";
import { api } from "../api";
import { AnalyticsView } from "./manage/AnalyticsView";
import { ProjectDashboard } from "./manage/ProjectDashboard";
import { WorkBoard } from "./manage/WorkBoard";

type Tab = "summary" | "tasks" | "analytics";

const TABS: { v: Tab; label: string }[] = [
  { v: "summary", label: "요약" },
  { v: "tasks", label: "작업" },
  { v: "analytics", label: "분석" },
];

export function ManageWindow() {
  const [tab, setTab] = useState<Tab>("summary");
  const [enabled, setEnabled] = useState<boolean | null>(null);

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
      {tab === "analytics" && <AnalyticsView />}
    </div>
  );
}
