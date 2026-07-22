// 모델 노드 더블클릭 시 뜨는 모달 — 하단 프롬프트의 모델 선택 UI(SpotlightOptionsBar)를 그대로
// 재사용해, 그 노드에 쓸 모델/옵션을 고른다. useModels 를 이 모달 안에서 독립 인스턴스로 돌려
// SpotlightPrompt 상태와 섞이지 않게 한다(코덱스 설계 A안). 저장하면 modelCfg 스냅샷을 콜백.
import { useEffect, useState } from "react";
import { useModels } from "../../lib/useModels";
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
  const m = useModels(() => {}); // 로드 실패는 조용히(모달이라 별도 토스트 불필요)
  const [open, setOpen] = useState<string | null>(null);

  // 드롭다운 닫기 브리지 — setOpt 선택 후 useModels 가 setOpen(null) 을 호출하게 등록.
  useEffect(() => {
    m.setOpenRef.current = setOpen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 저장된 설정 복원(mount 1회) — type/model 지정 + pendingOptsRef 로 params 로드 후 옵션 덮기.
  useEffect(() => {
    if (initial?.type === "image" || initial?.type === "video") m.setType(initial.type);
    if (initial?.model) {
      m.pendingOptsRef.current = { model: initial.model, opts: initial.params ?? {} };
      m.setModel(initial.model);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = () => {
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
          {/* 하단 프롬프트와 동일 레이아웃(.sl-left flex/gap/wrap)으로 감싸 칩이 가로로 흐르게 한다. */}
          <div className="sl-left">
            <SpotlightOptionsBar
              type={m.type}
              setType={m.setType}
              model={m.model}
              setModel={m.setModel}
              modelName={m.modelName}
              typeModels={m.typeModels}
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
            disabled={!m.model || m.paramsLoading || m.paramsModel !== m.model}
          >
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
