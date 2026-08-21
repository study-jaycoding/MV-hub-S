// PM 대시보드 독립 창 (embed 모드) — `/?embed=manage` 분리 브라우저 창.
// 대시보드(요약+팀전체 통합) / 작업(칸반) / 완료 탭. AssetsWindow 와 동일한 분리형 모듈 패턴.
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { loadString, saveString } from "../lib/storage";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { loadManageWorkspaceScope } from "../lib/manageWorkspaceScope";
import { useManageCaps } from "../lib/useManageCaps";
import { useManageRealtime } from "../lib/useManageRealtime";
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
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(
    () => loadManageWorkspaceScope().workspaceId,
  );
  // A안(독립 선택): 관리 창에서 워크스페이스를 직접 고르면 true — 이후 메인 창의 필터
  // 저장(워크스페이스 외 검색·색상 변경도 같은 키를 재저장한다)이 이 창의 선택을 덮지 않는다.
  const workspacePinnedRef = useRef(false);
  const [workspaceNames, setWorkspaceNames] = useState<Record<string, string>>({});
  const reloadSignal = useManageRealtime(enabled === true);
  // 대시보드 탭은 모두에게 연다. read_all 보유자는 워크스페이스 전체 통계까지,
  // 일반 멤버는 자신이 참여한 프로젝트 작업 현황만 본다.
  const caps = useManageCaps();
  useEffect(() => saveString(STORAGE_KEYS.manageTab, tab), [tab]);

  useEffect(() => {
    document.title = "Millionvolt Hub — 프로젝트 관리";
  }, []);

  // 메인 창에서 개인/워크스페이스를 바꾸면 별도 관리 창도 같은 범위를 따른다 — 단, 이 창에서
  // 직접 고른 뒤에는 따르지 않는다(A안). 셀렉터가 없는 일반 멤버는 계속 메인 창을 따른다.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEYS.workspaceContext && event.key !== null) return;
      if (workspacePinnedRef.current) return;
      setWorkspaceId(loadManageWorkspaceScope().workspaceId);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    let active = true;
    api.workspaceOptions()
      .then((response) => {
        if (!active) return;
        setWorkspaceNames(Object.fromEntries(
          (response.workspaces || []).map((workspace) => [workspace.id, workspace.name]),
        ));
      })
      .catch(() => {});
    return () => { active = false; };
  }, [reloadSignal]);

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
      {tab === "dashboard" && !caps.loaded && (
        <div className="manage-empty">권한 확인 중...</div>
      )}
      {tab === "dashboard" && caps.loaded && (
        <DashboardView
          reloadSignal={reloadSignal}
          caps={caps}
          workspaceId={workspaceId}
          onWorkspaceIdChange={(value) => {
            workspacePinnedRef.current = true;
            setWorkspaceId(value || undefined);
          }}
        />
      )}
      {tab === "tasks" && !caps.loaded && (
        <div className="manage-empty">권한 확인 중...</div>
      )}
      {tab === "tasks" && caps.loaded && (
        <WorkBoard
          reloadSignal={reloadSignal}
          viewerUid={caps.viewerUid}
          personalByDefault={!caps.readAll}
          workspaceId={workspaceId}
          workspaceName={workspaceId ? workspaceNames[workspaceId] : "개인 · 전체 워크스페이스"}
        />
      )}
      {tab === "export" && <ExportView reloadSignal={reloadSignal} />}
    </div>
  );
}
