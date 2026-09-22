import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent } from "react";
import { api } from "../../api";
import resolveIcon from "../../assets/davinci-resolve.png";
import type { ResolveLibraryProject, ResolveProjectDetail } from "../../lib/assetsApi";
import { dayInfoFromEpochSeconds } from "../../lib/dateGroups";
import { HttpError } from "../../lib/http";
import {
  getResolveConnectionStatus,
  type ResolveConnectionStatus,
} from "../../lib/resolveTransfer";
import { makeStore } from "../../lib/storage";
import { GridIcon, ListIcon } from "../common/ViewIcons";
import { AssetSortMenu } from "./AssetSortMenu";
import type { AssetSortDir } from "./assetsViewModel";

const DATE_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const LS = makeStore("ch.resolve.");
type SortField = "name" | "date" | "timelines" | "format" | "fps";
// Resolve Project Manager 정렬 메뉴와 같은 다섯 항목(Jay 2026-09-22). 에셋 정렬 메뉴를 그대로 쓴다.
const SORT_FIELDS: { key: SortField; label: string }[] = [
  { key: "name", label: "이름" },
  { key: "date", label: "수정 날짜" },
  { key: "timelines", label: "타임라인 수" },
  { key: "format", label: "해상도" },
  { key: "fps", label: "프레임 레이트" },
];
// 카드 크기 막대 — 에셋 탭 크기 막대와 같은 범위.
const SCALE_MIN = 0.7;
const SCALE_MAX = 1.7;
const clampScale = (value: number) =>
  Number.isFinite(value) ? Math.min(SCALE_MAX, Math.max(SCALE_MIN, value)) : 1;
// 카드 정보 첫 줄 — Resolve 화면의 "1920 x 1080 - 1 Timeline" 과 같은 내용.
const formatLine = (detail: ResolveProjectDetail) =>
  [detail.width && detail.height ? `${detail.width} x ${detail.height}` : "", `타임라인 ${detail.timelines}개`]
    .filter(Boolean)
    .join(" · ");
const NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const LAYOUTS = [
  { mode: "list" as const, label: "리스트", Icon: ListIcon },
  { mode: "grid" as const, label: "카드", Icon: GridIcon },
];

// Resolve 를 켠 뒤 열기를 다시 시도하는 한도. 창이 떠도 스크립트 API 는 더 늦을 수 있다(Codex P1) —
// 창 제목은 '창이 생겼다' 힌트일 뿐이고, 열기가 '준비 안 됨'(503)이면 마감까지 다시 연다.
const LAUNCH_DEADLINE_MS = 90_000;
const LAUNCH_POLL_MS = 2_000;
const OPEN_RETRY_MS = 3_000;
// Resolve 가 켜질 때 여는 이름 없는 새 프로젝트(backend resolve_project_open_worker._UNTITLED_NAME 와 같은 규칙 —
// 이름 전체가 'Untitled Project'(+ 번호)일 때만).
const UNTITLED_NAME = /^Untitled Project(?: \d+)?$/;

// 빈 화면 한가운데 놓이는 글이라 "HttpError: 400:" 같은 앞머리를 뗀다 — 사용자에게 뜻이 없다.
const failureText = (error: unknown) => String(error).replace(/^\w*Error:\s*(\d{3}:\s*)?/, "");
const projectKey = (item: ResolveLibraryProject) => `${item.folder_path}/${item.name}`;
// 503 = Resolve 가 꺼져 있거나 아직 준비 전(backend routers/assets._RESOLVE_NOT_READY_CODES).
const isNotReady = (error: unknown) => error instanceof HttpError && error.status === 503;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Chip {
  tone: "on" | "warn" | "off" | "error";
  detail: string;
}

// 머리글의 Resolve 상태. 화면 글자는 'Resolve' 하나고 상태는 점 색으로 본다(Jay 2026-09-22) — 풀어 쓴 말은
// 마우스를 올리면(title)·화면 읽기 프로그램으로(aria-label) 전한다(Codex P1: 색만으로 전하지 않는다).
// 상태는 라이브러리를 바꾸지 않고 받은 정보만 쓴다.
function statusChip(status: ResolveConnectionStatus | null, libraryName: string): Chip | null {
  if (!status) return null;
  if (status.status === "not_running") {
    return { tone: "off", detail: "Resolve 꺼짐 — 누르면 켜고 엽니다" };
  }
  if (status.status === "starting") {
    return { tone: "warn", detail: "Resolve 켜는 중…" };
  }
  if (status.status === "no_project") {
    return { tone: "on", detail: "Resolve 연결됨 · 열린 프로젝트 없음" };
  }
  if (status.status !== "ready") {
    return { tone: "error", detail: status.message || "Resolve 상태를 읽지 못했습니다" };
  }
  if (UNTITLED_NAME.test(status.project_name)) {
    return { tone: "warn", detail: "Resolve 켜짐 · 이름 없는 새 프로젝트" };
  }
  // 구버전 서버엔 database_name 이 없다 — 이 라이브러리인지 다른 라이브러리인지 단정하지 않는다(Codex P2).
  if (!status.database_name) {
    return { tone: "on", detail: `Resolve 연결됨 · 열린 프로젝트 ${status.project_name} (라이브러리 확인 불가)` };
  }
  if (status.database_name === libraryName) {
    return { tone: "on", detail: `Resolve 연결됨 · 지금 열린 프로젝트 ${status.project_name}` };
  }
  return {
    tone: "warn",
    detail: `Resolve 켜짐 · 다른 라이브러리(${status.database_name})의 ${status.project_name} 작업 중`,
  };
}

// 머리글 아이콘 — ViewIcons 와 같은 24격자·선 굵기. 16px 이라 26×24 단추 안 정수 자리(가로 5·세로 4)에 정중앙
// (15px 이면 반 픽셀에 걸려 0.5px 치우쳐 보였다, 2026-09-22 픽셀 실측).
const ICON = {
  viewBox: "0 0 24 24",
  width: 16,
  height: 16,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};
function LinkIcon() {
  return (
    <svg {...ICON} aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
      <path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
    </svg>
  );
}
function InfoIcon() {
  return (
    <svg {...ICON} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="11" x2="12" y2="16.5" />
      <circle cx="12" cy="7.6" r="0.6" fill="currentColor" />
    </svg>
  );
}

export function ResolveProjectBrowser({ project, dir }: { project: string; dir: string }) {
  const target = JSON.stringify([project, dir]);
  const targetRef = useRef(target);
  targetRef.current = target;
  const mountedRef = useRef(true);
  const listRequestIdRef = useRef(0);
  const operationIdRef = useRef(0);
  const statusRequestIdRef = useRef(0);
  const [projects, setProjects] = useState<ResolveLibraryProject[]>([]);
  const [libraryPath, setLibraryPath] = useState("");
  const [libraryName, setLibraryName] = useState("");
  const [thumbnails, setThumbnails] = useState<Record<string, string[]>>({});
  const [details, setDetails] = useState<Record<string, ResolveProjectDetail>>({});
  const [status, setStatus] = useState<ResolveConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [opening, setOpening] = useState("");
  const [phase, setPhase] = useState("");
  const [scrub, setScrub] = useState<{ key: string; x: number } | null>(null);
  const [layout, setLayout] = useState<"grid" | "list">(
    () => (LS.get("layout", "grid") === "list" ? "list" : "grid"),
  );
  const [sortField, setSortField] = useState<SortField>(() => {
    const saved = LS.get("sortField", "date");
    return SORT_FIELDS.find((item) => item.key === saved)?.key ?? "date";
  });
  const [sortDir, setSortDir] = useState<AssetSortDir>(
    () => (LS.get("sortDir", "desc") === "asc" ? "asc" : "desc"),
  );
  const [groupByDate, setGroupByDate] = useState(() => LS.get("groupByDate", "0") === "1");
  const [scale, setScale] = useState(() => clampScale(Number(LS.get("scale", "1"))));
  // ⓘ 정보 — 켜면 카드 이름 아래 두 줄(해상도·타임라인 / 수정 날짜), 끄면 이름만(Resolve 와 같게).
  const [showInfo, setShowInfo] = useState(() => LS.get("info", "1") !== "0");

  useEffect(() => LS.set("layout", layout), [layout]);
  useEffect(() => LS.set("sortField", sortField), [sortField]);
  useEffect(() => LS.set("sortDir", sortDir), [sortDir]);
  useEffect(() => LS.set("groupByDate", groupByDate ? "1" : "0"), [groupByDate]);
  useEffect(() => LS.set("scale", String(scale)), [scale]);
  useEffect(() => LS.set("info", showInfo ? "1" : "0"), [showInfo]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 켜는 동안 Resolve API 를 막는 건 서버다(켜기 창 — 상태 조회·선택 감시·가져오기, Jay 2026-09-22 B안).
  // 이 화면은 그동안 상태를 아예 묻지 않아 요청만 아낀다. 켜기가 끝나면 finally 에서 한 번 묻는다.
  const launchingRef = useRef(false);

  // 상태는 주기적으로 묻지 않는다 — 처음·작업 뒤·창으로 돌아올 때만(Resolve API 호출을 늘리지 않게).
  const refreshStatus = useCallback(async () => {
    if (launchingRef.current) return;
    const requestId = ++statusRequestIdRef.current;
    try {
      const next = await getResolveConnectionStatus();
      if (mountedRef.current && statusRequestIdRef.current === requestId) setStatus(next);
    } catch {
      if (mountedRef.current && statusRequestIdRef.current === requestId) setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const onFocus = () => void refreshStatus();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshStatus]);

  const loadProjects = useCallback(async () => {
    const requestTarget = target;
    const requestId = ++listRequestIdRef.current;
    const current = () =>
      targetRef.current === requestTarget && listRequestIdRef.current === requestId;
    setLoading(true);
    try {
      const result = await api.resolveLibraryProjects(project, dir);
      if (!current()) return;
      setProjects(result.projects);
      setLibraryPath(result.library_path);
      setLibraryName(result.library_name);
      setMessage("");
      // 새 목록의 그림·정보가 오기 전에 옛 것을 비운다 — 같은 이름의 다른 프로젝트 정보가 남지 않게(Codex P1).
      setThumbnails({});
      setDetails({});
      // 그림·카드 정보는 목록 뒤에 따로 — 처음엔 NAS 에서 복사하느라 1초 남짓 걸린다. 못 받으면 아이콘 자리표시.
      void api
        .resolveLibraryThumbnails(project, dir)
        .then((reply) => {
          if (!current()) return;
          setThumbnails(reply.thumbnails);
          setDetails(reply.details ?? {});
        })
        .catch(() => undefined);
    } catch (error) {
      if (!current()) return;
      setProjects([]);
      setLibraryPath("");
      setMessage(failureText(error));
    } finally {
      if (current()) setLoading(false);
    }
  }, [dir, project, target]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const connectLibrary = useCallback(async () => {
    if (connecting || opening) return;
    const requestTarget = target;
    const operationId = ++operationIdRef.current;
    const current = () =>
      targetRef.current === requestTarget && operationIdRef.current === operationId;
    setConnecting(true);
    setMessage("");
    try {
      const result = await api.openResolveLibraryConnectDialog(project, dir);
      if (current()) {
        // 서버가 Connect 까지 누르고 창이 닫힌 것을 확인했다(또는 이미 등록돼 있었다) — 바로 목록을 다시 읽는다.
        // 목록 읽기가 안내 글을 지우므로 글은 그 뒤에 둔다.
        await loadProjects();
        if (current()) setMessage(result.message);
      }
    } catch (error) {
      if (current()) setMessage(failureText(error));
    } finally {
      if (current()) {
        setConnecting(false);
        void refreshStatus();
      }
    }
  }, [connecting, dir, loadProjects, opening, project, refreshStatus, target]);

  const openProject = useCallback(
    async (item: ResolveLibraryProject) => {
      if (opening || connecting) return;
      const requestTarget = target;
      const operationId = ++operationIdRef.current;
      // 화면을 떠났거나 다른 작업이 시작됐으면 더는 요청을 보내지 않는다 — 늦게 열리는 일이 없게(Codex P1).
      const current = () =>
        mountedRef.current &&
        targetRef.current === requestTarget &&
        operationIdRef.current === operationId;
      // 켜기를 부르면 서버가 준 번호를 붙여 다시 연다 — 켜는 동안엔 이 번호가 맞는 열기만 Resolve 에 닿는다.
      let launchId = "";
      const attempt = () =>
        api.openResolveLibraryProject(project, dir, item.name, item.folder_path, launchId);
      setOpening(projectKey(item));
      setPhase("여는 중…");
      setMessage("");
      try {
        let result: Awaited<ReturnType<typeof attempt>>;
        try {
          result = await attempt();
        } catch (error) {
          if (!isNotReady(error)) throw error;
          // Resolve 가 꺼져 있거나 준비 전이거나 다른 작업이 쓰는 중이다 — 켜고(켜져 있으면 그대로) 창이 뜨길
          // 기다린 뒤 다시 연다. 서버는 켜고 바로 돌아오고, 기다림은 이 화면이 한다(서버가 요청을 붙잡지 않게).
          const deadline = Date.now() + LAUNCH_DEADLINE_MS;
          launchingRef.current = true;
          const launched = await api.launchResolve();
          if (!current()) return;
          launchId = launched.launch_id ?? "";
          setPhase(launched.status === "starting" ? "Resolve 켜는 중…" : "기다리는 중…");
          while (Date.now() < deadline) {
            const state = await api.resolveLaunchState();
            if (!current()) return;
            if (state.window) break;
            await wait(LAUNCH_POLL_MS);
            if (!current()) return;
          }
          setPhase("여는 중…");
          for (;;) {
            try {
              result = await attempt();
              break;
            } catch (retryError) {
              if (!isNotReady(retryError) || Date.now() + OPEN_RETRY_MS > deadline) throw retryError;
            }
            await wait(OPEN_RETRY_MS);
            if (!current()) return;
          }
        }
        // 이름 없는 빈 새 프로젝트가 열려 있어도 묻지 않는다 — 서버가 저장만 건너뛰고 바로 연다(Jay 2026-09-22).
        if (current()) setMessage(result.message);
      } catch (error) {
        if (current()) setMessage(failureText(error));
      } finally {
        launchingRef.current = false;
        if (current()) {
          setOpening("");
          setPhase("");
          void refreshStatus();
        }
      }
    },
    [connecting, dir, opening, project, refreshStatus, target],
  );

  const sorted = useMemo(() => {
    const rank = sortDir === "asc" ? 1 : -1;
    // 정렬 값 — 타임라인·해상도·fps 는 카드 정보(Project.db 복사본)에서. 해상도는 화소 수로 비교한다.
    const valueOf = (item: ResolveLibraryProject): number | undefined => {
      if (sortField === "date") return item.mtime;
      const detail = details[projectKey(item)];
      if (sortField === "timelines") return detail?.timelines;
      if (sortField === "format") return detail?.width && detail.height ? detail.width * detail.height : undefined;
      if (sortField === "fps") return detail?.fps;
      return undefined;
    };
    return [...projects].sort((a, b) => {
      let base = 0;
      if (sortField === "name") {
        base = NAME_COLLATOR.compare(a.name, b.name);
      } else {
        const va = valueOf(a);
        const vb = valueOf(b);
        // 값이 없는(정보가 아직 안 왔거나 못 읽은) 항목은 방향과 무관하게 뒤로.
        if (va === undefined || vb === undefined) {
          if (va !== vb) return va === undefined ? 1 : -1;
        } else {
          base = va - vb;
        }
      }
      if (base) return base * rank;
      // 같은 값이면 이름 → 폴더 오름차순(에셋 목록과 같은 규칙) — 순서가 흔들리지 않게.
      const byName = NAME_COLLATOR.compare(a.name, b.name);
      if (byName) return byName;
      return a.folder_path < b.folder_path ? -1 : a.folder_path > b.folder_path ? 1 : 0;
    });
  }, [details, projects, sortDir, sortField]);

  // 날짜로 나누기 — 정렬된 차례를 그대로 두고 날짜가 바뀌는 곳에서만 끊는다(에셋 탭 buildAssetRows 와 같은 규칙).
  const sections = useMemo(() => {
    if (!groupByDate) return [{ key: "all", label: "", items: sorted }];
    const out: { key: string; label: string; items: ResolveLibraryProject[] }[] = [];
    for (const item of sorted) {
      const { key, label } = dayInfoFromEpochSeconds(item.mtime);
      if (out[out.length - 1]?.key !== key) out.push({ key, label, items: [] });
      out[out.length - 1].items.push(item);
    }
    return out;
  }, [groupByDate, sorted]);

  // '열려 있음'은 힌트다 — 누르면 언제나 서버로 보낸다(Codex P1: 상태가 낡았을 수 있다).
  // 상태엔 폴더가 없으니 이 목록에서 이름이 하나뿐일 때만, 라이브러리 이름을 확인할 수 있을 때만 붙인다.
  const openKey = useMemo(() => {
    if (status?.status !== "ready" || !status.project_name) return "";
    if (!status.database_name || status.database_name !== libraryName) return "";
    const matches = projects.filter((item) => item.name === status.project_name);
    return matches.length === 1 ? projectKey(matches[0]) : "";
  }, [libraryName, projects, status]);

  const chip = statusChip(status, libraryName);
  const busy = connecting || Boolean(opening);
  const empty = !loading && projects.length === 0;
  // 머리글 끝의 한 줄 — 작업 결과(열었습니다·실패 이유), 빈 화면이면 라이브러리 경로.
  const headerNote = empty ? libraryPath : message;

  const onScrub = (event: ReactMouseEvent<HTMLElement>, key: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const x = Math.min(0.999, Math.max(0, (event.clientX - rect.left) / rect.width));
    setScrub({ key, x });
  };

  return (
    <div className="resolve-project-browser">
      {/* Assets 툴바(.assets-crumb·.assets-tools)와 같은 CSS 를 그대로 받는다 — 색·크기·단추 자리를 한 곳에서 맞춘다(Jay 2026-09-22). */}
      <header className="resolve-project-header assets-crumb" aria-live="polite">
        <div className="resolve-project-heading">
          <strong>DaVinci Resolve</strong>
          <span className="rp-count">· {loading ? "확인 중" : projects.length}</span>
          {chip && (
            <span className={`rp-status ${chip.tone}`} role="img" title={chip.detail} aria-label={chip.detail}>
              <b aria-hidden="true" />
              Resolve
            </span>
          )}
          {headerNote && <span className="rp-note">{headerNote}</span>}
        </div>
        {!empty && !loading && (
          <div className="resolve-project-tools assets-tools">
            {/* 에셋 툴바의 S·T·C 자리 — 사슬(다시 연결)과 ⓘ(정보). 목록이 보여도 Resolve 쪽에 라이브러리가 안 붙어
                있을 수 있어(열기가 그때 거절한다) 다시 연결을 남긴다. */}
            <div className="rp-pair">
              <button
                type="button"
                className="af-btn rp-icon-btn rp-relink"
                disabled={busy}
                title={connecting ? "연결하는 중…" : "라이브러리 다시 연결"}
                aria-label={connecting ? "연결하는 중…" : "라이브러리 다시 연결"}
                onClick={() => void connectLibrary()}
              >
                <LinkIcon />
              </button>
              <button
                type="button"
                className={"af-btn rp-icon-btn rp-info" + (showInfo ? " on" : "")}
                aria-pressed={showInfo}
                title={showInfo ? "정보 숨기기" : "정보 보기"}
                aria-label="정보 보기"
                onClick={() => setShowInfo((on) => !on)}
              >
                <InfoIcon />
              </button>
            </div>
            {/* 에셋 탭 크기 막대와 같은 모양·범위 — 카드 최소 폭과 리스트 그림 폭에 곱한다. */}
            <div className="size-slider" title="크기">
              <input
                type="range"
                aria-label="카드 크기"
                min={SCALE_MIN}
                max={SCALE_MAX}
                step={0.05}
                value={scale}
                onChange={(event) => setScale(clampScale(Number(event.target.value)))}
              />
            </div>
            {/* 에셋·생성 탭과 같은 규칙 — 켜져 있는 쪽을 한 번 더 누르면 날짜로 나눠 본다(ViewControls). */}
            <div className="layout-toggle">
              {LAYOUTS.map(({ mode, label, Icon }) => (
                <button
                  key={mode}
                  type="button"
                  className={
                    (layout === mode ? "on" : "") +
                    (layout === mode && groupByDate ? " grouped" : "")
                  }
                  title={layout === mode ? `${label} — 날짜로 나누기` : label}
                  onClick={() =>
                    layout === mode ? setGroupByDate((on) => !on) : setLayout(mode)
                  }
                >
                  <Icon />
                </button>
              ))}
            </div>
            <AssetSortMenu<SortField>
              field={sortField}
              dir={sortDir}
              fields={SORT_FIELDS}
              onField={setSortField}
              onDir={setSortDir}
            />
          </div>
        )}
      </header>

      {loading ? (
        <div className="resolve-project-state">프로젝트를 확인하고 있습니다.</div>
      ) : empty ? (
        <div className="resolve-project-empty">
          <div className="rpe-lead">
            {message || "이 프로젝트의 Resolve 라이브러리가 아직 연결되지 않았습니다."}
          </div>
          <button
            type="button"
            className="resolve-library-connect-button big"
            disabled={busy}
            onClick={() => void connectLibrary()}
          >
            {connecting ? "연결하는 중…" : "라이브러리 연결"}
          </button>
          <div className="rpe-hint">
            누르면 Resolve 에 이 폴더를 프로젝트 라이브러리로 연결합니다. Resolve 가 꺼져 있으면 켭니다.
          </div>
        </div>
      ) : (
        <div className="resolve-project-body" style={{ "--rp-scale": scale } as CSSProperties}>
          {sections.map((section) => (
            <Fragment key={section.key}>
              {groupByDate && <div className="gen-date-header">{section.label}</div>}
              <div className={layout === "list" ? "resolve-project-list" : "resolve-project-grid"}>
                {section.items.map((item) => {
                  const key = projectKey(item);
                  const frames = thumbnails[key] ?? [];
                  const scrubbing = scrub?.key === key && frames.length > 1;
                  const frame = scrubbing
                    ? frames[Math.min(frames.length - 1, Math.floor(scrub.x * frames.length))]
                    : frames[0];
                  const isOpen = openKey === key;
                  const detail = details[key];
                  return (
                    <button
                      type="button"
                      className={"resolve-project-card" + (isOpen ? " is-open" : "")}
                      key={key}
                      disabled={busy}
                      onClick={() => void openProject(item)}
                      title={`${item.name} 프로젝트 열기`}
                    >
                      <span
                        className="rp-thumb"
                        onMouseMove={frames.length > 1 ? (event) => onScrub(event, key) : undefined}
                        onMouseLeave={frames.length > 1 ? () => setScrub(null) : undefined}
                      >
                        {frame ? (
                          <img src={`data:image/jpeg;base64,${frame}`} alt="" draggable={false} />
                        ) : (
                          <img className="rp-placeholder" src={resolveIcon} alt="" draggable={false} />
                        )}
                        {isOpen && <span className="rp-open">● 열려 있음</span>}
                        {scrubbing && <span className="rp-scrub" style={{ left: `${scrub.x * 100}%` }} />}
                        {opening === key && <span className="rp-busy">{phase}</span>}
                      </span>
                      <span className="resolve-project-copy">
                        <strong>{item.name}</strong>
                        {showInfo && detail && <span className="rp-format">{formatLine(detail)}</span>}
                        {showInfo && (
                          <span className="rp-date">
                            {item.folder_path ? `${item.folder_path} · ` : ""}
                            수정 {DATE_FORMAT.format(new Date(item.mtime * 1000))}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
