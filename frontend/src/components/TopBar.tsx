// 상단 바 (DESIGN.md §4): 로고 + 탭(워크스페이스/공유 & 리뷰/캔버스) + 검색(우측) + 편집·Assets·관리 아이콘 단추 + 알림 + 계정.
// 서버 모드: 단일 DB 를 모두가 공유하므로 번들 주고받기(JSON 내보내기/가져오기·공유 받기·
// 로컬 보관)는 불필요 → 제거. '구성(compose)' 탭도 숨김(기능은 유지, 진입만 비활성).
import { useEffect, useId, useState } from "react";
import { api } from "../api";
import type { Filters, WorkspaceContext } from "../types";
import type { ProviderIdentity } from "../lib/accountIdentity";
import { useT } from "../lib/i18n";
import { closeEmbedWindow, EMBED_MODES, useEmbedWindowOpen } from "../lib/popupWindows";
import { AccountMenu } from "./AccountMenu";
import { NotificationCenter } from "./NotificationCenter";
import { SearchBox } from "./SearchBox";
import { Grad, TopIcon } from "./TopIcon";

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
  onOpenMcp?: () => void;
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
  searchResetKey?: string | number; // 폴더 탭·범위 변경과 자동 따라가기 때 예약 검색을 버린다
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
  onOpenMcp,
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
  const assetsOpen = useEmbedWindowOpen(EMBED_MODES.assets);
  const manageOpen = useEmbedWindowOpen(EMBED_MODES.manage);

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
          {t("워크스페이스")}
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
      </nav>

      {/* 좌(로고·탭) ↔ 우(검색·Assets·계정) 분리 */}
      <div className="topbar-spacer" />

      {/* 동기화 버튼 제거 — 자동 주기 동기화 + 계정 메뉴 '설정 → 전체 가져오기'로 대체 */}

      {/* 편집 · Assets · 관리 — 글자 없는 아이콘 단추(Jay 2026-10-26). 켜지면(편집 탭 열림 · 그 별도 창이 떠 있음) 선 그림 대신 투톤 그림,
          켜진 채 다시 누르면 닫는다: 편집 = 밑의 탭 단추를 누른 것과 같게 떠난다 · 창 = 닫는다. Assets·관리는 분리된 브라우저 창. 관리(PM)는 플래그 on 일 때만.
          바탕이 이어진 한 캡슐로 묶고(시안 G3) — 첫 칸은 검색칸(B′ — 짧은 구분선, 칠 때 검색칸 바탕만 밝게), 끝 칸은 알림 종(B안 — 배지는
          칸 오른쪽 위에 걸침). 모두 Jay 2026-10-26. */}
      <div className="top-ic-group">
        {/* 프롬프트·태그 검색. key = 탭 + 탭을 누른 횟수 — 탭을 누르면(같은 탭이어도) 검색칸을 다시 올린다. 예약해 둔(0.3초 뒤) 검색이
            초기화된 화면에 걸리지 않게(언마운트가 예약을 버린다). 자동 따라가기(searchResetKey)는 key 가 아니라 신호로 내린다 — 사용자가
            아무것도 안 해도 오므로 검색칸을 다시 올리면 치던 사람의 초점이 사라진다. 값이 바뀌는 초기화는 SearchBox 가 스스로 안다. */}
        <SearchBox
          key={`${filters.tab}:${tabPicks}`}
          resetKey={searchResetKey}
          className="topbar-search"
          placeholder="Search · Tag"
          value={filters.search}
          onSearch={onSearch}
        />
        {onOpenEdit && (
          <button
            className={`top-ic-btn${editOpen ? " lit" : ""}`}
            onClick={editOpen ? () => pickTab(filters.tab) : onOpenEdit}
            title={t("편집 — 공유된 생성물을 컷 순서대로 이어 보기")}
            aria-label={t("편집")}
            aria-pressed={!!editOpen}
          >
            <EditIcon />
          </button>
        )}
        <button
          className={`top-ic-btn assets-btn${assetsOpen ? " lit" : ""}`}
          onClick={assetsOpen ? () => closeEmbedWindow(EMBED_MODES.assets) : onOpenAssets}
          title={t("Assets (구성) — 별도 창")}
          aria-label="Assets"
          aria-pressed={assetsOpen}
        >
          <AssetsIcon />
        </button>
        {onOpenManage && (
          <button
            className={`top-ic-btn manage-btn${manageOpen ? " lit" : ""}`}
            onClick={manageOpen ? () => closeEmbedWindow(EMBED_MODES.manage) : onOpenManage}
            title={t("프로젝트 관리 — 별도 창")}
            aria-label={t("프로젝트 관리 — 별도 창")}
            aria-pressed={manageOpen}
          >
            <ManageIcon />
          </button>
        )}
        <NotificationCenter
          commentUnreadCount={notificationUnreadCount}
          hasUnreadComments={hasUnreadComments}
          onOpenComment={onOpenNotificationComment}
          onChanged={onNotificationsChanged}
        />
      </div>

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
        onOpenMcp={onOpenMcp}
        onOpenManage={onOpenManage}
      />
    </header>
  );
}

function EditIcon() {
  const g = useId();
  return (
    <TopIcon
      line={
        <g transform="translate(0.47 0.07)">
          <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <g transform="rotate(-12 3 11)">
            <rect x="3" y="6.5" width="18" height="4.5" rx="1" />
            <path d="M8.5 6.5l2.5 4.5M14.5 6.5l2.5 4.5" />
          </g>
        </g>
      }
      lit={
        <>
          <Grad id={g} top="#ffd98f" bottom="#efa43c" y1={3} y2={20.5} />
          <g transform="translate(0.41 0.67)">
            <rect x="1.5" y="11" width="21" height="9.5" rx="2" fill={`url(#${g})`} />
            <g transform="rotate(-11 1.5 10.25)">
              <rect x="1.5" y="6" width="20.5" height="4.25" rx="1.1" fill="#8f5a1c" />
              <path d="M6.5 6h2.6l2.4 4.25H8.9zM13 6h2.6l2.4 4.25h-2.6z" fill={`url(#${g})`} />
            </g>
          </g>
        </>
      }
    />
  );
}

function AssetsIcon() {
  const g = useId();
  return (
    <TopIcon
      line={<path d="M3 6.5a2 2 0 0 1 2-2h4.2l2 2H19a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />}
      lit={
        <>
          <Grad id={g} top="#7fd48c" bottom="#53a667" y1={10.1} y2={19.8} />
          <g transform="translate(0 2.5)">
            <path
              d="M1.5 3.9C1.5 2.7 2.5 1.7 3.7 1.7h5c.6 0 1.2.25 1.6.7l1.3 1.4h8.7c1.2 0 2.2 1 2.2 2.2v9.1c0 1.2-1 2.2-2.2 2.2H3.7c-1.2 0-2.2-1-2.2-2.2V3.9Z"
              fill="#4c9260"
            />
            <path d="M1.5 7.6h21v7.5c0 1.2-1 2.2-2.2 2.2H3.7c-1.2 0-2.2-1-2.2-2.2V7.6Z" fill={`url(#${g})`} />
          </g>
        </>
      }
    />
  );
}

// 관리 = 아래 기준선에서 위로 솟는 막대(Jay 2026-10-26 — 처음 시안은 위에서 매달린 칸반이었다)
function ManageIcon() {
  const g = useId();
  return (
    <TopIcon
      line={
        <>
          <rect x="3" y="4" width="18" height="16" rx="2.5" />
          <path d="M8 9v7M12 12v4M16 7v9" />
        </>
      }
      lit={
        <>
          <Grad id={g} top="#d6c9ff" bottom="#9d86ec" y1={6.5} y2={17.5} />
          <rect x="1.5" y="3.5" width="21" height="17" rx="2.5" fill="#56449e" />
          <g fill={`url(#${g})`}>
            <rect x="4.5" y="9" width="4.4" height="8.5" rx="1.2" />
            <rect x="9.8" y="12.5" width="4.4" height="5" rx="1.2" />
            <rect x="15.1" y="6.5" width="4.4" height="11" rx="1.2" />
          </g>
        </>
      }
    />
  );
}
