// 상단 바 (DESIGN.md §4): 로고 + 탭(내 작업/팀 공유) + 동기화 + 검색(우측) + Assets + 계정.
// 서버 모드: 단일 DB 를 모두가 공유하므로 번들 주고받기(JSON 내보내기/가져오기·공유 받기·
// 로컬 보관)는 불필요 → 제거. '구성(compose)' 탭도 숨김(기능은 유지, 진입만 비활성).
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Filters, WorkspaceContext } from "../types";
import type { ProviderIdentity } from "../lib/accountIdentity";
import { useT } from "../lib/i18n";
import { AccountMenu } from "./AccountMenu";
import { FolderIcon } from "./FolderIcon";
import { NotificationCenter } from "./NotificationCenter";
import { SearchBox } from "./SearchBox";

interface Props {
  filters: Filters;
  onTab: (tab: "my" | "team" | "compose") => void;
  editOpen?: boolean; // 편집 탭이 떠 있다 — 밑의 탭(filters.tab)은 그대로지만 단추는 편집만 켠다
  onOpenEdit?: () => void;
  onSearch: (q?: string) => void;
  onWorkspaceSwitched: (context: WorkspaceContext) => void; // 전환 완료 — 전환된 공간(토스트 표시용)
  workspaceContext: WorkspaceContext;
  onWorkspaceContextChange: (context: WorkspaceContext) => void;
  onImported: (msg: string) => void; // (서버 모드 미사용 — App 호환)
  onOpenAssets: () => void;
  onOpenManage?: () => void; // PM 대시보드(분리형) — 별도 창. 플래그 off 면 미전달(버튼 숨김)
  onOpenAdmin: () => void; // 좌측 상단 로고 클릭 → 관리자 창(로드맵 §4-5)
  account?: import("../types").Account | null; // 로그인 계정(AUTH 모드)
  onLogout?: () => void;
  localHub?: boolean; // 로컬 허브(AUTH off) — 워크스페이스 클릭 전환 허용 신호(AccountMenu 로 전달)
  manageEnabled?: boolean; // PM 관리 기능 on — AccountMenu 예산 조회 게이트로 전달
  hasUnreadComments: boolean;
  notificationUnreadCount?: number;
  onOpenNotificationComment: (genId: string) => void;
  onNotificationsChanged: () => void;
  inert?: boolean; // 폴더 창이 떠 있는 동안 — 마우스는 창의 막이 막지만 Tab 으로는 닿았다(App 의 behindInert)
  searchResetKey?: number; // 탭 누름 말고 필터가 통째로 갈린 횟수(Resolve 자동 따라가기) — 바뀌면 검색칸을 다시 올린다
}

export function TopBar({
  filters,
  onTab,
  editOpen,
  onOpenEdit,
  onSearch,
  onWorkspaceSwitched,
  workspaceContext,
  onWorkspaceContextChange,
  onImported,
  onOpenAssets,
  onOpenManage,
  onOpenAdmin,
  account,
  onLogout,
  localHub,
  manageEnabled,
  hasUnreadComments,
  notificationUnreadCount,
  onOpenNotificationComment,
  onNotificationsChanged,
  inert,
  searchResetKey = 0,
}: Props) {
  const t = useT();
  // 제공자 신원 — CLI account status 이메일에서 잡힌 표시이름(계정 메뉴 표시용).
  const [provider, setProvider] = useState<ProviderIdentity | null>(null);
  useEffect(() => {
    api.provider().then(setProvider).catch(() => {});
  }, []);
  // 탭을 누른 횟수 — 검색칸의 key 에 넣는다(아래). 탭 누름은 필터를 초기화하는데, **지금 켜진 탭**을 다시 누르면 탭이 안 바뀌어
  //  검색칸이 그대로 남고, 예약해 둔 검색(0.3초 뒤)이 초기화 뒤에 다시 걸렸다(Codex 검토).
  const [tabPicks, setTabPicks] = useState(0);
  const pickTab = (tab: "my" | "team" | "compose") => {
    setTabPicks((n) => n + 1);
    onTab(tab);
  };

  return (
    // React 18 타입에 inert 가 없어 spread 로 넘긴다. 알림·계정 메뉴의 패널은 body 에 그려져 이 잠금에 들지 않는다.
    <header className="topbar" {...(inert ? { inert: "" } : {})}>
      <button
        className="brand"
        onClick={onOpenAdmin}
        title={t("관리자 — 멤버 등급·프로젝트 관리")}
      >
        ⬡ MV Hub
      </button>

      <nav className="tabs">
        <button
          className={!editOpen && filters.tab === "my" ? "on" : ""}
          onClick={() => pickTab("my")}
        >
          {t("작업 공간")}
        </button>
        <button
          className={!editOpen && filters.tab === "team" ? "on" : ""}
          onClick={() => pickTab("team")}
        >
          {t("공유 & 리뷰")}
        </button>
        <button
          className={!editOpen && filters.tab === "compose" ? "on" : ""}
          onClick={() => pickTab("compose")}
          title={t("캔버스 — 씬 캔버스 · 히스토리 뷰")}
        >
          {t("캔버스")}
        </button>
        {onOpenEdit && (
          <button
            className={editOpen ? "on" : ""}
            onClick={onOpenEdit}
            title={t("편집 — 공유된 생성물을 컷 순서대로 이어 보기")}
          >
            {t("편집")}
          </button>
        )}
      </nav>

      {/* 좌(로고·탭) ↔ 우(검색·Assets·계정) 분리 */}
      <div className="topbar-spacer" />

      {/* 동기화 버튼 제거 — 자동 주기 동기화 + 계정 메뉴 '설정 → 전체 가져오기'로 대체 */}

      {/* 프롬프트·태그 검색 — 우측(구 '공유' 버튼 자리)으로 이동 */}
      {/* key = 탭 + 탭을 누른 횟수 — 탭을 누르면(같은 탭이어도) 검색칸을 다시 올린다. 예약해 둔(0.3초 뒤) 검색이 초기화된 화면에 걸리지
          않게(언마운트가 예약을 버린다). 자동 따라가기(searchResetKey)는 key 가 아니라 신호로 내린다 — 사용자가 아무것도 안 해도 오므로
          검색칸을 다시 올리면 치던 사람의 초점이 사라진다. 값이 바뀌는 초기화는 SearchBox 가 스스로 안다. */}
      <SearchBox
        key={`${filters.tab}:${tabPicks}`}
        resetKey={searchResetKey}
        className="topbar-search"
        placeholder="Search · Tag"
        value={filters.search}
        onSearch={onSearch}
      />

      {/* Assets(구성) 버튼 — 분리된 브라우저 창으로 연다 */}
      <button className="assets-btn" onClick={onOpenAssets} title={t("Assets (구성) — 별도 창")}>
        <FolderIcon />
        <span className="assets-label">Assets</span>
      </button>

      {/* PM 대시보드(분리형) — 플래그 on(onOpenManage 전달) 일 때만 노출. 보드 아이콘 버튼 */}
      {onOpenManage && (
        <button
          className="assets-btn manage-btn-icon"
          onClick={onOpenManage}
          title={t("프로젝트 관리 — 별도 창")}
          aria-label={t("프로젝트 관리 — 별도 창")}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="2" y="2.5" width="4.6" height="11" rx="1.3" fill="currentColor" />
            <rect x="9.4" y="2.5" width="4.6" height="7" rx="1.3" fill="currentColor" />
          </svg>
        </button>
      )}

      <NotificationCenter
        commentUnreadCount={notificationUnreadCount}
        hasUnreadComments={hasUnreadComments}
        onOpenComment={onOpenNotificationComment}
        onChanged={onNotificationsChanged}
      />

      {/* 계정·워크스페이스 통합 메뉴 */}
      <AccountMenu
        provider={provider}
        account={account}
        onProviderUpdated={setProvider}
        onLogout={onLogout}
        onWorkspaceSwitched={onWorkspaceSwitched}
        workspaceContext={workspaceContext}
        onWorkspaceContextChange={onWorkspaceContextChange}
        onImported={onImported}
        localHub={localHub}
        manageEnabled={manageEnabled}
      />
    </header>
  );
}
