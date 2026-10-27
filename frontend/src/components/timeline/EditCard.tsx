// 편집 탭 미디어 풀의 썸네일 카드 — 라이브러리 카드(GenerationCard)를 그대로 쓴다(Jay 2026-10-15: "카드에 정보를 입력할 수 있게").
//  호버 단추(S·T·C·ⓘ·⤓)·모양·처리는 라이브러리 것이고, 여기는 풀의 껍데기(누르기·끌기·더블클릭·우클릭·휠 클릭은 풀이 건다)와 표만 둔다.
//  껍데기는 단추가 아니다 — 단추 안에 단추를 둘 수 없다. 대신 role=button 으로 Tab·Enter·Space 를 단추처럼 받는다.
import type { ComponentProps, HTMLAttributes, KeyboardEvent } from "react";
import { useT } from "../../lib/i18n";
import { focusCameByTab } from "../../lib/keyGate";
import type { Generation } from "../../types";
import { GenerationCard } from "../GenerationCard";

export interface PoolItem {
  gen: Generation;
  track: number | null; // 타임라인에 넣은 트랙(안 넣었으면 null)
  showing: boolean; // 지금 타임라인 뷰어에 보이는 것
  source?: "S" | "L" | "R" | "LR"; // 소스 클립 판에 떠 있다(Jay 2026-10-14) — S = 싱글 뷰어, 듀얼이면 왼쪽·오른쪽·둘 다
  resolve?: boolean; // 다빈치(미디어 풀)에서 고른 것(Jay 2026-10-14) — 빨간 테두리와 '다빈치' 표
  timeline?: boolean; // 타임라인에서 고른 클립의 카드(Jay 2026-10-15 A) — 다빈치 것과 같은 빨간 고리·빛, 표는 그대로
  off?: boolean; // 비활성(회색 — 공유 탭과 같은 판정: d 키 카드·비활성 폴더 아래). 그림을 회색 + 빗금으로(Jay 2026-10-23)
}

// 풀 카드의 호버 단추가 부르는 앱의 동작 — 라이브러리 격자에 주는 것과 같은 것(App). 편집 탭을 떠나게 하는 것(⬇ 가져오기·가계)과
//  숨은 프롬프트를 고치는 것(⠿·@)은 넘기지 않는다(풀에서는 CSS 로 숨긴다 — docs/EDIT_TAB.md).
export type PoolCardActions = Required<Pick<ComponentProps<typeof GenerationCard>,
  "canFinalize" | "onReview" | "onPublish" | "onUnpublish" | "onFinalize" | "onUnfinalize" |
  "autoTagOptions" | "onOpenComments" | "onInfo">> & {
  // 태그 저장 — 돌려주는 약속이 풀리면 그 저장이 끝났다(풀이 덧입힌 태그를 언제 걷을지 본다)
  onSetTags: (g: Generation, tags: string[]) => void | Promise<void>;
  onSetAutoTags: (g: Generation, names: string[]) => void | Promise<void>;
};
const noop = () => {};
export const NO_CARD_ACTIONS: PoolCardActions = {
  canFinalize: () => false, onReview: noop, onPublish: noop, onUnpublish: noop, onFinalize: noop, onUnfinalize: noop,
  onSetTags: noop, onSetAutoTags: noop, autoTagOptions: [], onOpenComments: noop, onInfo: noop,
};

// 타임라인에 넣은 카드의 표 글 — 미디어 풀과 폴더 창이 같은 글을 쓴다.
export const editMarkLabel = (track: number, t: (key: string) => string) =>
  t("V{track} - 선택 카드").replace("{track}", String(track));

// 소스 클립 판의 표 글 — "소스 L"·"소스 R"·"소스 L·R"(싱글 뷰어면 "소스"). 풀의 세 보기와 폴더 창이 같은 글을 쓴다.
export const sourceMarkLabel = (source: PoolItem["source"], t: (key: string) => string) =>
  !source ? "" : `${t("소스")}${source === "S" ? "" : ` ${source === "LR" ? "L·R" : source}`}`;

// 풀 카드의 표 — 넣은 트랙과 소스 클립 판(둘 다면 이어서). 없으면 null. short = 작은 카드에 보이는 짧은 글
export function poolMark(item: PoolItem, t: (key: string) => string): { label: string; short: string; lead: boolean } | null {
  const side = item.source === "LR" ? "L·R" : item.source === "S" ? "" : item.source ?? "";
  const source = sourceMarkLabel(item.source, t);
  const label = [item.track !== null ? editMarkLabel(item.track, t) : "", source].filter(Boolean).join(" · ");
  if (!label) return null;
  const short = [item.track !== null ? `V${item.track}` : "", item.source ? side || t("소스") : ""].filter(Boolean).join("·");
  return { label, short, lead: item.showing || !!item.source }; // 지금 뷰어에 보이는 것만 라임
}

export function EditCard({
  item,
  picked,
  handlers,
  actions,
  tagging,
  onTagging,
}: {
  item: PoolItem;
  picked: boolean; // 풀에서 고른 카드(듀얼 뷰어의 소스)
  handlers: HTMLAttributes<HTMLElement>; // 누르기·더블클릭·우클릭·휠 클릭·설명 — 세 보기가 같은 것을 쓴다
  actions: PoolCardActions;
  tagging: boolean; // T 로 태그를 고치는 중(한 번에 한 장 — 풀이 쥔다)
  onTagging: (on: boolean) => void;
}) {
  const t = useT();
  const base = poolMark(item, t);
  // 다빈치에서 고른 것 — 표 글 끝에 '다빈치'를 잇고 빨갛게(표가 없던 카드면 '다빈치'만)
  const dv = t("다빈치");
  const mark = !item.resolve ? base
    : { label: base ? `${base.label} · ${dv}` : dv, short: base ? `${base.short}·${dv}` : dv, lead: true };
  // Enter·Space = 누르기(단추와 같다). 마우스로 남은 초점의 Space 는 편집 키(재생)다 — 편집 탭의 규칙(조작 규칙 8)과 같다.
  //  이미 막힌 키(끄는 중 — useDragKeyHold 가 잡는 단계에서 막는다)는 누르지 않는다: 단추라면 브라우저가 누르지 않았다(Codex 리뷰)
  const press = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && !(event.key === " " && focusCameByTab())) return;
    event.preventDefault();
    event.currentTarget.click();
  };
  return (
    <div role="button" tabIndex={0} className={"ed-card" + (picked ? " ed-picked" : "") + (item.resolve ? " ed-dv" : "") + (item.timeline ? " ed-tlsel" : "") + (item.off ? " ed-off" : "")}
      {...handlers} onKeyDown={press}
      // 라이브러리 카드는 HTML 끌기(프롬프트 재사용)다 — 풀의 끌기(타임라인에 넣기)는 마우스 끌기라 HTML 끌기가 시작되면 멈춘다
      onDragStart={(event) => event.preventDefault()}>
      {/* 넣은 카드 = 라이브러리의 '선택'과 같은 굵은 상태색 테두리(selected) */}
      <GenerationCard gen={item.gen} tab="team" layout="grid" selected={item.track !== null} mark={mark ?? undefined} wheelMenu
        editingField={tagging ? "tag" : null} onRequestEdit={(_, field) => onTagging(field === "tag")} onEditDone={() => onTagging(false)}
        // 격자 모드에서 쓰지 않는 것(미리보기 = 목록 모드의 누르기 · 재생성 = 내 작업 탭 · 소스 · 복구 = 휴지통)과 뺀 것(⬇ 가져오기)
        {...actions} onPreview={noop} onSetSource={noop} onRegenerate={noop} onImport={noop} onRestore={noop} />
    </div>
  );
}
