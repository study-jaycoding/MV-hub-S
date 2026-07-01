import type { Dispatch, SetStateAction } from "react";
import type { MediaType, ModelInfo, ModelParam } from "../../types";
import { effectiveDefault, numericRange } from "../../lib/useModels";
import {
  SPOTLIGHT_PRIMARY_PARAMS,
  durationRange,
  spotlightAdvancedParamRank,
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
  modelName: string;
  typeModels: ModelInfo[];
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
  modelName,
  typeModels,
  tunable,
  constraints,
  optionValues,
  setOptionValues,
  setOpt,
  open,
  setOpen,
}: Props) {
  const audioParam = tunable.find((p) => p.name === "generate_audio");
  const advancedParams = tunable
    .filter((p) => !SPOTLIGHT_PRIMARY_PARAMS.has(p.name) && p.name !== "generate_audio")
    .sort((a, b) => spotlightAdvancedParamRank(a.name) - spotlightAdvancedParamRank(b.name));
  const advancedDirty = advancedParams.some((p) => {
    const cur = optionValues[p.name];
    return cur != null && cur !== "" && String(cur) !== String(effectiveDefault(p) ?? "");
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

      {tunable.filter((p) => SPOTLIGHT_PRIMARY_PARAMS.has(p.name)).map((p) => {
        if (/duration|length/i.test(p.name)) {
          if (p.enum?.length) {
            const vals = p.enum;
            const cur = String(optionValues[p.name] ?? p.default ?? vals[0]);
            const idx = Math.max(0, vals.indexOf(cur));
            return (
              <div className="sl-chip sl-opt-slider" key={p.name} title={p.name}>
                <span className="sl-opt-ic"><SpotlightOptionIcon name={p.name} /></span>
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
          const { min: dmin, max: dmax } = durationRange(model, def);
          const raw = Number(optionValues[p.name] ?? def) || def;
          const cur = Math.min(dmax, Math.max(dmin, raw));
          return (
            <div className="sl-chip sl-opt-slider" key={p.name} title={`${p.name} (${dmin}~${dmax}s)`}>
              <span className="sl-opt-ic"><SpotlightOptionIcon name={p.name} /></span>
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
              <span className="sl-opt-ic"><SpotlightOptionIcon name={p.name} /></span>
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
                const cur = optionValues[p.name] ?? p.default ?? (p.enum ? p.enum[0] : "");
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
    </>
  );
}
