// 스포트라이트 프롬프트(항상 하단 도킹) — PV 스타일.
//  · contentEditable 프롬프트 + 선택 소스를 인라인 이미지 칩으로 삽입
//  · @ → 소스 피커, # → 태그 목록 피커. 태그 선택 시 tagFilter 고정 + @ 피커가 그 태그로 필터되어 열림
//  · Esc → 피커 닫기 / tagFilter 해제. 제출 시 본문 텍스트 + 칩→references 직렬화.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../api";
import { APP_EVENTS } from "../lib/appEvents";
import { openAssetBroadcast } from "../lib/assetBroadcast";
import { DRAG_TYPES } from "../lib/dragTypes";
import { buildPromptParts, refSrc, refsToChips } from "../lib/promptParts";
import {
  unwrapTokenPill,
  countImageChips,
  detectMention,
  hasContent,
  hideChipDropBar,
  insertChip,
  insertRefToken,
  insertTextAtCaret,
  loadHistory,
  moveChipToPoint,
  partsDisplay,
  partsText,
  placeCaretAtEnd,
  restoreParts,
  saveHistory,
  serialize,
  serializeParts,
  showChipDropBar,
  stripQuery,
  wrapRefTokens,
  HIST_MAX,
} from "../lib/promptEditor";
import type { ChipRef, HistEntry } from "../lib/promptEditor";
import { flashMsg } from "../lib/flash";
import { dataTransferHasFiles } from "../lib/media";
import {
  emptySeedanceTokenRoles,
  seedanceTokenRoles,
  seedanceTrayToken,
  usesMediaRefTokens,
} from "../lib/seedancePrompt";
import { buildSpotlightCreateBody } from "../lib/spotlightSubmit";
import { resolveAutoAspectRatio } from "../lib/aspectAuto";
import { useAccountStatus } from "../lib/useAccountStatus";
import { useCustomEvent } from "../lib/useCustomEvent";
import { useSpotlightAgentStatus } from "../lib/useSpotlightAgentStatus";
import {
  useSpotlightMentionSources,
  type SpotlightMention,
} from "../lib/useSpotlightMentionSources";
import { useSpotlightTray } from "../lib/useSpotlightTray";
import { useSpotlightTokenWrap } from "../lib/useSpotlightTokenWrap";
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
import { SpotlightRefTray } from "./spotlight/SpotlightRefTray";
import type { SceneRef } from "../lib/scenes";
import type { Generation, PreviewTarget } from "../types";

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
  // ── Canvas 씬 연동 ── 씬의 생성 카드 1개를 선택하면 그 카드의 레퍼런스를 이 트레이에 바인딩.
  //  key = `${sceneId}:${cardId}` (카드 바뀜 감지) · refs = 카드에 연결된 레퍼런스(순서).
  //  트레이에서 순서변경/추가/삭제하면 onTrayBindingRefsChange 로 씬 카드에 되돌린다. null=일반 모드.
  trayBinding?: { key: string; refs: SceneRef[] } | null;
  onTrayBindingRefsChange?: (refs: SceneRef[]) => void;
  onPreview?: (target: PreviewTarget) => void; // 트레이 소스 더블클릭 → 크게 보기
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
  trayBinding,
  onTrayBindingRefsChange,
  onPreview,
}: Props) {
  // 모델/파라미터/비용 로직은 useModels 훅으로 추출(동작 100% 보존). 로드 실패는 setError 로 보고.
  const { type, setType, model, setModel, tunable, constraints, typeModels, modelName,
          optionValues, setOptionValues, setOpt, cost, costLoading, paramsModel, paramsLoading,
          pendingOptsRef, setOpenRef } =
    useModels((msg) => setError(msg));
  const [count, setCount] = useState(1); // 한 번에 N장 생성(배치)
  const [open, setOpen] = useState<string | null>(null); // 열린 드롭다운 키(파라미터명 또는 'model')
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // setOpt 가 옵션 선택 후 드롭다운을 닫도록 훅에 setOpen 등록(open/setOpen 은 UI 상태로 컴포넌트에 잔류).
  setOpenRef.current = setOpen;
  // 옵션 팝오버(모델·비율·고급 등)가 열린 동안 바깥을 클릭하면 닫는다. 지금까진 값 선택/Escape 로만 닫혀
  // '바깥 클릭해도 계속 떠 있던' 문제를 보완. 클릭이 어떤 .sl-chip-wrap(칩+팝오버 묶음) 안이면 유지, 밖이면 닫기.
  // capture 단계라 내부에서 stopPropagation 해도 판정이 먼저 돈다(칩 재클릭 토글은 이후 onClick 이 처리).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && t.closest(".sl-chip-wrap")) return;
      setOpen(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);
  // 계정·CLI 연결 상태(크레딧·이메일 부차 정보) — 데이터 도메인 훅으로 분리(IME·에디터 무관).
  const { account, checkAccount } = useAccountStatus();
  const agentOn = useSpotlightAgentStatus();
  // @/# 피커
  const [mention, setMention] = useState<SpotlightMention>(null);
  // 알약을 클릭해 텍스트로 풀어 이름 편집 중인 노드 — 그 안에서는 @가 멘션으로 재감지되지 않게 한다.
  const editingTokenNodeRef = useRef<Node | null>(null);
  const [hIdx, setHIdx] = useState(0);
  const [assetCtx, setAssetCtx] = useState(readSpotlightAssetCtx);
  const { allSources, sourceList, tagCounts, tagFilter, tagList, setTagFilter } =
    useSpotlightMentionSources(mention, assetCtx.project);
  // ── 확장(+) 레퍼런스 트레이 + Canvas 씬 카드 양방향 바인딩 — useSpotlightTray 훅으로 추출(동작 보존).
  //  외부 파일 임포트(importExternalFilesAsRefs)는 카드/에셋 도메인이라 컴포넌트에 남기고 콜백으로 주입.
  //  화살표로 감싸는 이유: importExternalFilesAsRefs 는 아래(선언 순서상 뒤)에 있어 호출 시점(드롭=마운트 후)에만 참조 → TDZ 회피.
  const {
    trayRefs, setTrayRefs, sceneMode, withFreshTrayUids,
    addAssetToTray, removeTrayRef, onTrayKeyDown, onTrayDragOver, onTrayDrop,
    onTrayItemDragStart, onTrayItemDrop,
  } = useSpotlightTray({
    trayBinding,
    onTrayBindingRefsChange,
    onImportFiles: (files) => importExternalFilesAsRefs(files),
  });
  const [promptTick, setPromptTick] = useState(0); // contentEditable 텍스트 변경 신호(트레이 역할 배지 갱신)
  const editorRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  // 프롬프트 기록(쉘식 ↑↓): historyRef=제출 기록(오래된→최신), histIdxRef=탐색 위치(-1=라이브)
  const historyRef = useRef<HistEntry[]>(loadHistory());
  const histIdxRef = useRef(-1);
  // 드래그해서 불러온 원본 gen id — 다음 생성의 자동 히스토리(원본→파생) 부모. 제출 시 1회 소모.
  const dragParentRef = useRef<string | null>(null);

  // 트레이 역할 배지 갱신 신호 — 안정된 콜백으로 만들어 토큰 훅 blur effect 가 원본처럼 model/trayRefs 변화 때만 재구독되게 한다.
  const bumpPromptTick = useCallback(() => setPromptTick((n) => n + 1), []);
  // 미디어 레퍼런스 토큰(@image1/<<<video1>>>) → 색 있는 알약 정규화 — useSpotlightTokenWrap 훅으로 추출(동작 보존).
  //  editingTokenNodeRef 는 멘션 감지와 공유하므로 컴포넌트 소유, 훅엔 주입(blur 에서 null 로만 해제).
  //  scheduleLiveWrap 은 아래 onEditorInput/onCaretMove 가 (이벤트 시점에) 참조 — 선언 순서상 forward 참조지만 호출은 마운트 후라 안전.
  const { resolveTokenMedia, scheduleLiveWrap } = useSpotlightTokenWrap({
    model,
    trayRefs,
    editorRef,
    editingTokenNodeRef,
    composingRef,
    onPromptChanged: bumpPromptTick,
  });

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

  // 카드의 '재사용' 버튼 → 그 생성물의 프롬프트+옵션을 입력바로 불러온다(드래그 없이 버튼으로도).
  //  (캔버스 생성결과 팝업 등에서 dispatchAppEvent(reusePrompt, id) 로 호출. useCustomEvent 가 항상
  //   최신 reusePromptFromGen 을 부르므로 stale 없음.)
  useCustomEvent(APP_EVENTS.reusePrompt, (e) => {
    const id = (e as CustomEvent<string>).detail;
    if (id) void reusePromptFromGen(id);
  });

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
    setMention(composingRef.current ? null : detectMention(ed, editingTokenNodeRef.current));
    setPromptTick((n) => n + 1);
    scheduleLiveWrap(); // 손으로 친 토큰을 곧(디바운스) 알약으로 — blur 까지 안 기다림
  };

  const liveSeedanceRoles = useMemo(() => {
    // 트레이 배지 전용 — 트레이가 비어 있으면(레퍼런스 미사용) 소비처가 없으니
    // 키 입력마다 에디터 DOM 직렬화+정규식 스캔을 하지 않는다.
    if (!trayRefs.length) return emptySeedanceTokenRoles();
    const ed = editorRef.current;
    return seedanceTokenRoles(ed ? serialize(ed).text : "");
  }, [promptTick, trayRefs]);

  // @ 피커에 얹을 '트레이 항목' 목록 — seedance 모드에서만(@imageN 토큰이 그때만 해석됨). 고르면
  // @image1 같은 텍스트 토큰을 넣는다(소스=시각적 칩과 구분). 입력한 @뒤 질의로 필터(빈 질의=전체).
  const trayMentionList = useMemo(() => {
    if (mention?.kind !== "@" || !usesMediaRefTokens(model) || !trayRefs.length) return [];
    const q = mention.query.toLowerCase();
    return trayRefs
      .map((ref, index) => ({
        index,
        token: seedanceTrayToken(trayRefs, index),
        type: ref.type as string,
        name: ref.name,
        // 비디오는 파일 URL(→<video>), 그 외는 썸네일. 오디오는 빈 값(아이콘 폴백).
        media: ref.type === "video" ? refSrc(ref.file_path) || "" : ref.thumb || "",
      }))
      .filter((it) => !q || it.token.slice(1).toLowerCase().includes(q));
  }, [mention, model, trayRefs]);

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
  const onCaretMove = (e?: React.SyntheticEvent) => {
    const ed = editorRef.current;
    if (!ed || composingRef.current) return;
    // 클릭 시: 알약을 눌렀으면 텍스트로 풀어 이름 편집(이동/blur 시 재알약화). 다른 곳을 눌렀으면
    // 앞서 풀어둔 토큰이 있을 수 있으니 디바운스 재알약화를 예약(캐럿 있는 노드는 skip).
    if (e && e.type === "click" && usesMediaRefTokens(model)) {
      const clickedPill = (e.target as HTMLElement).closest<HTMLElement>(".sl-tok");
      if (clickedPill) {
        editingTokenNodeRef.current = unwrapTokenPill(clickedPill); // 이 노드 안에선 멘션 감지 끔
        setPromptTick((n) => n + 1);
        return; // 편집 진입 — 멘션 감지 스킵
      }
      scheduleLiveWrap();
    }
    const next = detectMention(ed, editingTokenNodeRef.current);
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

  // 트레이 항목을 @토큰(@image1 등) '색 있는 알약'으로 삽입 — 소스(시각적 칩)와 달리 기존 트레이
  // 레퍼런스를 가리킨다(새 레퍼런스 아님). 텍스트로는 @image1 이라 파싱/제출은 그대로.
  const selectTrayRef = (index: number) => {
    const ed = editorRef.current;
    if (!ed) return;
    const item = trayRefs[index];
    const type = item?.type;
    const kind = type === "video" ? "video" : type === "audio" ? "audio" : "image";
    // 비디오는 썸네일이 없어 파일 URL(→<video> 첫 프레임), 그 외는 썸네일 이미지.
    const media = type === "video" ? refSrc(item?.file_path) : item?.thumb || undefined;
    insertRefToken(ed, seedanceTrayToken(trayRefs, index), kind, media);
    updatePlaceholder();
    setPromptTick((n) => n + 1);
    setMention(null);
    ed.focus();
  };

  // ↑↓ 히스토리 항목 복원 — 에디터(파트)뿐 아니라 트레이 레퍼런스도 되살린다(uid 재생성). 토큰 프롬프트가
  // 레퍼런스 없이 제출되던 문제 해결. 방금 만든 freshTray 로 알약 썸네일을 풀어 stale 방지.
  const applyHistEntry = (ed: HTMLElement, entry: HistEntry) => {
    const freshTray = withFreshTrayUids(entry.trayRefs ?? []);
    // 씬 모드에선 트레이가 씬 카드에 바인딩돼 있다 — 히스토리 '미리보기' 스크럽이 씬 카드 레퍼런스를
    // 덮어쓰지 않도록 트레이는 건드리지 않는다(재사용=확정 로드와 달리 히스토리는 비파괴적).
    if (!sceneMode) {
      setTrayRefs(freshTray);
      if (freshTray.length && !expanded) onToggleExpand(); // 레퍼런스 있으면 트레이 펼쳐 보이게(재사용과 동일)
    }
    restoreParts(ed, entry.parts);
    if (usesMediaRefTokens(model)) wrapRefTokens(ed, (k, n) => resolveTokenMedia(k, n, freshTray));
    updatePlaceholder();
    setPromptTick((n) => n + 1);
  };

  const clearTagFilter = () => setTagFilter(null);

  // ── 프롬프트 재사용(명시적): 그 생성의 프롬프트+옵션을 입력바로 그대로 불러옴 ──
  //    카드 오버레이의 '프롬프트 재사용' 버튼(ch:reuse-prompt 이벤트)이 호출. 드래그와 분리.
  const reusePromptFromGen = async (id: string) => {
    try {
      const g = await api.getGeneration(id);
      // 재사용 원본 → 다음 생성의 자동 히스토리 부모(원본→파생).
      dragParentRef.current = id;
      // 모드 판정 — 출력 자산 타입이 우선(성공작). 단 실패 생성은 자산이 없어 무조건 image 로
      //  떨어졌다 → 모델이 속한 모드로 폴백(seedance(video) 재사용이 Nano Banana(image)로 깨지던 문제).
      const assetType = g.assets[0]?.type;
      const t: "image" | "video" =
        assetType === "video"
          ? "video"
          : assetType === "image"
            ? "image"
            : ALLOWED.video.includes(g.model || "")
              ? "video"
              : "image";
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
      // ★재사용은 '현재 접힘/펼침'이 아니라 '생성물이 토큰 방식인지'로 분기 → 접든 열든 같은 결과가 들어온다.
      //  · 토큰 방식(<<<imageN>>>·@imageN 이 프롬프트에 있음): 레퍼런스를 트레이로, 프롬프트 토큰은 알약으로.
      //  · 인라인-칩 방식(@소스명): display_prompt 로 인라인 소스칩 복원(트레이는 비움).
      // 토큰 감지·복원은 display_prompt 기준(원본 토큰 @image1·@simage1 보존). g.prompt(CLI)는 <<<image1>>>
      //  또는 시작/끝 프레임의 경우 '첫 프레임/끝 프레임' 텍스트로 정규화돼 있어 토큰이 사라진다.
      const tokenSrc = g.display_prompt || (g.prompt && g.prompt !== "(no text)" ? g.prompt : "");
      // 트레이 vs 인라인 소스칩 판정 — display_prompt 에 그 소스의 @이름 토큰이 실제로 박혀 있으면
      // '인라인 소스칩'으로 만든 것(그 자리에 칩 복원). 없으면 트레이 레퍼런스 → 트레이로 복원.
      // (이미지 모델은 @imageN 토큰을 프롬프트에 안 심어서, 예전엔 토큰 없다는 이유로 트레이 refs 가
      //  인라인 칩으로 잘못 붙었다 — 캔버스 생성물 재사용이 그 경우였다.)
      const hasInlineSourceChips = g.references.some(
        (r) => !!r.source && r.source !== "uploaded" && tokenSrc.includes("@" + r.source),
      );
      const tokenMode = g.references.length > 0 && !hasInlineSourceChips;
      if (tokenMode) {
        const chipRefs = refsToChips(g.references).flatMap((p) =>
          p.t === "chip" ? [p.ref as ChipRef] : [],
        );
        const freshTray = withFreshTrayUids(chipRefs);
        setTrayRefs(freshTray);
        if (!expanded) onToggleExpand(); // 토큰 방식은 트레이를 써야 하므로 펼쳐 보인다(접힘/펼침 동일하게)
        if (ed) {
          restoreParts(ed, tokenSrc ? [{ t: "text" as const, v: tokenSrc }] : []);
          // 방금 만든 freshTray 로 미디어를 풀어 알약 썸네일이 안 어긋나게(setTrayRefs 는 아직 state 반영 전).
          if (usesMediaRefTokens(useModel))
            wrapRefTokens(ed, (k, n) => resolveTokenMedia(k, n, freshTray));
          updatePlaceholder();
          setPromptTick((n) => n + 1);
          ed.focus();
        }
      } else {
        // 인라인-칩 방식 — display_prompt 로 @소스명 칩을 제자리에 복원. 트레이는 비워 이중표현 방지.
        setTrayRefs([]);
        let parts = buildPromptParts(g.display_prompt || g.prompt || "", g.references);
        // 매칭 못한 레퍼런스는 버리지 않고 말미에 칩으로 보충(누락 방지). buildPromptParts 는 큐를 앞에서부터
        // 소비하므로 매칭된 칩 수만큼이 앞쪽 refs 이고, 그 뒤(막힌 것)가 누락분이다.
        const matched = parts.filter((p) => p.t === "chip").length;
        if (matched < g.references.length) {
          parts = [...parts, ...refsToChips(g.references.slice(matched))];
        }
        if (ed) {
          restoreParts(ed, parts); // 재사용은 '교체' — 입력바를 그 프롬프트로 채움
          if (usesMediaRefTokens(useModel)) wrapRefTokens(ed, resolveTokenMedia);
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
        // role 은 트레이용(@Video/@Image)으로 먼저 조정한 뒤 uid 부여(role 조정은 호출부 책임).
        const [trayRef] = withFreshTrayUids([{ ...ref, role: isVid ? "@Video" : "@Image" }]);
        setTrayRefs((prev) => [...prev, trayRef]);
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
      setError("이미지/영상/오디오 파일만 레퍼런스로 추가할 수 있습니다.");
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
        setError("이미지/영상/오디오 파일만 레퍼런스로 추가할 수 있습니다.");
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
  const submit = async () => {
    if (busy) return; // 진행 중(비율 측정 await 포함) 재진입 방지 — 중복 생성 차단
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
    // 모델 전환 직후 새 스키마/옵션 로드 전이면 stale 옵션(이전 모델 값·enum)이 섞여 제출될 수 있다 → 잠깐 막는다.
    if (paramsLoading || paramsModel !== model) {
      setError("모델 옵션을 불러오는 중입니다. 잠시 후 다시 생성해 주세요.");
      return;
    }
    // 표시용 프롬프트(칩 자리에 @소스명) — CLI 본문(text)과 분리해 저장. 줄바꿈 보존(재사용 시 복원).
    const parts = serializeParts(ed);
    const displayPrompt = partsDisplay(parts);
    // 비율 측정(auto)·생성 동안 버튼을 비활성화해 중복 제출을 막는다(측정이 최대 몇 초 걸릴 수 있음).
    setBusy(true);
    try {
      // aspect_ratio 가 'auto'(우리가 합성한 값)면 CLI 로 보내기 전에 레퍼런스 비율로 치환한다(CLI 는 auto 를 거부).
      // 트레이 + 인라인 칩 이미지를 모두 후보로(접힌 상태의 인라인 이미지도 비율 측정 대상).
      // ★비율 측정·body 생성도 try 안 — 예외가 나도 아래 catch 에서 busy 를 풀어 버튼이 영구 잠기지 않게 한다.
      const resolvedOpts = await resolveAutoAspectRatio(optionValues, tunable, [...trayRefs, ...inlineRefs]);
      const { body, error: bodyError } = buildSpotlightCreateBody({
        text,
        inlineRefs,
        trayRefs,
        parts,
        displayPrompt,
        model,
        optionValues: resolvedOpts,
        armedAutoTags,
        activeProjectId,
        // 무장 폴더가 현재 프로젝트와 일치할 때만 folder_path 로 라벨링(전역변수 가드).
        folderPath:
          armedFolder && armedFolder.projectId === activeProjectId ? armedFolder.path : undefined,
      });
      if (bodyError || !body) {
        setError(bodyError || "생성 요청을 만들 수 없습니다.");
        setBusy(false);
        return;
      }
      // 배치: 같은 설정으로 N장 동시 생성(각각 별도 잡). 씬 모드도 N장 → 그 카드에 변형으로 누적된다.
      const batch = Math.max(1, count);
      const created = await Promise.all(Array.from({ length: batch }, () => api.create(body)));
      // 드래그로 불러온 원본이 있으면 그것을 부모로 자동 히스토리 기록(App 이 처리). 1회 소모.
      const dragParent = dragParentRef.current;
      dragParentRef.current = null;
      onCreated(created, dragParent); // 방금 만든 pending 들을 즉시 '대기' 카드로(optimistic) + 리로드
      // 프롬프트 기록에 추가 — 텍스트+칩 구조 보존. 같은 내용은 전부 제거 후 최신으로,
      // 최근 HIST_MAX(20)개만 유지.
      const key = displayPrompt; // 텍스트+@칩 까지 반영한 중복 판정 키
      if (key) {
        const filtered = historyRef.current.filter((h) => h.text !== key);
        // 트레이 레퍼런스도 저장(uid 제외) — 토큰 프롬프트를 ↑ 로 불러 제출해도 레퍼런스가 살아있게.
        const histTray: ChipRef[] = trayRefs.map(({ uid: _uid, ...ref }) => ref);
        filtered.push({ parts, text: key, trayRefs: histTray.length ? histTray : undefined });
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
          if (ed) applyHistEntry(ed, hist[idx]);
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
              if (!sceneMode) setTrayRefs([]); // 프롬프트 비우면 트레이도 비움(씬 모드는 씬 카드 보호)
              updatePlaceholder();
              placeCaretAtEnd(ed);
              setPromptTick((n) => n + 1);
            }
          } else {
            histIdxRef.current = idx;
            if (ed) applyHistEntry(ed, hist[idx]);
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

    // @ 피커 네비 — 트레이 항목(앞) + 소스(뒤) 통합 인덱스로 이동/선택.
    const atLen = trayMentionList.length + sourceList.length;
    if (mention?.kind === "@" && atLen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHIdx((i) => Math.min(i + 1, atLen - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && !composing) {
        e.preventDefault();
        const i = Math.max(0, Math.min(hIdx, atLen - 1));
        if (i < trayMentionList.length) selectTrayRef(trayMentionList[i].index);
        else selectSource(sourceList[i - trayMentionList.length]);
        return;
      }
    }

    // Shift+Enter → 줄바꿈. 브라우저 기본은 <div> 블록을 넣기도 하는데, 그러면 serialize 가 \n 을 못 읽어
    // 재사용에서 한 줄로 뭉개진다. execCommand insertLineBreak 로 <br> 를 확실히 넣어 \n 으로 읽히게 한다.
    if (e.key === "Enter" && e.shiftKey && !composing && !mention) {
      e.preventDefault();
      document.execCommand("insertLineBreak");
      onEditorInput();
      return;
    }
    // 평상시 Enter → 생성
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
              trayList={trayMentionList}
              onSelectTrayRef={selectTrayRef}
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
              onPreview={onPreview}
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
