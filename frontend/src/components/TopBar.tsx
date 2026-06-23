// 상단 바 (DESIGN.md §4): 로고 + 탭(내 작업/팀 공유) + 동기화 + 검색(우측) + Assets + 계정.
// 서버 모드: 단일 DB 를 모두가 공유하므로 번들 주고받기(JSON 내보내기/가져오기·공유 받기·
// 로컬 보관)는 불필요 → 제거. '구성(compose)' 탭도 숨김(기능은 유지, 진입만 비활성).
import { useEffect, useState } from "react";
import { api } from "../api";
import type { Filters } from "../types";
import { useT } from "../lib/i18n";
import { AccountMenu } from "./AccountMenu";
import { SearchBox } from "./SearchBox";

type Provider = { uid: string | null; name: string | null; email: string | null };

interface Props {
  filters: Filters;
  onTab: (tab: "my" | "team" | "compose") => void;
  onSearch: (q?: string) => void;
  onCache: () => void; // (서버 모드 미사용 — App 호환 위해 prop 유지)
  caching: boolean;
  onWorkspaceSwitched: () => void;
  onImported: (msg: string) => void; // (서버 모드 미사용 — App 호환)
  onOpenSpotlight: () => void; // (App 호환)
  onOpenAssets: () => void;
  onOpenAdmin: () => void; // 좌측 상단 로고 클릭 → 관리자 창(로드맵 §4-5)
  account?: import("../types").Account | null; // 로그인 계정(AUTH 모드)
  onLogout?: () => void;
}

export function TopBar({
  filters,
  onTab,
  onSearch,
  onWorkspaceSwitched,
  onOpenAssets,
  onOpenAdmin,
  account,
  onLogout,
}: Props) {
  const t = useT();
  // 제공자 신원 — CLI account status 이메일에서 잡힌 표시이름(계정 메뉴 표시용).
  const [provider, setProvider] = useState<Provider | null>(null);
  useEffect(() => {
    api.provider().then(setProvider).catch(() => {});
  }, []);

  return (
    <header className="topbar">
      <button
        className="brand"
        onClick={onOpenAdmin}
        title={t("관리자 — 멤버 등급·프로젝트 관리")}
      >
        ⬡ MV Hub
      </button>

      <nav className="tabs">
        <button
          className={filters.tab === "my" ? "on" : ""}
          onClick={() => onTab("my")}
        >
          {t("내 작업")}
        </button>
        <button
          className={filters.tab === "team" ? "on" : ""}
          onClick={() => onTab("team")}
        >
          {t("팀 공유")}
        </button>
        <button
          className={filters.tab === "compose" ? "on" : ""}
          onClick={() => onTab("compose")}
          title={t("히스토리 — 원본 → 파생 순서")}
        >
          {t("히스토리")}
        </button>
      </nav>

      {/* 좌(로고·탭) ↔ 우(검색·Assets·계정) 분리 */}
      <div className="topbar-spacer" />

      {/* 동기화 버튼 제거 — 자동 주기 동기화 + 계정 메뉴 '설정 → 전체 가져오기'로 대체 */}

      {/* 프롬프트·태그 검색 — 우측(구 '공유' 버튼 자리)으로 이동 */}
      <SearchBox
        className="topbar-search"
        placeholder="Search · Tag"
        value={filters.search}
        onSearch={onSearch}
      />

      {/* Assets(구성) 버튼 — 분리된 브라우저 창으로 연다 */}
      <button className="assets-btn" onClick={onOpenAssets} title={t("Assets (구성) — 별도 창")}>
        <span className="assets-thumb" />
        <span className="assets-label">Assets ⧉</span>
      </button>

      {/* 계정·워크스페이스 통합 메뉴 */}
      <AccountMenu
        provider={provider}
        account={account}
        onProviderUpdated={setProvider}
        onLogout={onLogout}
        onWorkspaceSwitched={onWorkspaceSwitched}
      />
    </header>
  );
}
