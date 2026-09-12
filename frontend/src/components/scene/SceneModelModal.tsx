// 모델 노드 더블클릭 시 뜨는 모달 — 하단 프롬프트의 모델 선택 UI(SpotlightOptionsBar)를 그대로
// 재사용해, 그 노드에 쓸 모델/옵션을 고른다. useModels 를 이 모달 안에서 독립 인스턴스로 돌려
// SpotlightPrompt 상태와 섞이지 않게 한다(코덱스 설계 A안). 저장하면 modelCfg 스냅샷을 콜백.
import { useEffect, useState } from "react";
import { policyNote, submitBlockMessage } from "../../lib/modelPolicyCore";
import { useModelPolicy } from "../../lib/modelPolicy";
import { inferModelType, stripHiddenParams, useModels } from "../../lib/useModels";
import { SpotlightOptionsBar } from "../spotlight/SpotlightOptionsBar";
import type { SceneModelCfg } from "../../lib/scenes";

export function SceneModelModal({
  initial,
  onSave,
  onClose,
}: {
  initial?: SceneModelCfg;
  onSave: (cfg: SceneModelCfg) => void;
  onClose: () => void;
}) {
  // 그룹 사용 모델 — 목록에서 빼고, 저장돼 있던 모델을 못 쓰면 안내 뒤 새 모델을 고른 뒤에만 저장(자동 교체 금지).
  const policy = useModelPolicy();
  const m = useModels(() => {}, { allowed: policy.allowed, ready: policy.status !== "loading" }); // 로드 실패는 조용히(모달이라 별도 토스트 불필요)
  const blockedNote = m.selectedBlocked ? submitBlockMessage(policy, m.model, m.modelName) : null;
  const [open, setOpen] = useState<string | null>(null);

  // 드롭다운 닫기 브리지 — setOpt 선택 후 useModels 가 setOpen(null) 을 호출하게 등록.
  useEffect(() => {
    m.setOpenRef.current = setOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 저장된 설정 복원(mount 1회) — type/model 지정 + pendingOptsRef 로 params 로드 후 옵션 덮기.
  // ★타입은 **모델 키를 먼저** 믿는다(2026-09-13). 저장된 `type` 이 없거나(레시피가 안 넣는다)
  //  틀리면(`type:"image"` + 영상 모델) 훅의 기본 타입이 남고, 자동 선택이 그 모델을
  //  **첫 이미지 모델로 갈아치운다** — 코덱스가 실제 화면에서 재현했다
  //  (영상 레시피의 seedance_2_0_mini 가 Image/Nano Banana 2 로 열림).
  // ★`setType` 과 `setModel` 은 **같은 동기 구간**에서 부른다. 타입만 먼저 바꾸고 모델을
  //  다른 effect 로 미루면 그 사이에 자동 선택이 끼어든다.
  // ★고치는 것은 **이 복원 지점뿐**이다. 공용 자동 선택 effect 를 건드리면 사용자가
  //  탭을 눌러 타입을 바꾸는 것까지 되돌아간다(코덱스 반례).
  useEffect(() => {
    const savedType =
      initial?.type === "image" || initial?.type === "video" ? initial.type : undefined;
    const restoredType = inferModelType(initial?.model) ?? savedType;
    if (restoredType) m.setType(restoredType);
    if (initial?.model) {
      // 저장분에 숨김 파라미터(is_inpaint 등)가 있어도 body 로 되살아나지 않게 필터(코덱스)
      m.pendingOptsRef.current = { model: initial.model, opts: stripHiddenParams(initial.params ?? {}) };
      m.setModel(initial.model);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 저장해도 되는 상태인가 — 버튼의 `disabled` 와 `save()` **둘 다** 이걸 본다(코덱스 조건).
  //  종전엔 버튼에만 있어, 다른 경로로 눌리면 그대로 저장됐다.
  const canSave =
    !!m.model && !m.selectedBlocked && !m.paramsLoading && !m.paramsError && m.paramsModel === m.model;

  const save = () => {
    // ★이중 방어다 — 지금은 이 버튼 말고 `save` 를 부르는 곳이 없어 **관측되지 않는다**.
    //  (React 가 `disabled` 를 fiber props 로 보므로 시험에서도 이 줄에 못 닿는다.)
    //  나중에 단축키·다른 버튼이 붙었을 때 빈 옵션이 덮이는 것을 막는다(코덱스 조건).
    if (!canSave) return;
    onSave({ type: m.type, model: m.model, modelName: m.modelName, params: m.optionValues });
    onClose();
  };

  return (
    <div className="scene-modelmodal-backdrop" onMouseDown={onClose}>
      <div className="scene-modelmodal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="scene-modelmodal-hd">
          <span>모델 설정</span>
          <button className="scene-modelmodal-x" onClick={onClose} title="닫기">
            ✕
          </button>
        </div>
        <div className="scene-modelmodal-body">
          {blockedNote ? <div className="scene-modelmodal-note">{blockedNote}</div> : null}
          {m.paramsError ? (
            <div className="scene-modelmodal-note">
              모델 설정을 불러오지 못했습니다. 저장하면 기존 옵션이 지워지므로 저장을 막았습니다 —
              취소하고 다시 열거나 다른 모델을 골라 주세요.
            </div>
          ) : null}
          {!blockedNote && policyNote(policy) ? (
            <div className="scene-modelmodal-note muted">{policyNote(policy)}</div>
          ) : null}
          {/* 하단 프롬프트와 동일 레이아웃(.sl-left flex/gap/wrap)으로 감싸 칩이 가로로 흐르게 한다. */}
          <div className="sl-left">
            <SpotlightOptionsBar
              type={m.type}
              setType={m.setType}
              model={m.model}
              setModel={m.setModel}
              modelName={m.modelName}
              typeModels={m.typeModels}
              modelBlocked={m.selectedBlocked}
              blockedNote={blockedNote}
              typeFullyBlocked={m.typeFullyBlocked}
              policyNote={policyNote(policy)}
              tunable={m.tunable}
              constraints={m.constraints}
              optionValues={m.optionValues}
              setOptionValues={m.setOptionValues}
              setOpt={m.setOpt}
              open={open}
              setOpen={setOpen}
            />
          </div>
        </div>
        <div className="scene-modelmodal-ft">
          <button onClick={onClose}>취소</button>
          {/* 파라미터 로드/복원이 끝난(paramsModel===model) 뒤에만 저장 — 빠른 저장으로 기본값 전 상태가 덮이는 것 방지. */}
          <button
            className="primary"
            onClick={save}
            disabled={!canSave}
          >
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
