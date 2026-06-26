// 스포트라이트 프롬프트(항상 하단 도킹) — PV 스타일.
//  · contentEditable 프롬프트 + 선택 소스를 인라인 이미지 칩으로 삽입
//  · @ → 소스 피커, # → 태그 목록 피커. 태그 선택 시 tagFilter 고정 + @ 피커가 그 태그로 필터되어 열림
//  · Esc → 피커 닫기 / tagFilter 해제. 제출 시 본문 텍스트 + 칩→references 직렬화.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api";
import { buildPromptParts, refsToChips, refSrc } from "../lib/promptParts";
import {
  countImageChips,
  detectMention,
  hasContent,
  hideChipDropBar,
  insertChip,
  insertTextAtCaret,
  loadHistory,
  moveChipToPoint,
  partsText,
  placeCaretAtEnd,
  restoreParts,
  saveHistory,
  serialize,
  serializeParts,
  showChipDropBar,
  stripQuery,
  HIST_MAX,
} from "../lib/promptEditor";
import type { ChipRef, HistEntry } from "../lib/promptEditor";
import { flashMsg } from "../lib/flash";
import { useAccountStatus } from "../lib/useAccountStatus";
import { useCustomEvent } from "../lib/useCustomEvent";
import { useModels, ALLOWED, HIDDEN_PARAMS, effectiveDefault, numericRange } from "../lib/useModels";
import type { Generation } from "../types";

const MAX_COUNT = 4; // 한 번에 생성할 최대 장수(배치)

interface Props {
  // created: 방금 만든 pending 생성본들 — 즉시 '대기' 카드로 띄우게(optimistic). 없으면 그냥 리로드.
  // dragParentId: 카드를 드래그해 불러와 만든 경우 그 원본 gen id → 자동 히스토리(원본→파생) 부모.
  onCreated: (created?: Generation[], dragParentId?: string | null) => void;
  armedAutoTags: string[]; // 무장된 자동 태그 — 생성 시 결과물에 자동 적용(별도 네임스페이스)
  topSlot?: ReactNode; // 도크 상단(프롬프트 바로 위)에 끼우는 슬롯 — 멀티 선택 바
  activeProjectId?: string; // 현재 보고 있는 프로젝트 — 생성 시 자동 귀속(로드맵 §0-4)
  expanded: boolean; // '+' 확장 — 레퍼런스 트레이(위)+프롬프트(아래) 2단. App 이 보유.
  onToggleExpand: () => void; // '+' 버튼 토글
}

// 트레이 항목 = 레퍼런스(ChipRef) + 고유키(uid). 같은 파일 중복 허용이라 file_path 를 key 로 못 쓴다.
type TrayRef = ChipRef & { uid: string };

// 노출 모델 화이트리스트(ALLOWED)·숨김 파라미터(HIDDEN_PARAMS)·모델/파라미터/비용 로직은
// useModels 훅으로 추출. onPanelDrop 에서 쓰는 상수만 훅 모듈에서 import 해 재사용.

// duration 초 범위 — CLI 스키마(model get)에 min/max 가 없어 모델 스펙(models_explore)으로 보강.
//  seedance_2_0: 힉스필드 공식 스펙 duration_range = {min:4, max:15}.
//    (generate cost 는 선형 계산기라 16s·60s 도 에러 없이 값을 내므로 한도 검증에 못 씀.)
const DURATION_RANGE: Record<string, { min: number; max: number }> = {
  seedance_2_0: { min: 4, max: 15 },
};
function durRange(model: string, def: number): { min: number; max: number } {
  return DURATION_RANGE[model] || { min: 1, max: Math.max(12, def * 2) };
}

function usesSingleStartImage(model: string): boolean {
  return model.startsWith("seedance");
}

// 컨트롤 행 정리(칸 부족 해소): 자주 바꾸는 핵심 파라미터만 인라인 칩으로 두고,
// 그 외(모드·비트레이트·장르 등 값만으론 의미가 모호한 것)는 '⚙ 고급' 팝오버로 모은다.
// 모델 비종속 — 모델이 파라미터를 추가해도 자동으로 고급으로 흡수된다.
const PRIMARY_PARAMS = new Set(["aspect_ratio", "resolution", "duration"]);

// 고급 팝오버 표시 순서(요청: 모드 → 장르 → 비트레이트). 목록에 없는 건 뒤에 원래 순서로.
const ADV_ORDER = ["mode", "genre", "bitrate_mode"];
const advRank = (name: string): number => {
  const i = ADV_ORDER.indexOf(name);
  return i === -1 ? ADV_ORDER.length : i;
};

// 파라미터 풀 라벨(고급 팝오버·툴팁용) — 값만 보여선 뭔지 모르는 문제 해소.
const PARAM_LABEL: Record<string, string> = {
  aspect_ratio: "비율",
  resolution: "해상도",
  duration: "길이",
  bitrate_mode: "비트레이트",
  genre: "장르",
  mode: "모드",
  quality: "품질",
  // batch_size 는 UI 에서 숨김(앱 레벨 count=1/4 로 일원화). 라벨 불필요.
};
const paramLabel = (name: string): string => PARAM_LABEL[name] || name;

// 일부 값에 의미 라벨(원값 + 한글 힌트) — 그 외는 원값 그대로.
const VALUE_LABEL: Record<string, string> = {
  std: "표준(std)",
  fast: "빠름(fast)",
  standard: "표준(standard)",
  high: "고화질(high)",
  auto: "자동(auto)",
};
const valueLabel = (v: string): string => VALUE_LABEL[v] || v;

// 에셋 파트(분리창)가 localStorage 에 쓴 현재 프로젝트/폴더 — 생성 피커 소스 스코프.
function readAssetCtx(): { project: string; dir: string } {
  try {
    return {
      project: localStorage.getItem("ch.assets.project") || "",
      dir: localStorage.getItem("ch.assets.dir") || "",
    };
  } catch {
    return { project: "", dir: "" };
  }
}

// 에셋 드래그 페이로드(application/x-ch-asset) 파싱 — 항상 배열로 정규화(옛 단건 객체 하위호환),
// 이미지/영상만(오디오·폴더 제외). 잘못된 데이터는 빈 배열. 트레이/인라인 드롭 공용.
type AssetDragItem = { project: string; path: string; name: string; type: string };
function parseAssetItems(raw: string): AssetDragItem[] {
  try {
    const parsed = JSON.parse(raw);
    const list = (Array.isArray(parsed) ? parsed : [parsed]) as AssetDragItem[];
    return list.filter((d) => d && (d.type === "image" || d.type === "video"));
  } catch {
    return [];
  }
}
// 에셋 항목 → ChipRef 공통 필드(role/uid 는 호출측이 채움). thumb: 영상은 파일URL(<video>), 이미지는 썸네일.
function assetRefBase(d: AssetDragItem): Omit<ChipRef, "role"> {
  const isVid = d.type === "video";
  return {
    file_path: `asset:${d.project}|${d.path}`, // 에이전트가 받아 로컬 파일로 CLI 에 전달
    type: isVid ? "video" : "image",
    name: d.name,
    thumb: isVid ? api.assetFileUrl(d.project, d.path) : api.assetThumbUrl(d.project, d.path, 256),
  };
}

// 모델 옵션 칩 라벨 → 아이콘(텍스트 라벨이 길어 두 줄 되는 것 방지). 이름 키워드로 매칭, 폴백=슬라이더.
function OptIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  const p = {
    width: 13, height: 13, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 2,
    strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  if (n.includes("aspect") || n.includes("ratio") || n.includes("frame"))
    return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /></svg>;
  if (n.includes("duration") || n.includes("time") || n.includes("length") || n.includes("second"))
    return <svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
  if (n.includes("resolution") || n.includes("quality") || n.includes("size"))
    return <svg {...p}><path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" /></svg>;
  if (n.includes("genre") || n.includes("style") || n.includes("preset"))
    return <svg {...p}><path d="M3 7l9-4 9 4-9 4-9-4z" /><path d="M3 12l9 4 9-4" /></svg>;
  if (n.includes("bitrate") || n.includes("bit_rate"))
    return <svg {...p}><path d="M3 17l5-5 4 4 8-8" /><path d="M16 4h5v5" /></svg>;
  if (n.includes("fps") || n.includes("motion") || n.includes("frame_rate"))
    return <svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 5v14M17 5v14" /></svg>;
  if (n.includes("seed"))
    return <svg {...p}><rect x="4" y="4" width="16" height="16" rx="3" /><circle cx="9" cy="9" r="1" /><circle cx="15" cy="15" r="1" /></svg>;
  if (n.includes("mode"))
    return <svg {...p}><circle cx="8" cy="8" r="2" /><circle cx="16" cy="16" r="2" /><path d="M8 10v8M16 6v8" /></svg>;
  // 폴백: 슬라이더(일반 설정)
  return <svg {...p}><path d="M5 8h14M5 16h14" /><circle cx="10" cy="8" r="2.4" fill="currentColor" stroke="none" /><circle cx="15" cy="16" r="2.4" fill="currentColor" stroke="none" /></svg>;
}

export function SpotlightPrompt({
  onCreated,
  armedAutoTags,
  topSlot,
  activeProjectId,
  expanded,
  onToggleExpand,
}: Props) {
  // 모델/파라미터/비용 로직은 useModels 훅으로 추출(동작 100% 보존). 로드 실패는 setError 로 보고.
  const { type, setType, model, setModel, tunable, constraints, typeModels, modelName,
          optionValues, setOptionValues, setOpt, cost, costLoading, pendingOptsRef, setOpenRef } =
    useModels((msg) => setError(msg));
  const [count, setCount] = useState(1); // 한 번에 N장 생성(배치)
  const [open, setOpen] = useState<string | null>(null); // 열린 드롭다운 키(파라미터명 또는 'model')
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // setOpt 가 옵션 선택 후 드롭다운을 닫도록 훅에 setOpen 등록(open/setOpen 은 UI 상태로 컴포넌트에 잔류).
  setOpenRef.current = setOpen;
  // 계정·CLI 연결 상태(크레딧·이메일 부차 정보) — 데이터 도메인 훅으로 분리(IME·에디터 무관).
  const { account, checkAccount } = useAccountStatus();
  // 에이전트 연결 — push 모델에서 생성/재생성은 내 PC 에이전트가 떠 있어야 실행되므로,
  // 푸터의 '연결됨' 점은 (서버 CLI 가 아니라) 내 에이전트 연결 = '생성 가능' 여부를 가리킨다.
  // 폴링은 서버 메모리 상태(agent_signals)만 읽어 가볍다(CLI 비용 없음).
  const [agentOn, setAgentOn] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const check = () =>
      api
        .agentStatus()
        .then((s) => alive && setAgentOn(s.connected))
        .catch(() => alive && setAgentOn(null));
    check();
    const id = window.setInterval(check, 12000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  // @/# 피커
  const [mention, setMention] = useState<{ kind: "@" | "#"; query: string } | null>(null);
  const [allSources, setAllSources] = useState<Generation[]>([]);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [hIdx, setHIdx] = useState(0);
  const [assetCtx, setAssetCtx] = useState(readAssetCtx);
  // ── 확장(+) 레퍼런스 트레이 — 에셋 폴더 드래그 전용. 순서 = 생성 --image 순서 ──
  // uid: 같은 파일을 중복으로 넣을 수 있어 file_path 가 겹치므로 React key·재정렬용 고유키.
  const [trayRefs, setTrayRefs] = useState<TrayRef[]>([]);
  const trayDragIdx = useRef<number | null>(null); // 트레이 내부 재정렬 시작 인덱스
  const trayUidRef = useRef(0); // 트레이 항목 고유키 카운터(중복 허용)
  const editorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  // 프롬프트 기록(쉘식 ↑↓): historyRef=제출 기록(오래된→최신), histIdxRef=탐색 위치(-1=라이브)
  const historyRef = useRef<HistEntry[]>(loadHistory());
  const histIdxRef = useRef(-1);
  // 드래그해서 불러온 원본 gen id — 다음 생성의 자동 히스토리(원본→파생) 부모. 제출 시 1회 소모.
  const dragParentRef = useRef<string | null>(null);

  const updatePlaceholder = () => {
    const ed = editorRef.current;
    if (ed) ed.toggleAttribute("data-empty", !hasContent(ed));
  };

  useEffect(() => {
    editorRef.current?.focus();
    updatePlaceholder();
  }, []);

  // Ctrl/⌘+K(또는 툴바 버튼) → 프롬프트로 포커스만.
  useCustomEvent("ch:focus-prompt", () => editorRef.current?.focus());

  // (프롬프트 재사용은 카드를 입력바로 드래그-드롭하면 동작 — onPanelDrop→reusePromptFromGen 직접
  //  호출. 이벤트(ch:reuse-prompt) 경로는 디스패처가 없어 제거함.)

  // 카드의 '레퍼런스로 사용'(@) 버튼 → 그 생성물을 레퍼런스로 추가(확장이면 트레이, 아니면 인라인 칩).
  // useCustomEvent 가 항상 최신 addRefFromGen(최신 expanded)을 호출 → stale 분기 버그 없음.
  useCustomEvent("ch:add-reference", (e) => {
    const id = (e as CustomEvent<string>).detail;
    if (id) void addRefFromGen(id);
  });

  // 에셋 파트(분리창) 프로젝트 변경 알림 → 컨텍스트 갱신.
  // 값이 실제로 바뀐 경우에만 갱신(스크롤 저장 등 다른 ch.assets.* 쓰기로 인한 재요청 폭주 방지).
  useEffect(() => {
    const update = () =>
      setAssetCtx((prev) => {
        const next = readAssetCtx();
        return next.project === prev.project && next.dir === prev.dir ? prev : next;
      });
    const bc = "BroadcastChannel" in window ? new BroadcastChannel("ch-assets") : null;
    bc?.addEventListener("message", update);
    window.addEventListener("storage", update);
    return () => {
      bc?.removeEventListener("message", update);
      bc?.close();
      window.removeEventListener("storage", update);
    };
  }, []);

  // 피커가 열리면 현재 에셋 프로젝트의 모든 S 소스를 로드(폴더 무관 — 클라서 이름/태그 필터).
  useEffect(() => {
    if (!mention) return;
    let alive = true;
    // 프로젝트 전환 시 이전 프로젝트 소스를 즉시 비운다 — 안 그러면 새 응답 도착 전까지 다른
    // 프로젝트의 소스가 보이고, 그 순간 Enter 로 엉뚱한 소스를 고를 수 있다.
    setAllSources([]);
    api
      .searchSources(undefined, undefined, assetCtx.project)
      .then((r) => alive && setAllSources(r))
      .catch(() => alive && setAllSources([]));
    return () => {
      alive = false;
    };
  }, [mention?.kind, assetCtx.project]);

  // 태그 목록(개수 포함) — # 피커. mention.query 로 필터.
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of allSources) for (const t of s.tags) m.set(t, (m.get(t) || 0) + 1);
    return m;
  }, [allSources]);
  const tagList = useMemo(() => {
    let tags = [...tagCounts.keys()];
    const q = mention?.kind === "#" ? mention.query.toLowerCase() : "";
    if (q) tags = tags.filter((t) => t.toLowerCase().includes(q));
    return tags.sort((a, b) => a.localeCompare(b));
  }, [tagCounts, mention]);

  // 소스 목록 — @ 피커. tagFilter 로 거른 뒤 이름 필터.
  const sourceList = useMemo(() => {
    let base = allSources;
    if (tagFilter) base = base.filter((s) => s.tags.includes(tagFilter));
    const q = mention?.kind === "@" ? mention.query.toLowerCase() : "";
    if (q) base = base.filter((s) => (s.source_name || "").toLowerCase().includes(q));
    return base;
  }, [allSources, tagFilter, mention]);

  // 멘션/리스트 바뀌면 하이라이트 0 으로.
  useEffect(() => setHIdx(0), [mention?.kind, mention?.query, tagFilter, allSources]);

  // 방향키로 하이라이트 이동 시 그 항목이 보이게 리스트 스크롤(↓ 로 내려가면 함께 이동).
  useEffect(() => {
    listRef.current
      ?.querySelector(".sl-mention-item.on")
      ?.scrollIntoView({ block: "nearest" });
  }, [hIdx]);

  // 실제 입력(내용 변경) — 기록 탐색 종료(사용자가 편집 시작).
  const onEditorInput = () => {
    const ed = editorRef.current;
    if (!ed) return;
    histIdxRef.current = -1;
    updatePlaceholder();
    setMention(composingRef.current ? null : detectMention(ed));
  };
  // 화면 캡쳐 붙여넣기(Ctrl+V) — 클립보드의 이미지를 내장 'captures' 폴더에 올리고 곧바로
  // 레퍼런스로 추가(확장=트레이, 접힘=인라인 칩). 이미지가 아니면 기본 텍스트 붙여넣기 유지.
  const onEditorPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let blob: File | null = null;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        blob = items[i].getAsFile();
        break;
      }
    }
    if (!blob) return; // 이미지 없음 → 기본 동작(텍스트 붙여넣기)
    e.preventDefault();
    api
      .uploadCapture(blob)
      .then((r) =>
        addAssetRefs(JSON.stringify([{ project: r.project, path: r.path, name: r.name, type: "image" }])),
      )
      .catch((err) => flashMsg("캡쳐 추가 실패: " + String(err)));
  };

  // 프롬프트 전체를 클립보드로 복사 — @소스명 토큰을 포함한 표시 프롬프트(화면 그대로).
  const copyPrompt = () => {
    const ed = editorRef.current;
    if (!ed) return;
    const txt = partsText(serializeParts(ed)) || serialize(ed).text;
    if (!txt) {
      flashMsg("복사할 프롬프트가 없습니다");
      return;
    }
    navigator.clipboard?.writeText(txt).then(
      () => flashMsg("프롬프트를 복사했습니다"),
      () => flashMsg("복사 실패"),
    );
  };
  // 캐럿 이동(keyup/click) — 멘션만 재감지(기록 탐색·placeholder 는 건드리지 않음).
  const onCaretMove = () => {
    const ed = editorRef.current;
    if (ed && !composingRef.current) setMention(detectMention(ed));
  };

  const selectTag = (tag: string) => {
    const ed = editorRef.current;
    if (ed) {
      stripQuery(ed, "#");
      insertTextAtCaret(ed, "@"); // 그 태그로 필터된 @ 소스 피커 자동 오픈
      updatePlaceholder();
    }
    setTagFilter(tag);
    setMention({ kind: "@", query: "" });
    ed?.focus();
  };

  const selectSource = (s: Generation) => {
    const ed = editorRef.current;
    if (!ed) return;
    const a = s.assets[0];
    if (!a) return;
    const isVid = a.type === "video";
    const ref: ChipRef = {
      file_path: a.source_url || a.file_path,
      type: a.type,
      role: isVid ? "@Video" : `@Image${countImageChips(ed) + 1}`,
      name: s.source_name || "source",
      thumb: a.thumbnail_path || a.file_path,
      source_gen_id: s.id, // 출처 generation → 히스토리 reference 엣지 기록용
    };
    insertChip(ed, ref);
    updatePlaceholder();
    setMention(null);
    ed.focus();
  };

  const clearTagFilter = () => setTagFilter(null);

  // ── 프롬프트 재사용(명시적): 그 생성의 프롬프트+옵션을 입력바로 그대로 불러옴 ──
  //    카드 오버레이의 '프롬프트 재사용' 버튼(ch:reuse-prompt 이벤트)이 호출. 드래그와 분리.
  const reusePromptFromGen = async (id: string) => {
    try {
      const g = await api.getGeneration(id);
      // 재사용 원본 → 다음 생성의 자동 히스토리 부모(원본→파생).
      dragParentRef.current = id;
      const t: "image" | "video" = g.assets[0]?.type === "video" ? "video" : "image";
      // 원래 모델이 화이트리스트에 있으면 유지, 아니면 타입 기본(첫째)로 클램프
      const useModel = ALLOWED[t].includes(g.model || "") ? (g.model as string) : ALLOWED[t][0];
      // 표시 옵션만 추려 임시 보관(프롬프트·미디어 등 내부 파라미터 제외).
      const opts: Record<string, string | number | boolean> = {};
      for (const [k, v] of Object.entries(g.params || {})) {
        if (
          !HIDDEN_PARAMS.has(k) &&
          (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        ) {
          opts[k] = v;
        }
      }
      setType(t);
      if (useModel === model) {
        // 모델 동일 → [model] effect 안 돎. 옵션을 직접 병합.
        setOptionValues((prev) => ({ ...prev, ...opts }));
      } else {
        pendingOptsRef.current = { model: useModel, opts }; // 그 모델 로드 때 기본값 위에 덮음(model 스탬프)
        setModel(useModel);
      }
      const ed = editorRef.current;
      if (expanded) {
        // 확장(+) 상태 = 레퍼런스는 위 트레이로, 프롬프트 텍스트는 아래 박스로 분리해 채운다.
        setTrayRefs(
          refsToChips(g.references).flatMap((p) =>
            p.t === "chip"
              ? [{ ...(p.ref as ChipRef), uid: `t${trayUidRef.current++}` }]
              : [],
          ),
        );
        const ptext = g.prompt && g.prompt !== "(no text)" ? g.prompt : "";
        if (ed) {
          restoreParts(ed, ptext ? [{ t: "text" as const, v: ptext }] : []); // 칩 없이 텍스트만
          updatePlaceholder();
          ed.focus();
        }
      } else {
        // 일반(접힘) — 프롬프트(칩+텍스트) 인라인 복원. display_prompt 로 칩 위치를 살리되,
        // 매칭 칩이 하나도 없고 레퍼런스가 있으면(옛 생성) 말미에 칩으로 붙인다.
        let parts = buildPromptParts(g.display_prompt || g.prompt || "", g.references);
        if (!parts.some((p) => p.t === "chip") && g.references.length) {
          parts = [...parts, ...refsToChips(g.references)];
        }
        if (ed) {
          restoreParts(ed, parts); // 재사용은 '교체' — 입력바를 그 프롬프트로 채움
          updatePlaceholder();
          ed.focus();
        }
      }
      setMention(null);
      histIdxRef.current = -1;
    } catch (err) {
      setError(String(err));
    }
  };

  // ── 카드 상호작용(맞바꿈) ──────────────────────────────────────────────
  //  · 카드를 프롬프트로 끌어내림(드롭) = '프롬프트 재사용'(그 프롬프트·옵션을 입력바로 불러옴)
  //  · 카드의 '@' 버튼(ch:add-reference) = 그 생성물을 '레퍼런스로 추가'(확장이면 트레이, 아니면 칩)
  //    (이전엔 드롭=레퍼런스, ✎=재사용이었다 — 사용자 요청으로 서로 교환)
  const onPanelDragOver = (e: React.DragEvent) => {
    const tps = e.dataTransfer.types;
    // 카드(x-ch-gen)=재사용 · 에셋(x-ch-asset)=레퍼런스 추가. 둘 다 프롬프트로 끌어내려 받는다.
    if (tps.includes("application/x-ch-gen") || tps.includes("application/x-ch-asset")) {
      e.preventDefault(); // drop 허용 + contentEditable 기본 삽입 차단
      e.dataTransfer.dropEffect = "copy";
    }
  };
  const addRefFromGen = async (id: string) => {
    try {
      const g = await api.getGeneration(id);
      const a = g.assets[0];
      const ed = editorRef.current;
      if (!ed) return;
      if (!a) {
        // 생성중·실패·NSFW 등 미디어 없는 카드 → 조용히 무시하지 말고 이유를 알린다.
        setError("이 항목엔 사용할 미디어가 없습니다 (생성중/실패).");
        return;
      }
      const isVid = a.type === "video";
      const ref: ChipRef = {
        file_path: a.source_url || a.file_path,
        type: a.type,
        role: isVid ? "@Video" : `@Image${countImageChips(ed) + 1}`,
        // 칩 이름: 소스명(등록 시) 우선, 없으면 고유 ID(앞 8자리 — 4자리는 충돌 가능)
        name: g.source_name || `${isVid ? "vid" : "img"}-${g.id.slice(0, 8)}`,
        thumb: a.thumbnail_path || a.file_path,
        source_gen_id: g.id, // 출처 generation → 히스토리 reference 엣지
      };
      if (expanded) {
        // 확장(+) 상태 = 위 트레이에 레퍼런스로 추가(번호순). 중복 허용 — 같은 생성물도 여러 번.
        setTrayRefs((prev) => [
          ...prev,
          { ...ref, uid: `t${trayUidRef.current++}`, role: isVid ? "@Video" : "@Image" },
        ]);
      } else {
        // 접힘 = 인라인 칩으로 누적. 중복 허용 — '레퍼런스로 사용'을 누를 때마다 같은 생성물도 다시 추가.
        insertChip(ed, ref);
        updatePlaceholder();
        ed.focus();
      }
    } catch (err) {
      setError(String(err));
    }
  };
  const onPanelDrop = (e: React.DragEvent) => {
    const gen = e.dataTransfer.getData("application/x-ch-gen");
    if (gen) {
      e.preventDefault();
      void reusePromptFromGen(gen); // 카드 끌어내림 = 프롬프트 재사용(불러오기)
      return;
    }
    if (e.dataTransfer.types.includes("application/x-ch-asset")) {
      e.preventDefault();
      addAssetRefs(readAssetPayload(e)); // 에셋 끌어내림 = 레퍼런스(확장=트레이, 접힘=인라인 칩) · 다중 일괄
    }
  };

  // ── 레퍼런스 트레이(확장 모드) — 에셋 폴더 드래그로 추가 + 드래그로 재정렬 ──
  // 에셋 셀 dragstart 가 심은 application/x-ch-asset 만 받는다(카드·@ 아님). 값은 항상 배열 —
  // 다중선택을 그리드 순서대로 한 번에 받는다(옛 단건 객체도 하위호환으로 수용).
  const addAssetToTray = (raw: string) => {
    // 중복 허용(같은 파일도 여러 번) — dedup 안 함. uid 로 구분. 다중선택은 배열로 한 번에 추가.
    const additions: TrayRef[] = parseAssetItems(raw).map((d) => ({
      ...assetRefBase(d),
      uid: `t${trayUidRef.current++}`,
      role: d.type === "video" ? "@Video" : "@Image", // 제출 시 순서대로 재번호
    }));
    if (additions.length) setTrayRefs((prev) => [...prev, ...additions]);
  };
  // 에셋 드롭 공용(프롬프트 패널/트레이): 확장이면 트레이로, 접힘이면 인라인 칩으로 — 다중선택 일괄.
  const addAssetRefs = (raw: string) => {
    if (expanded) {
      addAssetToTray(raw); // 트레이(배열 그대로 — 중복 허용)
      return;
    }
    const ed = editorRef.current;
    if (!ed) return;
    let added = false;
    for (const d of parseAssetItems(raw)) {
      insertChip(ed, {
        ...assetRefBase(d),
        role: d.type === "video" ? "@Video" : `@Image${countImageChips(ed) + 1}`, // 칩마다 다음 슬롯
      });
      added = true;
    }
    if (added) {
      updatePlaceholder();
      ed.focus();
    }
  };
  const removeTrayRef = (i: number) => setTrayRefs((prev) => prev.filter((_, j) => j !== i));
  // 트레이에 포커스를 둔 채 Shift+Backspace = 레퍼런스만 전체 삭제(프롬프트는 그대로).
  const onTrayKeyDown = (e: React.KeyboardEvent) => {
    const isBackspace =
      e.key === "Backspace" || e.code === "Backspace" || (e.nativeEvent as KeyboardEvent).keyCode === 8;
    if (isBackspace && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      setTrayRefs([]);
    }
  };
  const onTrayDragOver = (e: React.DragEvent) => {
    const tps = e.dataTransfer.types;
    if (tps.includes("application/x-ch-asset") || tps.includes("application/x-ch-trayidx")) {
      e.preventDefault();
      e.stopPropagation(); // 패널의 카드-드롭 핸들러로 번지지 않게(트레이는 에셋 전용)
      e.dataTransfer.dropEffect = trayDragIdx.current !== null ? "move" : "copy";
    }
  };
  // 에셋 드래그 페이로드 — 에셋창이 dragstart 에 localStorage 로 넘긴 '전체 선택'을 우선 읽는다
  // (일부 브라우저가 팝업↔본창 크로스윈도우 드래그에서 dataTransfer 커스텀 배열을 한 건만 전달하는
  // 문제 우회). 없으면 dataTransfer 폴백. 호출 전 반드시 x-ch-asset 타입 존재를 확인할 것(스테일 방지).
  const readAssetPayload = (e: React.DragEvent): string => {
    let drag = "";
    try {
      drag = localStorage.getItem("ch.assets.drag") || "";
    } catch {
      /* ignore */
    }
    if (!drag) drag = e.dataTransfer.getData("application/x-ch-asset");
    // 드래그 페이로드가 한 건인데, 그 항목이 '라이브 다중선택'에 들어 있으면 다중선택을 끌어온
    // 것으로 보고 선택 전체를 쓴다(드래그 시점 selection 캡처가 어긋나는 경우까지 복구).
    try {
      const arr = drag ? JSON.parse(drag) : [];
      const list = Array.isArray(arr) ? arr : [arr];
      if (list.length <= 1) {
        const selRaw = localStorage.getItem("ch.assets.selection");
        const sel = selRaw ? JSON.parse(selRaw) : [];
        const dragged = list[0]?.path;
        if (Array.isArray(sel) && sel.length > 1 && (!dragged || sel.some((s) => s.path === dragged)))
          return selRaw as string;
      }
    } catch {
      /* 파싱 실패 시 원래 페이로드 사용 */
    }
    return drag;
  };
  const onTrayDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("application/x-ch-asset"))
      addAssetToTray(readAssetPayload(e)); // 빈 영역 = 끝에 추가(재정렬은 항목에서)
  };
  const onTrayItemDragStart = (i: number) => (e: React.DragEvent) => {
    trayDragIdx.current = i;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("application/x-ch-trayidx", String(i));
  };
  const onTrayItemDrop = (i: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("application/x-ch-asset")) {
      addAssetToTray(readAssetPayload(e)); // 항목 위에 에셋 떨어뜨려도 추가
      trayDragIdx.current = null;
      return;
    }
    const from = trayDragIdx.current;
    trayDragIdx.current = null;
    if (from === null || from === i) return;
    setTrayRefs((prev) => {
      const arr = [...prev];
      const [m] = arr.splice(from, 1);
      arr.splice(i, 0, m); // from → i 위치로 이동
      return arr;
    });
  };

  const submit = async () => {
    setError(null);
    const ed = editorRef.current;
    if (!ed) return;
    const { text, refs: inlineRefs } = serialize(ed);
    // 확장 트레이 레퍼런스(순서) + 인라인 @칩 레퍼런스를 합치고 image role 을 순서대로 재번호
    // (@Image1..N). 이 순서가 곧 생성 시 CLI --image 전달 순서다.
    let imgN = 0;
    const refs = [...trayRefs, ...inlineRefs].map((r) =>
      r.type === "image" ? { ...r, role: `@Image${++imgN}` } : { ...r, role: "@Video" },
    );
    if (!text && refs.length === 0) {
      setError("프롬프트를 입력하세요.");
      ed.focus();
      return;
    }
    if (!model) {
      setError("모델을 선택하세요.");
      return;
    }
    if (type === "video" && usesSingleStartImage(model)) {
      const imageRefs = refs.filter((r) => r.type === "image");
      if (imageRefs.length > 0) {
        setError(
          "현재 Higgsfield CLI는 Seedance의 이미지 칩을 엘리먼트 레퍼런스가 아니라 시작 이미지로 처리합니다. 시작 프레임 없이 쓰려면 이미지 칩을 삭제하고 프롬프트 텍스트로 작성하세요.",
        );
        ed.focus();
        return;
      }
    }
    // 표시용 프롬프트(칩 자리에 @소스명) — CLI 본문(text)과 분리해 저장.
    const parts = serializeParts(ed);
    const displayPrompt = partsText(parts);
    setBusy(true);
    try {
      const body = {
        prompt: text || "(no text)",
        display_prompt: displayPrompt || undefined,
        model,
        params: optionValues,
        auto_tags: armedAutoTags, // 무장된 자동 태그를 결과물에 자동 적용
        references: refs.map((r) => ({
          file_path: r.file_path,
          type: r.type,
          role: r.role,
          name: r.name, // 칩 이름(@소스명) — 정보팝업 인라인 칩 매칭
          thumbnail: r.thumb, // 표시용 썸네일(에셋 소스도 정보팝업에서 이미지로 보이게)
          source_gen_id: r.source_gen_id, // 출처 generation → 히스토리 reference 엣지
        })),
        project_id: activeProjectId, // 보던 프로젝트로 자동 귀속(없으면 미분류)
      };
      // 배치: 같은 설정으로 N장 동시 생성(각각 별도 잡).
      const created = await Promise.all(
        Array.from({ length: Math.max(1, count) }, () => api.create(body)),
      );
      // 드래그로 불러온 원본이 있으면 그것을 부모로 자동 히스토리 기록(App 이 처리). 1회 소모.
      const dragParent = dragParentRef.current;
      dragParentRef.current = null;
      onCreated(created, dragParent); // 방금 만든 pending 들을 즉시 '대기' 카드로(optimistic) + 리로드
      // 프롬프트 기록에 추가 — 텍스트+칩 구조 보존. 같은 내용은 전부 제거 후 최신으로,
      // 최근 HIST_MAX(20)개만 유지.
      const key = displayPrompt; // 텍스트+@칩 까지 반영한 중복 판정 키
      if (key) {
        const filtered = historyRef.current.filter((h) => h.text !== key);
        filtered.push({ parts, text: key });
        historyRef.current = filtered.slice(-HIST_MAX);
        saveHistory(historyRef.current);
      }
      histIdxRef.current = -1;
      // 도크는 항상 떠 있음 — 비우고 연속 생성.
      ed.innerHTML = "";
      updatePlaceholder();
      setMention(null);
      setBusy(false);
      requestAnimationFrame(() => ed.focus());
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  // 드롭다운(model/ratio) Esc 닫기 — 도크 자체는 항상 떠 있음.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const onEditorKeyDown = (e: React.KeyboardEvent) => {
    // Shift+Backspace(프롬프트 포커스): 프롬프트 텍스트·인라인 칩만 비운다(트레이 레퍼런스는 유지 —
    // 트레이는 그 영역에 포커스 두고 Shift+Backspace 로 따로 비운다). 한글 조합 중에도 무조건.
    const isBackspace =
      e.key === "Backspace" || e.code === "Backspace" || e.nativeEvent.keyCode === 8;
    if (isBackspace && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      const ed = editorRef.current;
      if (ed) {
        ed.blur(); // 조합 강제 종료 후 clear — IME 잔존 방지
        ed.innerHTML = "";
        composingRef.current = false;
        dragParentRef.current = null; // 입력 비우면 '재사용 원본' 부모 참조도 폐기(엉뚱한 계보 방지)
        updatePlaceholder();
        setMention(null);
        histIdxRef.current = -1;
        requestAnimationFrame(() => ed.focus());
      }
      return;
    }

    // Esc: 멘션 피커 닫기(+토큰 제거) → tagFilter 해제
    if (e.key === "Escape") {
      const ed = editorRef.current;
      if (mention) {
        e.preventDefault();
        if (ed) {
          stripQuery(ed, mention.kind);
          updatePlaceholder();
        }
        setMention(null);
      } else if (tagFilter) {
        e.preventDefault();
        clearTagFilter();
      }
      return;
    }

    const composing = composingRef.current || e.nativeEvent.isComposing;

    // 프롬프트 기록(쉘식 ↑↓) — 피커 닫힘 + (비었거나 이미 기록 탐색 중)일 때만.
    if (!mention && !composing && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const ed = editorRef.current;
      const hist = historyRef.current;
      const navigating = histIdxRef.current >= 0;
      const empty = ed ? !hasContent(ed) : true;
      if (hist.length && (navigating || empty)) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          const idx = navigating ? Math.max(0, histIdxRef.current - 1) : hist.length - 1;
          histIdxRef.current = idx;
          if (ed) {
            restoreParts(ed, hist[idx].parts);
            updatePlaceholder();
          }
          return;
        }
        // ArrowDown — 기록 탐색 중일 때만(빈 라이브 상태에선 무시)
        if (navigating) {
          e.preventDefault();
          const idx = histIdxRef.current + 1;
          if (idx >= hist.length) {
            histIdxRef.current = -1;
            if (ed) {
              ed.innerHTML = "";
              updatePlaceholder();
              placeCaretAtEnd(ed);
            }
          } else {
            histIdxRef.current = idx;
            if (ed) {
              restoreParts(ed, hist[idx].parts);
              updatePlaceholder();
            }
          }
          return;
        }
      }
    }

    // # 태그 피커 네비
    if (mention?.kind === "#" && tagList.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHIdx((i) => Math.min(i + 1, tagList.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !composing) {
        e.preventDefault();
        selectTag(tagList[Math.max(0, hIdx)]);
        return;
      }
    }

    // @ 소스 피커 네비
    if (mention?.kind === "@" && sourceList.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHIdx((i) => Math.min(i + 1, sourceList.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !composing) {
        e.preventDefault();
        selectSource(sourceList[Math.max(0, hIdx)]);
        return;
      }
    }

    // 평상시 Enter → 생성 (Shift+Enter = 줄바꿈)
    if (e.key === "Enter" && !e.shiftKey && !composing && !mention) {
      e.preventDefault();
      if (!busy) submit();
    }
  };

  return (
    <div className={"sl-dockbar" + (agentOn === false ? " sl-offline" : "")}>
      <div className="sl-dock">
        {topSlot}
        <div
          className={"sl-panel" + (expanded ? " expanded" : "")}
          onDragOver={onPanelDragOver}
          onDrop={onPanelDrop}
        >
          {/* @/# 피커 드롭다운 */}
          {mention && (
            <div className="sl-mention">
              <div className="sl-mention-head">
                {mention.kind === "@" ? "소스 (@이름)" : "태그 (#)"}
                <span className="sl-mention-hint">↑↓ 이동 · Enter 선택 · Esc 닫기</span>
              </div>
              <div className="sl-mention-list" ref={listRef}>
                {mention.kind === "#" ? (
                  tagList.length === 0 ? (
                    <div className="sl-mention-empty">
                      {assetCtx.project ? "태그가 없습니다" : "에셋 창을 열어 프로젝트를 선택하세요"}
                    </div>
                  ) : (
                    tagList.map((t, i) => (
                      <button
                        key={t}
                        className={"sl-mention-item sl-tag-item" + (i === hIdx ? " on" : "")}
                        onMouseEnter={() => setHIdx(i)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectTag(t);
                        }}
                      >
                        <span className="sl-tag-hash">#</span>
                        <span className="sl-mention-name">{t}</span>
                        <span className="sl-tag-count">{tagCounts.get(t)}</span>
                      </button>
                    ))
                  )
                ) : sourceList.length === 0 ? (
                  <div className="sl-mention-empty">
                    {assetCtx.project
                      ? tagFilter
                        ? `'#${tagFilter}' 소스가 없습니다`
                        : "소스가 없습니다 (에셋/그리드에서 S 등록)"
                      : "에셋 창을 열어 프로젝트를 선택하세요"}
                  </div>
                ) : (
                  sourceList.map((s, i) => {
                    const a = s.assets[0];
                    const thumb = a?.thumbnail_path || a?.file_path;
                    return (
                      <button
                        key={s.id}
                        className={"sl-mention-item" + (i === hIdx ? " on" : "")}
                        onMouseEnter={() => setHIdx(i)}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          selectSource(s);
                        }}
                      >
                        {thumb ? <img src={thumb} alt="" /> : <span className="sl-mention-ph" />}
                        <span className="sl-mention-name">@{s.source_name || "source"}</span>
                        <span className="sl-mention-tags">
                          {s.tags.map((t) => (
                            <span key={t} className="sl-mention-tag">
                              #{t}
                            </span>
                          ))}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* 확장(+) 레퍼런스 트레이 — 에셋 폴더 드래그 전용. 번호 = 생성 --image 순서 */}
          {expanded && (
            <div
              className="sl-reftray"
              tabIndex={0}
              onDragOver={onTrayDragOver}
              onDrop={onTrayDrop}
              onKeyDown={onTrayKeyDown}
              onMouseDown={(e) => {
                // 레퍼런스 영역을 누르면 트레이에 포커스를 줘 Shift+Backspace 로 전체 삭제 가능.
                // ×버튼 등 버튼 클릭은 제외(그 동작 보존).
                if (!(e.target as HTMLElement).closest("button"))
                  (e.currentTarget as HTMLElement).focus();
              }}
            >
              {trayRefs.length === 0 ? (
                <div className="sl-reftray-empty">
                  에셋 창에서 파일을 여기로 드래그하세요 — 번호 순서대로 레퍼런스가 됩니다
                </div>
              ) : (
                trayRefs.map((r, i) => (
                  <div
                    key={r.uid}
                    className="sl-reftray-item"
                    draggable
                    onDragStart={onTrayItemDragStart(i)}
                    onDragOver={onTrayDragOver}
                    onDrop={onTrayItemDrop(i)}
                    title={`${i + 1}. ${r.name}`}
                  >
                    <span className="sl-reftray-num">{i + 1}</span>
                    {r.type === "video" ? (
                      // 영상은 포스터 thumb 가 없을 수 있어(에셋 영상은 thumb 엔드포인트 미지원)
                      // 레퍼런스 실제 파일을 <video> 로 띄워 첫 프레임을 보여준다(깨짐 방지).
                      <video
                        src={refSrc(r.file_path)}
                        muted
                        preload="metadata"
                        playsInline
                      />
                    ) : r.thumb ? (
                      <img src={r.thumb} alt="" />
                    ) : (
                      <span className="sl-reftray-ph" />
                    )}
                    <span className="sl-reftray-name">{r.name}</span>
                    <button
                      className="sl-reftray-x"
                      title="제거"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => removeTrayRef(i)}
                    >
                      ×
                    </button>
                  </div>
                ))
              )}
            </div>
          )}

          {/* 프롬프트 행 */}
          <div className={"sl-prompt-row" + (tagFilter ? " tag-active" : "")}>
            <button
              className={"sl-expand-btn" + (expanded ? " on" : "")}
              title={expanded ? "레퍼런스 트레이 접기" : "레퍼런스 트레이 펼치기 (에셋 드래그)"}
              onClick={onToggleExpand}
            >
              {expanded ? "−" : "+"}
            </button>
            {tagFilter && (
              <span className="sl-tag-badge" title="태그 필터 (Esc 또는 × 로 해제)">
                #{tagFilter}
                <button onMouseDown={(e) => { e.preventDefault(); clearTagFilter(); }}>×</button>
              </span>
            )}
            <div
              ref={editorRef}
              className="sl-prompt"
              contentEditable
              suppressContentEditableWarning
              data-placeholder={
                expanded
                  ? "Describe the scene you imagine"
                  : "Describe the scene you imagine --- @Source, #Tag"
              }
              onInput={onEditorInput}
              onKeyUp={onCaretMove}
              onClick={onCaretMove}
              onKeyDown={onEditorKeyDown}
              onPaste={onEditorPaste}
              onCompositionStart={() => (composingRef.current = true)}
              onCompositionEnd={() => {
                composingRef.current = false;
                onEditorInput();
              }}
              // 레퍼런스 칩(x-ch-chip)을 글자 사이로 끌어 재배치 — 카드/에셋 드롭과 타입으로 격리.
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes("application/x-ch-chip")) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
                showChipDropBar(e.clientX, e.clientY);
              }}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes("application/x-ch-chip")) return;
                e.preventDefault();
                e.stopPropagation();
                hideChipDropBar();
                const ed = editorRef.current;
                if (ed && moveChipToPoint(ed, e.clientX, e.clientY)) onEditorInput();
              }}
              onDragLeave={(e) => {
                // 에디터 밖으로 진짜 나갈 때만 표시막대 숨김(자식으로 이동 시 깜박임 방지)
                if (!editorRef.current?.contains(e.relatedTarget as Node)) hideChipDropBar();
              }}
            />
            {/* 우측 상단 — 프롬프트 전체 복사. 아이콘은 순수 CSS(::before/::after 겹친 사각형)로
                그려 SVG/폰트 렌더 이슈를 피한다. */}
            <button
              type="button"
              className="sl-copy-btn"
              title="프롬프트 전체 복사"
              aria-label="프롬프트 전체 복사"
              onMouseDown={(e) => e.preventDefault()}
              onClick={copyPrompt}
            />
          </div>

          {/* 컨트롤 행 */}
          <div className="sl-controls">
            <div className="sl-left">
              <div className="sl-type">
                <button
                  className={"sl-type-btn" + (type === "image" ? " active" : "")}
                  onClick={() => setType("image")}
                >
                  Image
                </button>
                <button
                  className={"sl-type-btn" + (type === "video" ? " active" : "")}
                  onClick={() => setType("video")}
                >
                  Video
                </button>
              </div>

              <div className="sl-chip-wrap">
                <button
                  className={"sl-chip" + (open === "model" ? " active" : "")}
                  onClick={() => setOpen(open === "model" ? null : "model")}
                >
                  <span className="sl-dot" />
                  <span className="sl-chip-label">{modelName}</span>
                  <span className="sl-caret">›</span>
                </button>
                {open === "model" && (
                  <div className="sl-dropdown">
                    <div className="sl-dd-title">{type === "video" ? "영상" : "이미지"} 모델</div>
                    <div className="sl-dd-scroll">
                      {typeModels.map((m) => (
                        <button
                          key={m.job_set_type}
                          className={"sl-dd-item" + (m.job_set_type === model ? " sel" : "")}
                          onClick={() => {
                            setModel(m.job_set_type);
                            setOpen(null);
                          }}
                        >
                          {m.display_name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* 주요 옵션(자주 바꿈)만 인라인 — duration=슬라이더, enum=드롭다운, 정수=숫자 입력.
                  그 외(mode·bitrate·genre 등)는 아래 '⚙ 고급' 팝오버로. */}
              {tunable.filter((p) => PRIMARY_PARAMS.has(p.name)).map((p) => {
                // 듀레이션 → 슬라이더(enum 이면 그 값들에 스냅, 정수면 1..최댓값 범위)
                if (/duration|length/i.test(p.name)) {
                  if (p.enum?.length) {
                    const vals = p.enum;
                    const cur = String(optionValues[p.name] ?? p.default ?? vals[0]);
                    const idx = Math.max(0, vals.indexOf(cur));
                    return (
                      <div className="sl-chip sl-opt-slider" key={p.name} title={p.name}>
                        <span className="sl-opt-ic"><OptIcon name={p.name} /></span>
                        <input
                          type="range"
                          min={0}
                          max={vals.length - 1}
                          step={1}
                          value={idx}
                          onChange={(e) => setOpt(p.name, vals[Number(e.target.value)])}
                        />
                        <span className="sl-opt-val">{cur}s</span>
                      </div>
                    );
                  }
                  const def = Number(p.default) || 5;
                  const { min: dmin, max: dmax } = durRange(model, def);
                  const raw = Number(optionValues[p.name] ?? def) || def;
                  const cur = Math.min(dmax, Math.max(dmin, raw)); // 범위 밖 값 클램프
                  return (
                    <div className="sl-chip sl-opt-slider" key={p.name} title={`${p.name} (${dmin}~${dmax}s)`}>
                      <span className="sl-opt-ic"><OptIcon name={p.name} /></span>
                      <input
                        type="range"
                        min={dmin}
                        max={dmax}
                        step={1}
                        value={cur}
                        onChange={(e) =>
                          setOptionValues((prev) => ({ ...prev, [p.name]: Number(e.target.value) }))
                        }
                      />
                      <span className="sl-opt-val">{cur}s</span>
                    </div>
                  );
                }
                return p.enum?.length ? (
                  <div className="sl-chip-wrap" key={p.name}>
                    <button
                      className={"sl-chip sl-opt-chip" + (open === p.name ? " active" : "")}
                      onClick={() => setOpen(open === p.name ? null : p.name)}
                      title={p.name}
                    >
                      <span className="sl-opt-ic"><OptIcon name={p.name} /></span>
                      <span>{String(optionValues[p.name] ?? p.default ?? "")}</span>
                      <span className="sl-caret">›</span>
                    </button>
                    {open === p.name && (
                      <div className="sl-dropdown">
                        <div className="sl-dd-scroll">
                          {p.enum.map((v) => {
                            const con = constraints[p.name];
                            const blocked = !!con && !con.allow.has(v);
                            return (
                              <button
                                key={v}
                                className={
                                  "sl-dd-item" +
                                  (optionValues[p.name] === v ? " sel" : "") +
                                  (blocked ? " blocked" : "")
                                }
                                disabled={blocked}
                                onClick={() => !blocked && setOpt(p.name, v)}
                                title={blocked ? con!.note : undefined}
                              >
                                {v}
                                {blocked && <span className="sl-dd-lock"> 🔒</span>}
                              </button>
                            );
                          })}
                        </div>
                        {constraints[p.name] && (
                          <div className="sl-dd-note">{constraints[p.name].note}</div>
                        )}
                      </div>
                    )}
                  </div>
                ) : p.type === "integer" ? (
                  <label className="sl-chip sl-opt-num" key={p.name} title={p.name}>
                    <span className="sl-opt-ic"><OptIcon name={p.name} /></span>
                    <input
                      type="number"
                      value={String(optionValues[p.name] ?? p.default ?? "")}
                      onChange={(e) =>
                        setOptionValues((prev) => ({
                          ...prev,
                          [p.name]: e.target.value === "" ? "" : Number(e.target.value),
                        }))
                      }
                    />
                  </label>
                ) : null;
              })}

              {/* ⚙ 고급 — 비주요 파라미터(mode·bitrate·genre 등)를 풀 라벨로 모아 한 줄을 비운다.
                  값이 기본과 다르면(=커스터마이즈됨) 칩을 강조해 '뭔가 바꿨음'을 알린다. */}
              {(() => {
                const adv = tunable
                  .filter((p) => !PRIMARY_PARAMS.has(p.name))
                  .sort((a, b) => advRank(a.name) - advRank(b.name)); // 모드→장르→비트레이트
                if (!adv.length) return null;
                const dirty = adv.some((p) => {
                  const cur = optionValues[p.name];
                  return (
                    cur != null &&
                    cur !== "" &&
                    String(cur) !== String(effectiveDefault(p) ?? "")
                  );
                });
                return (
                  <div className="sl-chip-wrap">
                    <button
                      className={
                        "sl-chip sl-opt-chip" +
                        (open === "advanced" ? " active" : "") +
                        (dirty ? " dirty" : "")
                      }
                      onClick={() => setOpen(open === "advanced" ? null : "advanced")}
                      title="고급 옵션 (모드·비트레이트·장르 등)"
                    >
                      <span className="sl-opt-ic">
                        <svg
                          width={13}
                          height={13}
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="12" cy="12" r="3" />
                          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                        </svg>
                      </span>
                      <span>고급</span>
                      {dirty && <span className="sl-adv-dot" aria-hidden />}
                      <span className="sl-caret">›</span>
                    </button>
                    {open === "advanced" && (
                      <div className="sl-dropdown sl-adv-pop">
                        <div className="sl-dd-title">고급 옵션</div>
                        {adv.map((p) => {
                          const cur =
                            optionValues[p.name] ?? p.default ?? (p.enum ? p.enum[0] : "");
                          return (
                            <div className="sl-adv-row" key={p.name}>
                              <div className="sl-adv-label">
                                <span className="sl-opt-ic"><OptIcon name={p.name} /></span>
                                {paramLabel(p.name)}
                              </div>
                              {p.enum?.length ? (
                                <div className="sl-adv-opts">
                                  {p.enum.map((v) => {
                                    const con = constraints[p.name];
                                    const blocked = !!con && !con.allow.has(v);
                                    return (
                                      <button
                                        key={v}
                                        className={
                                          "sl-adv-opt" +
                                          (String(cur) === v ? " sel" : "") +
                                          (blocked ? " blocked" : "")
                                        }
                                        disabled={blocked}
                                        onClick={() => !blocked && setOpt(p.name, v)}
                                        title={blocked ? con!.note : valueLabel(v)}
                                      >
                                        {valueLabel(v)}
                                      </button>
                                    );
                                  })}
                                </div>
                              ) : p.type === "boolean" || typeof p.default === "boolean" ? (
                                // 불리언(예: generate_audio) — true/false 직접 입력 대신 ON/OFF 토글.
                                // 값은 불리언으로 저장(백엔드 직렬화·DB 형식과 동일).
                                (() => {
                                  const on =
                                    cur === true || String(cur).toLowerCase() === "true";
                                  return (
                                    <div className="sl-adv-opts">
                                      <button
                                        className={"sl-adv-opt" + (on ? " sel" : "")}
                                        onClick={() =>
                                          setOptionValues((prev) => ({ ...prev, [p.name]: true }))
                                        }
                                        title="켜기"
                                      >
                                        ON
                                      </button>
                                      <button
                                        className={"sl-adv-opt" + (!on ? " sel" : "")}
                                        onClick={() =>
                                          setOptionValues((prev) => ({ ...prev, [p.name]: false }))
                                        }
                                        title="끄기"
                                      >
                                        OFF
                                      </button>
                                    </div>
                                  );
                                })()
                              ) : p.type === "integer" ? (
                                (() => {
                                  const rg = numericRange(model, p.name);
                                  return (
                                    <input
                                      className="sl-adv-num"
                                      type="number"
                                      min={rg?.min}
                                      max={rg?.max}
                                      title={rg ? `허용 범위 ${rg.min}~${rg.max}` : undefined}
                                      value={String(optionValues[p.name] ?? p.default ?? "")}
                                      onChange={(e) => {
                                        const raw = e.target.value;
                                        setOptionValues((prev) => ({
                                          ...prev,
                                          [p.name]:
                                            raw === ""
                                              ? ""
                                              : rg
                                                ? Math.min(rg.max, Math.max(rg.min, Number(raw)))
                                                : Number(raw),
                                        }));
                                      }}
                                    />
                                  );
                                })()
                              ) : (
                                <input
                                  className="sl-adv-num"
                                  type="text"
                                  value={String(optionValues[p.name] ?? p.default ?? "")}
                                  onChange={(e) =>
                                    setOptionValues((prev) => ({
                                      ...prev,
                                      [p.name]: e.target.value,
                                    }))
                                  }
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* 배치(장수): 한 번에 N장 — 모든 모델 공통. 각 장은 별도 잡=별도 카드. */}
              <div className="sl-count" title={`한 번에 생성할 장수 (최대 ${MAX_COUNT}, 각 장이 별도 카드)`}>
                <button
                  className="sl-count-btn"
                  onClick={() => setCount((c) => Math.max(1, c - 1))}
                  disabled={count <= 1}
                >
                  −
                </button>
                <span className="sl-count-val">
                  {count}/{MAX_COUNT}
                </span>
                <button
                  className="sl-count-btn"
                  onClick={() => setCount((c) => Math.min(MAX_COUNT, c + 1))}
                  disabled={count >= MAX_COUNT}
                >
                  +
                </button>
              </div>
            </div>

            <button className="sl-gen" disabled={busy} onClick={submit}>
              {busy ? "생성 중…" : count > 1 ? `Generate ${count}` : "Generate"}{" "}
              <span className="sl-sparkle">✦</span>
              {costLoading ? (
                <span className="sl-cost loading">…</span>
              ) : (
                cost != null &&
                cost > 0 && (
                  <span
                    className="sl-cost"
                    title={`예상 크레딧 ${cost}${count > 1 ? ` × ${count}장 = ${cost * count}` : ""} (해상도·길이·모드에 따라 변동)`}
                  >
                    {count > 1 ? `${cost}×${count}=${cost * count}` : cost * count}
                  </span>
                )
              )}
            </button>
          </div>
        </div>

        {error && <div className="sl-error">{error}</div>}

        <button
          type="button"
          className="sl-status"
          title="생성·재생성은 내 PC의 에이전트가 켜져 있어야 실행됩니다(MV_agent.bat). 클릭=크레딧 확인"
          onClick={checkAccount}
        >
          <span className={"sl-status-dot" + (agentOn ? " on" : "")} />
          <span>
            {agentOn == null
              ? "에이전트 확인 중…"
              : agentOn
                ? "연결됨"
                : "에이전트 꺼짐 — 생성하려면 실행"}
          </span>
          {account?.credits != null && (
            <>
              <span className="sl-status-sep">·</span>
              <span className="sl-status-credits">
                {account.credits.toLocaleString(undefined, { maximumFractionDigits: 2 })} credits
              </span>
            </>
          )}
          {account?.email && (
            <>
              <span className="sl-status-sep">·</span>
              <span className="sl-status-user" title={account.email}>
                {account.email}
              </span>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
