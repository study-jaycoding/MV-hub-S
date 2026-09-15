import type { Dispatch, SetStateAction } from "react";
import type { MediaType, ModelInfo, ModelParam } from "../../types";
import { effectiveDefault, numericRange, paramGateAllows } from "../../lib/useModels";
import {
  SPOTLIGHT_PRIMARY_PARAMS,
  currentVariantValue,
  durationRange,
  isVariantParam,
  modelRows,
  modelVariantSuffix,
  spotlightAdvancedParamRank,
  spotlightIgnoredOptions,
  spotlightParamLabel,
  spotlightValueLabel,
} from "../../lib/spotlightPromptConfig";
import { SpotlightOptionIcon } from "./SpotlightOptionIcon";

type OptionValue = string | number | boolean;
type OptionValues = Record<string, OptionValue>;
type ConstraintMap = Record<string, { allow: Set<string>; note: string }>;

interface Props {
  type: MediaType;
  setType: (value: MediaType) => void;
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

export function SpotlightOptionsBar({
  type,
  setType,
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
}: Props) {
  // 조건부 게이트 — 현재 옵션 조합에서 허용 안 되는 파라미터는 표시하지 않는다
  // (예: extension_mode 는 mode=video_extension 일 때만 — 다른 모드에 실으면 CLI 거부).
  const visibleTunable = tunable.filter((p) => paramGateAllows(model, p.name, optionValues));
  const ignored = spotlightIgnoredOptions(model, optionValues.mode);
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
          className={"sl-chip" + (open === "model" ? " active" : "") + (modelBlocked ? " blocked" : "")}
          title={modelBlocked ? blockedNote || "이 모델은 이 그룹에서 쓸 수 없습니다" : undefined}
          onClick={() => setOpen(open === "model" ? null : "model")}
        >
          <span className="sl-dot" />
          <span className="sl-chip-label">{modelName + modelVariantSuffix(model, optionValues)}</span>
          <span className="sl-caret">›</span>
        </button>
        {open === "model" && (
          <div className="sl-dropdown">
            <div className="sl-dd-title">{type === "video" ? "영상" : "이미지"} 모델</div>
            {modelBlocked ? (
              <div className="sl-dd-note">{blockedNote || "지금 고른 모델은 이 그룹에서 쓸 수 없습니다. 다른 모델을 고르세요."}</div>
            ) : null}
            {typeFullyBlocked ? (
              <div className="sl-dd-empty">이 그룹에서 쓸 수 있는 {type === "video" ? "영상" : "이미지"} 모델이 없습니다.</div>
            ) : null}
            {policyNote ? <div className="sl-dd-empty">{policyNote}</div> : null}
            <div className="sl-dd-scroll">
              {modelRows(typeModels).map((row) => (
                <button
                  key={row.key}
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
                  {row.display_name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {visibleTunable.filter((p) => SPOTLIGHT_PRIMARY_PARAMS.has(p.name)).map((p) => {
        // 이 모드에서 CLI 가 무시하는 값 — 흐리게 두는 데서 그치지 않고 **조작도 막는다**
        // (2026-09-15 Jay: 만질 수 있으면 효과가 있는 줄 알게 되어 헷갈린다).
        // 값 자체와 전송은 종전대로 — 모드를 되돌리면 고르던 값이 그대로 살아 있다.
        const isIgnored = ignored.params.includes(p.name);
        const ignoredClass = isIgnored ? " sl-opt-ignored" : "";
        if (/duration|length/i.test(p.name)) {
          if (p.enum?.length) {
            const vals = p.enum;
            const cur = String(optionValues[p.name] ?? p.default ?? vals[0]);
            const idx = Math.max(0, vals.indexOf(cur));
            return (
              <div className={"sl-chip sl-opt-slider" + ignoredClass} key={p.name} title={p.name}>
                <span className="sl-opt-ic"><SpotlightOptionIcon name={p.name} /></span>
                <input
                  type="range"
                  min={0}
                  max={vals.length - 1}
                  step={1}
                  value={idx}
                  disabled={isIgnored}
                  onChange={(e) => setOpt(p.name, vals[Number(e.target.value)])}
                />
                <span className="sl-opt-val">{cur}s</span>
              </div>
            );
          }
          const def = Number(p.default) || 5;
          const { min: dmin, max: dmax } = durationRange(model, def);
          const raw = Number(optionValues[p.name] ?? def) || def;
          const cur = Math.min(dmax, Math.max(dmin, raw));
          return (
            <div className={"sl-chip sl-opt-slider" + ignoredClass} key={p.name} title={`${p.name} (${dmin}~${dmax}s)`}>
              <span className="sl-opt-ic"><SpotlightOptionIcon name={p.name} /></span>
              <input
                type="range"
                min={dmin}
                max={dmax}
                step={1}
                value={cur}
                disabled={isIgnored}
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
              className={"sl-chip sl-opt-chip" + ignoredClass + (open === p.name ? " active" : "")}
              disabled={isIgnored}
              onClick={() => setOpen(open === p.name ? null : p.name)}
              title={p.name}
            >
              <span className="sl-opt-ic"><SpotlightOptionIcon name={p.name} /></span>
              <span>{String(optionValues[p.name] ?? p.default ?? "")}</span>
              <span className="sl-caret">›</span>
            </button>
            {/* 잠긴 값은 목록이 이미 열려 있어도 닫는다 — 비동기 복원(프롬프트 재사용)이 메뉴가 열린
                채로 모드를 바꿔 넣을 수 있고, 그때 열린 목록으로 고르면 잠금이 뚫린다. */}
            {open === p.name && !isIgnored && (
              <div className="sl-dropdown">
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
          <label className={"sl-chip sl-opt-num" + ignoredClass} key={p.name} title={p.name}>
            <span className="sl-opt-ic"><SpotlightOptionIcon name={p.name} /></span>
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

      {audioParam && (
        <div className="sl-chip sl-opt-audio" title="오디오 생성 (켜기/끄기)">
          <span className="sl-opt-ic"><SpotlightOptionIcon name="generate_audio" /></span>
          <div className="sl-adv-opts">
            <button
              className={
                "sl-adv-opt" +
                (
                  optionValues.generate_audio === true ||
                  String(optionValues.generate_audio).toLowerCase() === "true"
                    ? " sel"
                    : ""
                )
              }
              onClick={() => setOptionValues((prev) => ({ ...prev, generate_audio: true }))}
              title="오디오 켜기"
            >
              ON
            </button>
            <button
              className={
                "sl-adv-opt" +
                (
                  optionValues.generate_audio === true ||
                  String(optionValues.generate_audio).toLowerCase() === "true"
                    ? ""
                    : " sel"
                )
              }
              onClick={() => setOptionValues((prev) => ({ ...prev, generate_audio: false }))}
              title="오디오 끄기"
            >
              OFF
            </button>
          </div>
        </div>
      )}

      {advancedParams.length > 0 && (
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
            <span>고급</span>
            {advancedDirty && <span className="sl-adv-dot" aria-hidden />}
            <span className="sl-caret">›</span>
          </button>
          {open === "advanced" && (
            <div className="sl-dropdown sl-adv-pop">
              <div className="sl-dd-title">고급 옵션</div>
              {advancedParams.map((p) => {
                const cur = optionValues[p.name] ?? effectiveDefault(p, model) ?? "";
                return (
                  <div className="sl-adv-row" key={p.name}>
                    <div className="sl-adv-label">
                      <span className="sl-opt-ic"><SpotlightOptionIcon name={p.name} /></span>
                      {spotlightParamLabel(p.name)}
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
                              title={blocked ? con!.note : spotlightValueLabel(v)}
                            >
                              {spotlightValueLabel(v)}
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
                              title="켜기"
                            >
                              ON
                            </button>
                            <button
                              className={"sl-adv-opt" + (!on ? " sel" : "")}
                              onClick={() => setOptionValues((prev) => ({ ...prev, [p.name]: false }))}
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
      )}
      {ignored.note && (
        <div className="sl-ignored-note">
          {ignored.note}{ignored.billingNote && <> <strong>{ignored.billingNote}</strong></>}
        </div>
      )}
    </>
  );
}
