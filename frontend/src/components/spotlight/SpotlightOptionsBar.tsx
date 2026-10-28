import { Fragment, useEffect, useRef, useState, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { api } from "../../api";
import { getAccountNamespace, getConnectionKey } from "../../lib/accountScope";
import { getAuthToken } from "../../lib/http";
import type { VoiceInfo } from "../../types";
import { useEscapeClose } from "../../lib/useEscapeClose";
import type { MediaType, ModelInfo, ModelParam } from "../../types";
import { effectiveDefault, numericRange, paramGateAllows } from "../../lib/useModels";
import {
  SPOTLIGHT_PRIMARY_PARAMS,
  DUBBING_LANGUAGES,
  audioModelBlocked,
  isTtsModel,
  isVideoVoiceModel,
  recommendedVoiceIds,
  currentVariantValue,
  durationRange,
  isVariantParam,
  modelChipLabel,
  modelRows,
  spotlightAdvancedParamRank,
  spotlightIgnoredOptions,
  spotlightParamLabel,
} from "../../lib/spotlightPromptConfig";
import { SpotlightOptionIcon } from "./SpotlightOptionIcon";
import { SpotlightDurationChip } from "./SpotlightDurationChip";
import { normalizeSeedanceDraftParams } from "../../lib/seedanceDraft";
import voiceCatalog from "../../lib/voiceCatalog.json";

type OptionValue = string | number | boolean;
type OptionValues = Record<string, OptionValue>;
type ConstraintMap = Record<string, { allow: Set<string>; note: string }>;
const voiceScopeKey = () => `${getAccountNamespace()}\0${getConnectionKey()}\0${getAuthToken() ?? ""}`;
// 목소리 id → [성별, 미리듣기 주소, 나이]. CLI voices list 에 없어 성별·주소는 힉스필드 MCP list_voices, 나이는 웹 목소리 창의
//  나이 필터 결과로 만든 고정 표(2026-10-28 — 114개, CLI 와 같은 id).
// shortcut: 힉스필드가 목소리를 더하거나 주소를 바꾸면 낡는다(표에 없는 목소리는 '전체'에만·미리듣기 없음으로 보인다). 어긋나면 다시 받는다.
const VOICE_CATALOG: Record<string, string[] | undefined> = voiceCatalog;
const VOICE_FILTERS = [
  { label: "성별", slot: 0, options: [["all", "전체"], ["male", "남성"], ["female", "여성"]] },
  { label: "나이", slot: 2, options: [["all", "전체"], ["young", "청년"], ["middle_aged", "중년"], ["old", "노년"]] },
] as const;

// 정수 칸이 받을 수 없는 수인가 — 정확히 담을 수 없는 큰 정수(2^53 이상: `Number()` 가 9007199254740993 → …992 로 바꾼다)와
//  소수(시드 1.5 — CLI 의 정수 옵션에 그대로 실린다, Codex P2 2026-10-14). 받지 않는다: 받으면 친 것과 다른 값이 제출된다(조작 규칙 49).
//  칸은 그대로 남는다(그 글자가 들어가지 않는다 — 규칙 43 의 '받을 수 없으면 받지 않는다').
const inexactInteger = (value: OptionValue): boolean =>
  typeof value === "number" && !Number.isSafeInteger(value);
// 옵션 칩 목록 머리 글(Jay 2026-10-28 — 힉스필드 웹 표기). 길이 창의 "Duration" 은 SpotlightDurationChip 이 단다.
const OPTION_TITLES: Record<string, string> = { aspect_ratio: "Aspect Ratio", resolution: "Quality" };
// 고급(Set) 창은 한글 없이 영어로만(Jay 2026-10-28) — 이름은 파라미터 이름을 사람 말로(bitrate_mode → Bitrate),
//  값은 CLI 값 그대로, TTS 언어 코드만 영어 이름(ko → Korean, 빈 값 → Auto). 화면 읽기용 이름(aria-label)은 한글 그대로다.
const ADVANCED_LABELS: Record<string, string> = { bitrate_mode: "Bitrate", enable_web_search: "Web search", enable_image_search: "Image search" };
const advancedLabel = (name: string) => {
  const text = ADVANCED_LABELS[name] ?? name.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};
// 이름에 마우스를 올리면 한국어 설명(Jay 2026-10-28) — 무슨 옵션인지 한 줄 + 뜻을 아는 값은 값마다 한 줄. 표에 없는 옵션은 한글 이름만.
const ADVANCED_HELP: Record<string, string> = {
  mode: "어떤 방식으로 만들지 고릅니다.",
  genre: "영상의 장르·분위기를 정합니다.",
  bitrate_mode: "영상 데이터 양 — 높을수록 더 선명하고 파일이 큽니다.",
  thinking_level: "그리기 전에 지시를 얼마나 깊게 따져 볼지 정합니다.",
  enable_web_search: "만들기 전에 웹에서 찾아 참고할지 정합니다.",
  enable_image_search: "만들기 전에 이미지를 찾아 참고할지 정합니다.",
  seed: "같은 숫자면 비슷한 결과가 나옵니다. 비우면 매번 새로 뽑습니다.",
  stability: "높으면 목소리가 고르고, 낮으면 감정 표현이 커집니다.",
  similarity_boost: "높을수록 원래 목소리에 가깝게 냅니다.",
  instruction: "어떻게 말할지 글로 지시합니다.",
  language: "말할 언어입니다. Auto 면 공급자가 정합니다.",
  speech_rate: "말하는 빠르기입니다.",
  pitch_rate: "목소리 높낮이입니다.",
  loudness_rate: "소리 크기 조절입니다.",
  volume: "소리 크기입니다.",
  format: "오디오 파일 형식입니다.",
  sample_rate: "오디오 품질(Hz) — 높을수록 고음질입니다.",
};
const ADVANCED_VALUE_HELP: Record<string, Record<string, string>> = {
  mode: { t2v: "글만으로 만들기", omni_reference: "넣은 이미지·영상·오디오를 참고해 만들기", video_edit: "넣은 영상 1개를 고치기",
    video_extension: "넣은 영상 앞·뒤로 이어 붙이기" },
  bitrate_mode: { standard: "기본 화질", high: "더 선명하게(파일이 큼)" },
};
// 브라우저 기본 말풍선은 작고 흐려서 앱 모양 상자로 띄운다(Jay 2026-10-28) — 이름에 마우스를 올리면 CSS 로 보인다.
function AdvancedHelp({ name, values = [] }: { name: string; values?: string[] }) {
  const rows = values.filter((v) => ADVANCED_VALUE_HELP[name]?.[v]);
  return (
    <div className="sl-adv-help" role="tooltip">
      <b>{spotlightParamLabel(name)}</b>
      {ADVANCED_HELP[name] && <p>{ADVANCED_HELP[name]}</p>}
      {rows.length > 0 && (
        <dl>{rows.map((v) => <Fragment key={v}><dt>{v}</dt><dd>{ADVANCED_VALUE_HELP[name][v]}</dd></Fragment>)}</dl>
      )}
    </div>
  );
}
/** Set 창의 범위를 아는 숫자 옵션 — 길이 창과 같은 끌기 막대(Jay 2026-10-28, 힉스필드 Pitch 막대). 기본값 자리에 세로 금을 긋고
 *  기본값↔손잡이 사이를 라임으로 채운다. 화살표 키는 한 걸음씩. 오른쪽 숫자를 누르면 기본값으로(값이 없으면 'Default'). */
function AdvancedRange({ label, value, base, min, max, step, onChange, onReset }: {
  label: string; value: number | null; base: number | null; min: number; max: number; step: number;
  onChange: (value: number) => void; onReset: () => void;
}) {
  const at = (v: number) => ((Math.min(max, Math.max(min, v)) - min) / (max - min)).toFixed(4);
  const shown = value ?? base;
  const text = (v: number) => String(Math.round(v * 100) / 100);
  const marks = [...new Set([min, ...(base != null && base > min && base < max ? [base] : []), max])];
  const pos = Number(at(shown ?? min)), zero = Number(at(base ?? min));
  const style = { "--lo": Math.min(pos, zero), "--hi": shown == null ? zero : Math.max(pos, zero), "--zero": zero } as CSSProperties;
  return (
    <div className="sl-adv-range">
      <div className={"sl-dur-track" + (shown == null ? " unset" : "")} style={style}>
        <span className="sl-range-fill" aria-hidden="true" />
        {base != null && <span className="sl-range-zero" aria-hidden="true" />}
        <input type="range" aria-label={label} min={min} max={max} step={step} value={shown ?? (min + max) / 2}
          onChange={(e) => onChange(Number(e.target.value))} />
      </div>
      <button type="button" className="sl-adv-range-val" title="Reset" onClick={onReset}>{shown == null ? "Default" : text(shown)}</button>
      <div className="sl-dur-marks" aria-hidden="true">
        {marks.map((v) => <span key={v} style={{ "--at": at(v) } as CSSProperties}>{text(v)}</span>)}
      </div>
    </div>
  );
}
const LANGUAGE_NAMES = new Intl.DisplayNames(["en"], { type: "language" });
const advancedValue = (value: string, name: string) => {
  if (name !== "language") return value;
  if (!value) return "Auto";
  try { return LANGUAGE_NAMES.of(value) ?? value; } catch { return value; } // 모르는 코드면 코드 그대로
};

interface Props {
  type: MediaType;
  setType: (value: MediaType) => void;
  audioTask?: string;
  onAudioTaskChange?: (task: string) => void;
  model: string;
  setModel: (value: string) => void;
  /** 다른 모델로 옮기면서 옵션도 함께 지정한다(변형 선택). 같은 모델이면 setOpt 로 값만 바꾼다. */
  onPickModel: (model: string, opts: Record<string, string | number | boolean>) => void;
  modelName: string;
  typeModels: ModelInfo[];
  // 그룹 사용 모델 — 지금 고른 모델을 못 쓰면 칩을 붉게, 드롭다운 머리에 안내를 띄운다.
  modelBlocked?: boolean;
  blockedNote?: string | null;
  // 이 타입의 모델을 전부 못 씀 — 카탈로그 미로딩으로 목록이 빈 것과 구별해 안내한다.
  typeFullyBlocked?: boolean;
  // 정책을 지금 확신할 수 없을 때(캐시로 표시 중·조회 실패) 드롭다운에 드러낸다.
  policyNote?: string | null;
  tunable: ModelParam[];
  constraints: ConstraintMap;
  optionValues: OptionValues;
  setOptionValues: Dispatch<SetStateAction<OptionValues>>;
  setOpt: (name: string, value: string | number) => void;
  open: string | null;
  setOpen: Dispatch<SetStateAction<string | null>>;
  /** bar = 생성창 아래 칩 한 줄(기본). rows = 옵션마다 '이름 | 값' 한 줄 — 캔버스 모델 설정 창(Jay 2026-10-28 시안 b2).
   *  rows 에서는 종류 단추를 그리지 않는다(창 머리줄이 SpotlightTypeToggle 로 그린다). */
  layout?: "bar" | "rows";
}

/** Image·Video·Audio 단추 — 생성창 칩 줄 맨 앞과 캔버스 모델 설정 창 머리줄이 같이 쓴다. */
export function SpotlightTypeToggle({ type, setType }: { type: MediaType; setType: (value: MediaType) => void }) {
  return (
    <div className="sl-type">
      {(["image", "video", "audio"] as const).map((t) => (
        <button key={t} className={"sl-type-btn" + (type === t ? " active" : "")} onClick={() => setType(t)}>
          {t.charAt(0).toUpperCase() + t.slice(1)}
        </button>
      ))}
    </div>
  );
}

function AdvancedIcon() {
  return (
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
  );
}

function VoiceIcon() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function PreviewIcon({ playing }: { playing: boolean }) {
  return (
    <svg width={10} height={10} viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
      {playing ? <rect x="1.5" y="1.5" width="7" height="7" rx="1" /> : <path d="M2.6 1.2v7.6L8.8 5z" />}
    </svg>
  );
}

/** 목소리 칩 + 이름 검색 목록 — 기본 목록 상자를 대신한다(2026-10-28 오디오 1단계).
 *  저장된 선택은 조회 실패·목록 밖이어도 지우거나 바꾸지 않는다('확인 필요'로만 보인다 — Codex A6).
 *  성별·나이 거르기·▶ 미리듣기는 고정 표(VOICE_CATALOG)를 쓴다 — 거르기·미리듣기는 선택을 바꾸지 않는다. */
function VoicePicker({
  voices,
  voicesError,
  value,
  onPick,
  open,
  setOpen,
  recommended = null,
}: {
  voices: VoiceInfo[];
  voicesError: boolean;
  value: string;
  onPick: (id: string) => void;
  open: string | null;
  setOpen: Dispatch<SetStateAction<string | null>>;
  /** 이 모델에 웹이 내놓는 목소리 — 위로 올리고 '추천'만 붙인다(나머지도 고를 수 있다). */
  recommended?: ReadonlySet<string> | null;
}) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<string[]>(() => VOICE_FILTERS.map(() => "all"));
  const [playing, setPlaying] = useState<string | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const isOpen = open === "voice";
  useEscapeClose(() => {
    setOpen(null);
    chipRef.current?.focus({ preventScroll: true });
  }, isOpen, true, true);
  const stopPreview = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  };
  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      stopPreview();
    }
  }, [isOpen]);
  useEffect(() => () => audioRef.current?.pause(), []);
  const togglePreview = (id: string, url: string) => {
    const again = playing === id;
    stopPreview();
    if (again) return;
    const audio = new Audio(url);
    // 이미 멈춘 소리의 늦은 실패(멈춤이 끊은 play 등)는 무시한다 — 지금 재생 중인 것만 '미리듣기 없음'으로 바꾼다.
    const fail = () => {
      if (audioRef.current !== audio) return;
      stopPreview();
      setFailed((previous) => new Set(previous).add(id));
    };
    audio.onended = () => {
      if (audioRef.current === audio) stopPreview();
    };
    audio.onerror = fail;
    audioRef.current = audio;
    setPlaying(id);
    audio.play().catch(fail);
  };
  const picked = voices.find((voice) => voice.id === value);
  const label = picked?.name
    ?? (value ? (voices.length || voicesError ? `${value} (확인 필요)` : "목소리 확인 중…") : voicesError ? "목소리 조회 실패" : "Voice");
  const q = query.trim().toLowerCase();
  const matched = voices.filter((voice) =>
    VOICE_FILTERS.every((filter, i) => filters[i] === "all" || VOICE_CATALOG[voice.id]?.[filter.slot] === filters[i])
    && (!q || voice.name.toLowerCase().includes(q)));
  const shown = recommended
    ? [...matched.filter((voice) => recommended.has(voice.id)), ...matched.filter((voice) => !recommended.has(voice.id))]
    : matched;
  const recommendedCount = recommended ? voices.filter((voice) => recommended.has(voice.id)).length : 0;
  return (
    <div className="sl-chip-wrap">
      <button
        ref={chipRef}
        aria-expanded={isOpen}
        aria-label="Voice"
        className={"sl-chip" + (isOpen ? " active" : "")}
        title={voicesError ? "목소리 목록을 불러오지 못했습니다. Host 콘솔을 확인하세요." : "Voice"}
        onClick={() => setOpen(isOpen ? null : "voice")}
      >
        <span className="sl-opt-ic"><VoiceIcon /></span>
        <span className="sl-chip-label">{label}</span>
        <span className="sl-caret">›</span>
      </button>
      {isOpen && (
        <div className="sl-dropdown sl-voice-pop">
          <div className="sl-dd-title">Voice{voices.length ? ` ${voices.length}개` : ""}{recommendedCount ? ` · 추천 ${recommendedCount}` : ""}</div>
          <input
            className="sl-voice-search"
            autoFocus
            aria-label="목소리 이름으로 찾기"
            placeholder="이름으로 찾기"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {VOICE_FILTERS.map((filter, i) => (
            <div key={filter.label} className="sl-type sl-voice-filter" role="group" aria-label={filter.label}>
              {filter.options.map(([key, text]) => (
                <button key={key} type="button" className={"sl-type-btn" + (filters[i] === key ? " active" : "")} aria-pressed={filters[i] === key}
                  onClick={() => setFilters((previous) => previous.map((value, k) => (k === i ? key : value)))}>{text}</button>
              ))}
            </div>
          ))}
          <div className="sl-dd-scroll">
            {shown.map((voice) => {
              const preview = failed.has(voice.id) ? undefined : VOICE_CATALOG[voice.id]?.[1];
              const on = playing === voice.id;
              return (
                <div key={voice.id} className="sl-voice-row">
                  <button
                    className={"sl-dd-item" + (voice.id === value ? " sel" : "")}
                    onClick={() => {
                      onPick(voice.id);
                      setOpen(null);
                    }}
                  >
                    {voice.name}
                    {recommended?.has(voice.id) && <span className="sl-voice-rec">추천</span>}
                  </button>
                  {preview ? (
                    <button type="button" className={"sl-voice-play" + (on ? " on" : "")}
                      aria-label={`${voice.name} ${on ? "미리듣기 멈춤" : "미리듣기"}`} title={on ? "멈춤" : "미리듣기"}
                      onClick={() => togglePreview(voice.id, preview)}>
                      <PreviewIcon playing={on} />
                    </button>
                  ) : (
                    <span className="sl-voice-play off" role="img" aria-label={`${voice.name} 미리듣기 없음`} title="미리듣기 없음">–</span>
                  )}
                </div>
              );
            })}
            {!shown.length && (
              <div className="sl-dd-empty">
                {voicesError ? "목소리 목록을 불러오지 못했습니다." : voices.length ? "맞는 목소리가 없습니다." : "불러오는 중…"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 번역(dubbing) 대상 언어 칩 — CLI target_language 18개를 한국어 이름으로. 고르기 전에는 '번역 언어'. */
function LanguagePicker({ value, onPick, open, setOpen }: {
  value: string;
  onPick: (code: string) => void;
  open: string | null;
  setOpen: Dispatch<SetStateAction<string | null>>;
}) {
  const chipRef = useRef<HTMLButtonElement>(null);
  const isOpen = open === "target_language";
  useEscapeClose(() => {
    setOpen(null);
    chipRef.current?.focus({ preventScroll: true });
  }, isOpen, true, true);
  const label = DUBBING_LANGUAGES.find(([code]) => code === value)?.[1];
  return (
    <div className="sl-chip-wrap">
      <button ref={chipRef} aria-expanded={isOpen} aria-label="번역 언어" title="번역 언어"
        className={"sl-chip" + (isOpen ? " active" : "")} onClick={() => setOpen(isOpen ? null : "target_language")}>
        <span className="sl-opt-ic"><VoiceIcon /></span>
        <span className="sl-chip-label">{label ?? "번역 언어"}</span>
        <span className="sl-caret">›</span>
      </button>
      {isOpen && (
        <div className="sl-dropdown">
          <div className="sl-dd-title">Target Language</div>
          <div className="sl-dd-scroll">
            {DUBBING_LANGUAGES.map(([code, name]) => (
              <button key={code} className={"sl-dd-item" + (code === value ? " sel" : "")}
                onClick={() => { onPick(code); setOpen(null); }}>{name}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function SpotlightOptionsBar({
  type,
  setType,
  audioTask = "tts",
  onAudioTaskChange,
  model,
  setModel,
  onPickModel,
  modelName,
  typeModels,
  modelBlocked = false,
  blockedNote = null,
  typeFullyBlocked = false,
  policyNote = null,
  tunable,
  constraints,
  optionValues,
  setOptionValues,
  setOpt,
  open,
  setOpen,
  layout = "bar",
}: Props) {
  if (audioModelBlocked(model)) { modelBlocked = true; blockedNote = audioModelBlocked(model); }
  const rows = layout === "rows";
  // 줄 배치면 '아이콘+이름 | 값' 한 줄로 감싼다(Set 창 줄과 같은 모양), 칩 줄이면 값(칩)만.
  const row = (key: string, label: string, icon: ReactNode, content: ReactNode) => !rows ? content : (
    <div className={"sl-adv-row sl-row-" + key} key={key}>
      <div className="sl-adv-label"><span className="sl-adv-name"><span className="sl-opt-ic">{icon}</span>{label}</span></div>
      <div className="sl-row-val">{content}</div>
    </div>
  );
  // 줄 배치의 값 캡슐 — 한 캡슐 안 칸들, 한 줄 6칸까지(넘치면 다음 줄)
  const capCols = (count: number) => ({ gridTemplateColumns: `repeat(${Math.min(count, 6)}, 1fr)` });
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voicesError, setVoicesError] = useState(false);
  const voiceScope = voiceScopeKey();
  useEffect(() => {
    if (!isTtsModel(model) && model !== "voice_change") return;
    let alive = true;
    setVoices([]);
    setVoicesError(false);
    void (async () => {
      const found = new Map<string, VoiceInfo>();
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await api.voices(cursor);
        if (!alive || voiceScope !== voiceScopeKey()) return;
        for (const voice of result.items) if (voice.voice_type === "preset") found.set(voice.id, voice);
        setVoices([...found.values()]);
        cursor = result.cursor || undefined;
        if (cursor && seen.has(cursor)) throw new Error("목소리 목록 페이지가 반복됩니다.");
        if (cursor) seen.add(cursor);
      } while (cursor);
    })().catch(() => { if (alive && voiceScope === voiceScopeKey()) setVoicesError(true); });
    return () => { alive = false; };
  }, [model, voiceScope]);
  const modelButtonRef = useRef<HTMLButtonElement>(null);
  // 두 호출 화면에서 같은 Esc 겹을 사용하고, 바깥 클릭에는 초점을 돌리지 않는다.
  useEscapeClose(() => {
    setOpen(null);
    modelButtonRef.current?.focus({ preventScroll: true });
  }, open === "model", true, true);
  // 조건부 게이트 — 현재 옵션 조합에서 허용 안 되는 파라미터는 표시하지 않는다
  // (예: extension_mode 는 mode=video_extension 일 때만 — 다른 모드에 실으면 CLI 거부).
  // 보이스 체인지·번역은 Voice·언어 칩만 — 스키마의 나머지(voice_type 등)는 고급에 띄우지 않는다.
  const visibleTunable = isVideoVoiceModel(model) ? [] : tunable.filter((p) => paramGateAllows(model, p.name, optionValues) &&
    !(isTtsModel(model) && ["voice_id", "voice_type", "dialogue"].includes(p.name)));
  const ignored = spotlightIgnoredOptions(model, optionValues.mode);
  const isDraftResolution = (name: string, value: unknown) => name === "resolution"
    && normalizeSeedanceDraftParams(model, { resolution: value }).draft === true;
  const audioParam = visibleTunable.find((p) => p.name === "generate_audio");
  const advancedParams = visibleTunable
    .filter(
      (p) =>
        !SPOTLIGHT_PRIMARY_PARAMS.has(p.name) &&
        p.name !== "generate_audio" &&
        !isVariantParam(model, p.name), // 모델 드롭다운이 맡은 값(seedance_2_0.mode)은 여기 중복 표시하지 않는다
    )
    .sort((a, b) => spotlightAdvancedParamRank(a.name) - spotlightAdvancedParamRank(b.name));
  const advancedDirty = advancedParams.some((p) => {
    const cur = optionValues[p.name];
    return cur != null && cur !== "" && String(cur) !== String(effectiveDefault(p, model) ?? "");
  });

  return (
    <>
      {!rows && <SpotlightTypeToggle type={type} setType={setType} />}

      {type === "audio" && onAudioTaskChange && row("task", "Task", <SpotlightOptionIcon name="audio" />,
        <div className={rows ? "sl-row-cap sl-audio-tasks" : "sl-type sl-audio-tasks"} style={rows ? capCols(3) : undefined} aria-label="오디오 작업">
          {[["tts", "Text to Speech"], ["voice-change", "Voice Change"], ["translate", "Translate"]].map(([id, label]) =>
            <button key={id} className={(rows ? "sl-adv-opt" : "sl-type-btn") + (audioTask === id ? (rows ? " sel" : " active") : "")} aria-pressed={audioTask === id}
              onClick={() => onAudioTaskChange(id)}>{label}</button>)}
        </div>)}
      {/* 보이스 체인지·번역은 실행 키가 하나라 모델 칩이 없다 */}
      {!isVideoVoiceModel(model) && row("model", "Model", <SpotlightOptionIcon name="model" />, <div className="sl-chip-wrap">
        <button
          ref={modelButtonRef}
          aria-expanded={open === "model"}
          className={"sl-chip" + (open === "model" ? " active" : "") + (modelBlocked ? " blocked" : "")}
          title={modelBlocked ? blockedNote || "이 모델은 이 그룹에서 쓸 수 없습니다" : undefined}
          onClick={() => setOpen(open === "model" ? null : "model")}
        >
          <span className="sl-dot" />
          <span className="sl-chip-label">{modelChipLabel(modelName, model, optionValues)}</span>
          <span className="sl-caret">›</span>
        </button>
        {open === "model" && (
          <div className="sl-dropdown">
            <div className="sl-dd-title">{type === "video" ? "Video" : type === "audio" ? "Audio" : "Image"} Model</div>
            {modelBlocked ? (
              <div className="sl-dd-note">{blockedNote || "지금 고른 모델은 이 그룹에서 쓸 수 없습니다. 다른 모델을 고르세요."}</div>
            ) : null}
            {typeFullyBlocked ? (
              <div className="sl-dd-empty">이 그룹에서 쓸 수 있는 {type === "video" ? "영상" : type === "audio" ? "오디오" : "이미지"} 모델이 없습니다.</div>
            ) : null}
            {policyNote ? <div className="sl-dd-empty">{policyNote}</div> : null}
            <div className="sl-dd-scroll">
              {modelRows(typeModels, { model, optionValues }).map((row) => (
                <button
                  key={row.key}
                  aria-label={row.display_name}
                  disabled={!!audioModelBlocked(row.model)}
                  title={audioModelBlocked(row.model) ?? undefined}
                  className={
                    "sl-dd-item" +
                    (row.model === model &&
                    (row.value === undefined || currentVariantValue(model, optionValues) === row.value)
                      ? " sel"
                      : "")
                  }
                  onClick={() => {
                    // 다른 모델 → 옵션까지 예약해 함께 전환(params 로드 뒤 기본값 위에 덮인다).
                    // 같은 모델의 변형 전환 → 그 값만 바꾼다(해상도·길이 등 나머지 선택을 보존).
                    if (row.model !== model) onPickModel(row.model, row.value ? { [row.param!]: row.value } : {});
                    else {
                      setModel(row.model); // 같은 모델 재선택 — '사용자가 골랐다' 는 출처를 남긴다(종전 동작)
                      if (row.value) setOpt(row.param!, row.value);
                    }
                    setOpen(null);
                  }}
                >
                  <span>{row.display_name}</span>
                  {row.description && <small className="sl-model-description">{audioModelBlocked(row.model) || row.description}</small>}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>)}

      {(isTtsModel(model) || model === "voice_change") && row("voice", "Voice", <VoiceIcon />, <>
        <VoicePicker
          voices={voices}
          voicesError={voicesError}
          value={String(optionValues.voice_id ?? "")}
          onPick={(id) => setOptionValues((previous) => ({ ...previous, voice_id: id, voice_type: "preset" }))}
          open={open}
          setOpen={setOpen}
          recommended={recommendedVoiceIds(model)}
        />
        {/* seed_audio 는 목소리 없이 참고 자료로도 만든다 — 고른 목소리를 풀 수 있게 */}
        {model === "seed_audio" && optionValues.voice_id && <button className="sl-chip" onClick={() => setOptionValues((previous) => {
          const next = { ...previous }; delete next.voice_id; delete next.voice_type; return next;
        })}>Voice 해제</button>}
      </>)}
      {model === "dubbing" && row("language", "Language", <SpotlightOptionIcon name="language" />,
        <LanguagePicker
          value={String(optionValues.target_language ?? "")}
          onPick={(code) => setOptionValues((previous) => ({ ...previous, target_language: code }))}
          open={open}
          setOpen={setOpen}
        />)}
      {visibleTunable.filter((p) => SPOTLIGHT_PRIMARY_PARAMS.has(p.name)).map((p) => {
        // 이 모드에서 CLI 가 무시하는 값 — 흐리게 두는 데서 그치지 않고 **조작도 막는다**
        // (2026-09-15 Jay: 만질 수 있으면 효과가 있는 줄 알게 되어 헷갈린다).
        // 값 자체와 전송은 종전대로 — 모드를 되돌리면 고르던 값이 그대로 살아 있다.
        const isIgnored = ignored.params.includes(p.name);
        const ignoredClass = isIgnored ? " sl-opt-ignored" : "";
        const rowLabel = OPTION_TITLES[p.name] ?? advancedLabel(p.name);
        if (/duration|length/i.test(p.name)) {
          // 칩에는 값만, 누르면 위에 슬라이더 창(Jay 2026-10-28) — 정해진 길이 목록이면 그 값들만. 줄 배치면 막대를 줄에 바로 둔다.
          if (p.enum?.length) {
            const vals = p.enum;
            const stops = vals.map(Number);
            const cur = String(optionValues[p.name] ?? p.default ?? vals[0]);
            return row(p.name, "Duration", <SpotlightOptionIcon name="duration" />,
              <SpotlightDurationChip key={p.name} value={Number(cur)} min={stops[0]} max={stops[stops.length - 1]} stops={stops} inline={rows}
                open={open === p.name} onToggle={() => setOpen(open === p.name ? null : p.name)}
                onChange={(v) => setOptionValues((prev) => ({ ...prev, [p.name]: vals[stops.indexOf(v)] }))} ignored={isIgnored} title={p.name} />);
          }
          const def = Number(p.default) || 5;
          const { min: dmin, max: dmax } = durationRange(model, def);
          const raw = Number(optionValues[p.name] ?? def) || def;
          const cur = Math.min(dmax, Math.max(dmin, raw));
          return row(p.name, "Duration", <SpotlightOptionIcon name="duration" />,
            <SpotlightDurationChip key={p.name} value={cur} min={dmin} max={dmax} inline={rows}
              open={open === p.name} onToggle={() => setOpen(open === p.name ? null : p.name)}
              onChange={(v) => setOptionValues((prev) => ({ ...prev, [p.name]: v }))}
              ignored={isIgnored} title={`${p.name} (${dmin}~${dmax}s)`} />);
        }
        if (rows && p.enum?.length) {
          // 줄 배치 — 목록 대신 값을 한 캡슐에 다 펼친다. 합성 'auto'·막힌 값·Draft 표시·무시되는 값 규칙은 목록과 같다.
          const values = p.name === "aspect_ratio" && !p.enum.includes("auto") ? ["auto", ...p.enum] : p.enum;
          const con = constraints[p.name];
          const cur = String(optionValues[p.name] ?? p.default ?? "");
          return row(p.name, rowLabel, <SpotlightOptionIcon name={p.name} />, <>
            <div className={"sl-row-cap" + ignoredClass} style={capCols(values.length)} role="group" aria-label={rowLabel}>
              {values.map((v) => {
                const blocked = !!con && !con.allow.has(v);
                return (
                  <button key={v} type="button" className={"sl-adv-opt" + (cur === v ? " sel" : "") + (blocked ? " blocked" : "")}
                    aria-pressed={cur === v} disabled={isIgnored || blocked} title={blocked ? con!.note : undefined}
                    onClick={() => setOpt(p.name, v)}>
                    {v}
                    {isDraftResolution(p.name, v) && <span className="sl-draft-pill">Draft</span>}
                  </button>
                );
              })}
            </div>
            {con && <div className="sl-row-note">{con.note}</div>}
          </>);
        }
        return p.enum?.length ? (
          <div className="sl-chip-wrap" key={p.name}>
            <button
              className={"sl-chip sl-opt-chip" + ignoredClass + (open === p.name ? " active" : "")}
              disabled={isIgnored}
              onClick={() => setOpen(open === p.name ? null : p.name)}
              title={p.name}
            >
              <span className="sl-opt-ic"><SpotlightOptionIcon name={p.name} /></span>
              {/* 값 칸 = 이 칩의 가장 긴 값만큼(합성 'auto' 포함) — 값을 바꿔도 칩 폭이 그대로(Jay 2026-10-28) */}
              <span className="sl-opt-text" style={{ minWidth: `${Math.max(p.name === "aspect_ratio" ? 4 : 0, ...p.enum.map((v) => String(v).length)) + 0.5}ch` }}>
                {String(optionValues[p.name] ?? p.default ?? "")}
              </span>
              {isDraftResolution(p.name, optionValues[p.name] ?? p.default) && <span className="sl-draft-pill">Draft</span>}
              <span className="sl-caret">›</span>
            </button>
            {/* 잠긴 값은 목록이 이미 열려 있어도 닫는다 — 비동기 복원(프롬프트 재사용)이 메뉴가 열린
                채로 모드를 바꿔 넣을 수 있고, 그때 열린 목록으로 고르면 잠금이 뚫린다. */}
            {open === p.name && !isIgnored && (
              <div className="sl-dropdown">
                {OPTION_TITLES[p.name] && <div className="sl-dd-title">{OPTION_TITLES[p.name]}</div>}
                <div className="sl-dd-scroll">
                  {/* aspect_ratio 는 CLI 에 auto 가 없어도 맨 앞에 'auto' 를 합성한다(제출 시 레퍼런스 비율로 치환).
                      CLI 가 이미 auto 를 주는 모델은 중복 추가하지 않는다. */}
                  {(p.name === "aspect_ratio" && !p.enum.includes("auto")
                    ? ["auto", ...p.enum]
                    : p.enum
                  ).map((v) => {
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
                        {isDraftResolution(p.name, v) && <span className="sl-draft-pill">Draft</span>}
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
        ) : p.type === "integer" ? row(p.name, rowLabel, <SpotlightOptionIcon name={p.name} />,
          <label className={"sl-chip sl-opt-num" + ignoredClass} key={p.name} title={p.name}>
            <span className="sl-opt-ic"><SpotlightOptionIcon name={p.name} /></span>
            <input
              type="number"
              value={String(optionValues[p.name] ?? p.default ?? "")}
              onChange={(e) => {
                const next = e.target.value === "" ? "" : Number(e.target.value);
                if (inexactInteger(next)) return;
                setOptionValues((prev) => ({ ...prev, [p.name]: next }));
              }}
            />
          </label>
        ) : null;
      })}

      {audioParam && (() => {
        const on = optionValues.generate_audio === true || String(optionValues.generate_audio).toLowerCase() === "true";
        const opts = (
          <div className={rows ? "sl-row-cap" : "sl-adv-opts"} style={rows ? capCols(2) : undefined}>
            <button className={"sl-adv-opt" + (on ? " sel" : "")} title="오디오 켜기"
              onClick={() => setOptionValues((prev) => ({ ...prev, generate_audio: true }))}>ON</button>
            <button className={"sl-adv-opt" + (on ? "" : " sel")} title="오디오 끄기"
              onClick={() => setOptionValues((prev) => ({ ...prev, generate_audio: false }))}>OFF</button>
          </div>
        );
        return rows ? row("generate_audio", "Sound", <SpotlightOptionIcon name="generate_audio" />, opts) : (
          <div className="sl-chip sl-opt-audio" title="오디오 생성 (켜기/끄기)">
            <span className="sl-opt-ic"><SpotlightOptionIcon name="generate_audio" /></span>
            {opts}
          </div>
        );
      })()}

      {advancedParams.length > 0 && row("advanced", "Advanced", <AdvancedIcon />,
        <div className="sl-chip-wrap">
          <button
            className={
              "sl-chip sl-opt-chip" +
              (open === "advanced" ? " active" : "") +
              (advancedDirty ? " dirty" : "")
            }
            onClick={() => setOpen(open === "advanced" ? null : "advanced")}
            title="고급 옵션 (모드·비트레이트·장르 등)"
          >
            <span className="sl-opt-ic"><AdvancedIcon /></span>
            {/* 줄 배치면 'Set' 대신 안에 든 옵션 이름(Mode · Bitrate …) */}
            {rows ? <span className="sl-chip-label">{advancedParams.map((p) => advancedLabel(p.name)).join(" · ")}</span> : <span>Set</span>}
            {advancedDirty && <span className="sl-adv-dot" aria-hidden />}
            <span className="sl-caret">›</span>
          </button>
          {open === "advanced" && (
            <div className="sl-dropdown sl-adv-pop">
              <div className="sl-dd-title">Advanced Options</div>
              {advancedParams.map((p) => {
                const cur = optionValues[p.name] ?? effectiveDefault(p, model) ?? "";
                return (
                  <div className="sl-adv-row" key={p.name}>
                    <div className="sl-adv-label">
                      <span className="sl-adv-name">
                        <span className="sl-opt-ic"><SpotlightOptionIcon name={p.name} /></span>
                        {advancedLabel(p.name)}
                        {["stability", "similarity_boost"].includes(p.name) && " (%)"}
                      </span>
                      <AdvancedHelp name={p.name} values={p.enum} />
                    </div>
                    {p.enum?.length ? (
                      <div className="sl-adv-opts">
                        {isTtsModel(model) && p.name !== "language" && p.default == null && <button
                          className={"sl-adv-opt" + (cur === "" ? " sel" : "")}
                          onClick={() => setOptionValues((prev) => { const next = { ...prev }; delete next[p.name]; return next; })}
                        >Default</button>}
                        {(isTtsModel(model) && p.name === "language" ? ["", ...p.enum] : p.enum).map((v) => {
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
                              // setOpt 는 고른 뒤 창을 닫는다 — Set 창은 Esc·바깥 누름으로만 닫히게 값만 바꾼다(Jay 2026-10-28)
                              onClick={() => !blocked && (v === "" ? setOptionValues((prev) => { const next = { ...prev }; delete next[p.name]; return next; })
                                : setOptionValues((prev) => ({ ...prev, [p.name]: isTtsModel(model) && ["integer", "number"].includes(p.type.split("|")[0]) ? Number(v) : v })))}
                              title={blocked ? con!.note : undefined}
                            >
                              {advancedValue(v, p.name)}
                            </button>
                          );
                        })}
                      </div>
                    ) : p.type === "boolean" || typeof p.default === "boolean" ? (
                      (() => {
                        const on = cur === true || String(cur).toLowerCase() === "true";
                        return (
                          <div className="sl-adv-opts">
                            <button
                              className={"sl-adv-opt" + (on ? " sel" : "")}
                              onClick={() => setOptionValues((prev) => ({ ...prev, [p.name]: true }))}
                            >
                              ON
                            </button>
                            <button
                              className={"sl-adv-opt" + (!on ? " sel" : "")}
                              onClick={() => setOptionValues((prev) => ({ ...prev, [p.name]: false }))}
                            >
                              OFF
                            </button>
                          </div>
                        );
                      })()
                    ) : ["integer", "number"].includes(p.type.replace(/\|null$/, "")) ? (
                      (() => {
                        const percent = ["stability", "similarity_boost"].includes(p.name); // 값은 0~1, 막대는 0~100
                        const rg = percent ? { min: 0, max: 100 } : numericRange(model, p.name);
                        const integer = p.type.split("|")[0] === "integer";
                        const value = optionValues[p.name] ?? p.default;
                        const reset = () => setOptionValues((prev) => {
                          const next = { ...prev };
                          if (isTtsModel(model)) delete next[p.name];
                          else next[p.name] = (effectiveDefault(p, model) ?? "") as OptionValue;
                          return next;
                        });
                        const scaled = (v: unknown) => (v == null || v === "" ? null : Number(v) * (percent ? 100 : 1));
                        if (rg) return (
                          <AdvancedRange
                            label={spotlightParamLabel(p.name) + (percent ? " (%)" : "")}
                            value={scaled(optionValues[p.name])}
                            base={scaled(p.default)}
                            min={rg.min}
                            max={rg.max}
                            step={percent || integer ? 1 : 0.05}
                            onChange={(v) => setOptionValues((prev) => ({ ...prev, [p.name]: percent ? v / 100 : v }))}
                            onReset={reset}
                          />
                        );
                        // 범위를 모르는 숫자(Qwen seed 등)는 입력 칸 그대로
                        return (
                          <input
                            className="sl-adv-num"
                            type="number"
                            aria-label={spotlightParamLabel(p.name)}
                            placeholder="Default"
                            step={integer ? 1 : "any"}
                            value={value == null || value === "" ? "" : String(value)}
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw === "" && isTtsModel(model)) { reset(); return; }
                              const next = raw === "" ? "" : Number(raw);
                              if (integer ? inexactInteger(next) : typeof next === "number" && !Number.isFinite(next)) return;
                              setOptionValues((prev) => ({ ...prev, [p.name]: next }));
                            }}
                          />
                        );
                      })()
                    ) : (
                      <input
                        className="sl-adv-num"
                        type="text"
                        aria-label={spotlightParamLabel(p.name)}
                        placeholder={isTtsModel(model) ? "Default" : undefined}
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
        </div>)}
      {ignored.note && (
        <div className="sl-ignored-note">
          {ignored.note}{ignored.billingNote && <> <strong>{ignored.billingNote}</strong></>}
        </div>
      )}
    </>
  );
}
