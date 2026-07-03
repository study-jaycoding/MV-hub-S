// 스포트라이트 프롬프트(항상 하단 도킹) — PV 스타일.
//  · contentEditable 프롬프트 + 선택 소스를 인라인 이미지 칩으로 삽입
//  · @ → 소스 피커, # → 태그 목록 피커. 태그 선택 시 tagFilter 고정 + @ 피커가 그 태그로 필터되어 열림
//  · Esc → 피커 닫기 / tagFilter 해제. 제출 시 본문 텍스트 + 칩→references 직렬화.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api";
import { APP_EVENTS } from "../lib/appEvents";
import { openAssetBroadcast } from "../lib/assetBroadcast";
import { DRAG_TYPES } from "../lib/dragTypes";
import { buildPromptParts, refsToChips } from "../lib/promptParts";
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
import { dataTransferHasFiles } from "../lib/media";
import { seedanceTokenRoles } from "../lib/seedancePrompt";
import { buildSpotlightCreateBody } from "../lib/spotlightSubmit";
import { useAccountStatus } from "../lib/useAccountStatus";
import { useCustomEvent } from "../lib/useCustomEvent";
import { useSpotlightAgentStatus } from "../lib/useSpotlightAgentStatus";
import {
  useSpotlightMentionSources,
  type SpotlightMention,
} from "../lib/useSpotlightMentionSources";
import { useModels, ALLOWED, HIDDEN_PARAMS } from "../lib/useModels";
import {
  notifySpotlightAssetsChanged,
  parseSpotlightAssetItems,
  readSpotlightAssetPayload,
  readSpotlightAssetCtx,
  referenceDropTypeFromFile,
  spotlightAssetRefBase,
  type SpotlightAssetDragItem,
} from "../lib/spotlightAssetRefs";
import { SpotlightOptionsBar } from "./spotlight/SpotlightOptionsBar";
import { SpotlightGenerateControls } from "./spotlight/SpotlightGenerateControls";
import { SpotlightMentionPicker } from "./spotlight/SpotlightMentionPicker";
import { SpotlightPromptRow } from "./spotlight/SpotlightPromptRow";
import { SpotlightRefTray, type SpotlightTrayRef } from "./spotlight/SpotlightRefTray";
import type { Generation } from "../types";

const MAX_COUNT = 4; // 한 번에 생성할 최대 장수(배치)

interface Props {
  // created: 방금 만든 pending 생성본들 — 즉시 '대기' 카드로 띄우게(optimistic). 없으면 그냥 리로드.
  // dragParentId: 카드를 드래그해 불러와 만든 경우 그 원본 gen id → 자동 히스토리(원본→파생) 부모.
  onCreated: (created?: Generation[], dragParentId?: string | null) => void;
  armedAutoTags: string[]; // 무장된 자동 태그 — 생성 시 결과물에 자동 적용(별도 네임스페이스)
  // 무장된 폴더 — 그 프로젝트로 생성 시 folder_path 로 자동 라벨링(전역변수식). 프로젝트 불일치면 미적용.
  armedFolder?: { projectId: string; path: string } | null;
  topSlot?: ReactNode; // 도크 상단(프롬프트 바로 위)에 끼우는 슬롯 — 멀티 선택 바
  activeProjectId?: string; // 현재 보고 있는 프로젝트 — 생성 시 자동 귀속(로드맵 §0-4)
  expanded: boolean; // '+' 확장 — 레퍼런스 트레이(위)+프롬프트(아래) 2단. App 이 보유.
  onToggleExpand: () => void; // '+' 버튼 토글
}

// 노출 모델 화이트리스트(ALLOWED)·숨김 파라미터(HIDDEN_PARAMS)·모델/파라미터/비용 로직은
// useModels 훅으로 추출. onPanelDrop 에서 쓰는 상수만 훅 모듈에서 import 해 재사용.


export function SpotlightPrompt({
  onCreated,
  armedAutoTags,
  armedFolder,
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
  const agentOn = useSpotlightAgentStatus();
  // @/# 피커
  const [mention, setMention] = useState<SpotlightMention>(null);
  const [hIdx, setHIdx] = useState(0);
  const [assetCtx, setAssetCtx] = useState(readSpotlightAssetCtx);
  const { allSources, sourceList, tagCounts, tagFilter, tagList, setTagFilter } =
    useSpotlightMentionSources(mention, assetCtx.project);
  // ── 확장(+) 레퍼런스 트레이 — 에셋 폴더 드래그 전용. 순서 = 생성 --image 순서 ──
  // uid: 같은 파일을 중복으로 넣을 수 있어 file_path 가 겹치므로 React key·재정렬용 고유키.
  const [trayRefs, setTrayRefs] = useState<SpotlightTrayRef[]>([]);
  const [promptTick, setPromptTick] = useState(0); // contentEditable 텍스트 변경 신호(트레이 역할 배지 갱신)
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
  useCustomEvent(APP_EVENTS.focusPrompt, () => editorRef.current?.focus());

  // (프롬프트 재사용은 카드를 입력바로 드래그-드롭하면 동작 — onPanelDrop→reusePromptFromGen 직접
  //  호출. 이벤트(ch:reuse-prompt) 경로는 디스패처가 없어 제거함.)

  // 카드의 '레퍼런스로 사용'(@) 버튼 → 그 생성물을 레퍼런스로 추가(확장이면 트레이, 아니면 인라인 칩).
  // useCustomEvent 가 항상 최신 addRefFromGen(최신 expanded)을 호출 → stale 분기 버그 없음.
  useCustomEvent(APP_EVENTS.addReference, (e) => {
    const id = (e as CustomEvent<string>).detail;
    if (id) void addRefFromGen(id);
  });

  // 에셋 파트(분리창) 프로젝트 변경 알림 → 컨텍스트 갱신.
  // 값이 실제로 바뀐 경우에만 갱신(스크롤 저장 등 다른 ch.assets.* 쓰기로 인한 재요청 폭주 방지).
  useEffect(() => {
    const update = () =>
      setAssetCtx((prev) => {
        const next = readSpotlightAssetCtx();
        return next.project === prev.project && next.dir === prev.dir ? prev : next;
      });
    const bc = openAssetBroadcast();
    bc?.addEventListener("message", update);
    window.addEventListener("storage", update);
    return () => {
      bc?.removeEventListener("message", update);
      bc?.close();
      window.removeEventListener("storage", update);
    };
  }, []);

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
    setPromptTick((n) => n + 1);
  };

  const liveSeedanceRoles = useMemo(() => {
    // 트레이 배지 전용 — 트레이가 비어 있으면(레퍼런스 미사용) 소비처가 없으니
    // 키 입력마다 에디터 DOM 직렬화+정규식 스캔을 하지 않는다.
    if (!trayRefs.length) return new Map() as ReturnType<typeof seedanceTokenRoles>;
    const ed = editorRef.current;
    return seedanceTokenRoles(ed ? serialize(ed).text : "");
  }, [promptTick, trayRefs]);

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
    if (!ed || composingRef.current) return;
    const next = detectMention(ed);
    // 내용이 같으면 이전 참조를 유지한다. 방향키 keyup 도 이 핸들러를 타는데(onKeyUp),
    // 매번 새 객체로 setMention 하면 소스 목록이 재로드되며 하이라이트(hIdx)가 0 으로 리셋돼
    // 피커에서 ↑↓ 이동이 안 먹힌다.
    setMention((prev) => {
      if (prev && next && prev.kind === next.kind && prev.query === next.query) return prev;
      return prev === next ? prev : next;
    });
  };

  const selectTag = (tag: string) => {
    const ed = editorRef.current;
    if (ed) {
      stripQuery(ed, "#");
      insertTextAtCaret(ed, "@"); // 그 태그로 필터된 @ 소스 피커 자동 오픈
      updatePlaceholder();
      setPromptTick((n) => n + 1);
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
    setPromptTick((n) => n + 1);
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
          setPromptTick((n) => n + 1);
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
          setPromptTick((n) => n + 1);
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
    // 카드(x-ch-gen)=재사용 · 에셋/외부 파일=레퍼런스 추가. 둘 다 프롬프트로 끌어내려 받는다.
    if (tps.includes(DRAG_TYPES.generation) || tps.includes(DRAG_TYPES.asset) || dataTransferHasFiles(e.dataTransfer)) {
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
        setPromptTick((n) => n + 1);
        ed.focus();
      }
    } catch (err) {
      setError(String(err));
    }
  };

  const importExternalFilesAsRefs = async (files: File[]) => {
    const accepted = files.filter((f) => referenceDropTypeFromFile(f));
    const ignored = files.length - accepted.length;
    if (!accepted.length) {
      setError("이미지/영상 파일만 레퍼런스로 추가할 수 있습니다.");
      return;
    }
    setError(null);
    try {
      const ctx = readSpotlightAssetCtx();
      const res = await api.uploadReferenceFiles(accepted, ctx.project, ctx.dir);
      const items: SpotlightAssetDragItem[] = res.saved || [];
      const skipped = res.skipped || [];
      if (items.length) {
        addAssetRefs(JSON.stringify(items));
        const reused = (res.saved || []).filter((item) => item.reused).length;
        const imported = items.length - reused;
        const label = reused && imported
          ? `${imported}개 가져오고 ${reused}개 재사용했습니다`
          : reused
            ? `${reused}개 기존 파일을 재사용했습니다`
            : `${items.length}개 외부 파일을 레퍼런스로 추가했습니다`;
        flashMsg(label);
        notifySpotlightAssetsChanged(items);
      }
      const skippedCount = ignored + skipped.length;
      if (!items.length && skippedCount > 0) {
        setError("이미지/영상 파일만 레퍼런스로 추가할 수 있습니다.");
      }
    } catch (err) {
      setError("외부 파일 가져오기 실패: " + String(err));
    }
  };

  const onPanelDrop = (e: React.DragEvent) => {
    const gen = e.dataTransfer.getData(DRAG_TYPES.generation);
    if (gen) {
      e.preventDefault();
      void reusePromptFromGen(gen); // 카드 끌어내림 = 프롬프트 재사용(불러오기)
      return;
    }
    if (e.dataTransfer.types.includes(DRAG_TYPES.asset)) {
      e.preventDefault();
      addAssetRefs(readSpotlightAssetPayload(e.dataTransfer)); // 에셋 끌어내림 = 레퍼런스(확장=트레이, 접힘=인라인 칩) · 다중 일괄
      return;
    }
    if (dataTransferHasFiles(e.dataTransfer)) {
      e.preventDefault();
      void importExternalFilesAsRefs(Array.from(e.dataTransfer.files));
    }
  };

  // ── 레퍼런스 트레이(확장 모드) — 에셋 폴더 드래그로 추가 + 드래그로 재정렬 ──
  // 에셋 셀 dragstart 가 심은 application/x-ch-asset 만 받는다(카드·@ 아님). 값은 항상 배열 —
  // 다중선택을 그리드 순서대로 한 번에 받는다(옛 단건 객체도 하위호환으로 수용).
  const addAssetToTray = (raw: string) => {
    // 중복 허용(같은 파일도 여러 번) — dedup 안 함. uid 로 구분. 다중선택은 배열로 한 번에 추가.
    const additions: SpotlightTrayRef[] = parseSpotlightAssetItems(raw).map((d) => ({
      ...spotlightAssetRefBase(d),
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
    for (const d of parseSpotlightAssetItems(raw)) {
      insertChip(ed, {
        ...spotlightAssetRefBase(d),
        role: d.type === "video" ? "@Video" : `@Image${countImageChips(ed) + 1}`, // 칩마다 다음 슬롯
      });
      added = true;
    }
    if (added) {
      updatePlaceholder();
      setPromptTick((n) => n + 1);
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
    if (tps.includes(DRAG_TYPES.asset) || tps.includes(DRAG_TYPES.trayIndex) || dataTransferHasFiles(e.dataTransfer)) {
      e.preventDefault();
      e.stopPropagation(); // 패널의 카드-드롭 핸들러로 번지지 않게(트레이는 에셋 전용)
      e.dataTransfer.dropEffect = trayDragIdx.current !== null ? "move" : "copy";
    }
  };
  const onTrayDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes(DRAG_TYPES.asset)) {
      addAssetToTray(readSpotlightAssetPayload(e.dataTransfer)); // 빈 영역 = 끝에 추가(재정렬은 항목에서)
      return;
    }
    if (dataTransferHasFiles(e.dataTransfer)) {
      void importExternalFilesAsRefs(Array.from(e.dataTransfer.files));
    }
  };
  const onTrayItemDragStart = (i: number) => (e: React.DragEvent) => {
    trayDragIdx.current = i;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DRAG_TYPES.trayIndex, String(i));
  };
  const onTrayItemDrop = (i: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes(DRAG_TYPES.asset)) {
      addAssetToTray(readSpotlightAssetPayload(e.dataTransfer)); // 항목 위에 에셋 떨어뜨려도 추가
      trayDragIdx.current = null;
      return;
    }
    if (dataTransferHasFiles(e.dataTransfer)) {
      void importExternalFilesAsRefs(Array.from(e.dataTransfer.files));
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
    if (!text && trayRefs.length + inlineRefs.length === 0) {
      setError("프롬프트를 입력하세요.");
      ed.focus();
      return;
    }
    if (!model) {
      setError("모델을 선택하세요.");
      return;
    }
    // 표시용 프롬프트(칩 자리에 @소스명) — CLI 본문(text)과 분리해 저장.
    const parts = serializeParts(ed);
    const displayPrompt = partsText(parts);
    const { body, error: bodyError } = buildSpotlightCreateBody({
      text,
      inlineRefs,
      trayRefs,
      parts,
      displayPrompt,
      model,
      optionValues,
      armedAutoTags,
      activeProjectId,
      // 무장 폴더가 현재 프로젝트와 일치할 때만 folder_path 로 라벨링(전역변수 가드).
      folderPath:
        armedFolder && armedFolder.projectId === activeProjectId ? armedFolder.path : undefined,
    });
    if (bodyError || !body) {
      setError(bodyError || "생성 요청을 만들 수 없습니다.");
      return;
    }
    setBusy(true);
    try {
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
            setPromptTick((n) => n + 1);
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
              setPromptTick((n) => n + 1);
            }
          } else {
            histIdxRef.current = idx;
            if (ed) {
              restoreParts(ed, hist[idx].parts);
              updatePlaceholder();
              setPromptTick((n) => n + 1);
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

  const onPromptCompositionStart = () => {
    composingRef.current = true;
  };
  const onPromptCompositionEnd = () => {
    composingRef.current = false;
    onEditorInput();
  };
  const onPromptChipDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPES.chip)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    showChipDropBar(e.clientX, e.clientY);
  };
  const onPromptChipDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPES.chip)) return;
    e.preventDefault();
    e.stopPropagation();
    hideChipDropBar();
    const ed = editorRef.current;
    if (ed && moveChipToPoint(ed, e.clientX, e.clientY)) onEditorInput();
  };
  const onPromptChipDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    if (!editorRef.current?.contains(e.relatedTarget as Node)) hideChipDropBar();
  };
  const onClearTagMouseDown = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    clearTagFilter();
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
            <SpotlightMentionPicker
              mention={mention}
              tagList={tagList}
              tagCounts={tagCounts}
              sourceList={sourceList}
              activeIndex={hIdx}
              listRef={listRef}
              assetProject={assetCtx.project}
              tagFilter={tagFilter}
              onHoverIndex={setHIdx}
              onSelectTag={selectTag}
              onSelectSource={selectSource}
            />
          )}

          {/* 확장(+) 레퍼런스 트레이 — 에셋 폴더 드래그 전용. 번호 = 생성 --image 순서 */}
          {expanded && (
            <SpotlightRefTray
              trayRefs={trayRefs}
              model={model}
              liveSeedanceRoles={liveSeedanceRoles}
              onDragOver={onTrayDragOver}
              onDrop={onTrayDrop}
              onKeyDown={onTrayKeyDown}
              onItemDragStart={onTrayItemDragStart}
              onItemDrop={onTrayItemDrop}
              onRemove={removeTrayRef}
              onClearAll={() => setTrayRefs([])}
            />
          )}

          {/* 프롬프트 행 */}
          <SpotlightPromptRow
            expanded={expanded}
            tagFilter={tagFilter}
            editorRef={editorRef}
            onToggleExpand={onToggleExpand}
            onClearTagFilter={onClearTagMouseDown}
            onInput={onEditorInput}
            onCaretMove={onCaretMove}
            onKeyDown={onEditorKeyDown}
            onPaste={onEditorPaste}
            onCompositionStart={onPromptCompositionStart}
            onCompositionEnd={onPromptCompositionEnd}
            onDragOver={onPromptChipDragOver}
            onDrop={onPromptChipDrop}
            onDragLeave={onPromptChipDragLeave}
            onCopyPrompt={copyPrompt}
          />

          {/* 컨트롤 행 */}
          <SpotlightGenerateControls
            count={count}
            maxCount={MAX_COUNT}
            setCount={setCount}
            busy={busy}
            cost={cost}
            costLoading={costLoading}
            onSubmit={submit}
          >
              <SpotlightOptionsBar
                type={type}
                setType={setType}
                model={model}
                setModel={setModel}
                modelName={modelName}
                typeModels={typeModels}
                tunable={tunable}
                constraints={constraints}
                optionValues={optionValues}
                setOptionValues={setOptionValues}
                setOpt={setOpt}
                open={open}
                setOpen={setOpen}
              />
          </SpotlightGenerateControls>
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
