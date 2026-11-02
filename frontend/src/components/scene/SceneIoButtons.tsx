// 씬 단추 묶음 — 보관·불러오기 | Import·Export | 레퍼런스 찾기. 탭 휠 클릭 패널(SceneBoard)과 탭 설명 창(SceneBar)이 같이 쓴다(Jay 2026-11-02).
//  칸 안의 단추는 폭이 같고 칸 사이는 세로선으로 가른다. 동작은 부르는 쪽이 정한다.
import { Fragment } from "react";

export type SceneIoAction = "keep" | "keeps" | "import" | "export" | "find";

const GROUPS: SceneIoAction[][] = [["keep", "keeps"], ["import", "export"], ["find"]];
const LABELS: Record<SceneIoAction, string> = { keep: "보관", keeps: "불러오기", import: "Import", export: "Export", find: "레퍼런스 찾기" };
const TITLES: Partial<Record<SceneIoAction, string>> = {
  import: "씬 파일을 새 탭으로 가져오기",
  export: "이 씬을 파일로 내보내기",
  find: "이 씬의 레퍼런스를 NAS 에서 다시 찾아 원본으로 잇습니다(렌더 폴더 포함). NAS 에 나중에 올린 파일도 이걸로 찾습니다",
};

export function SceneIoButtons({
  actions,
  run,
  finding,
}: {
  actions: SceneIoAction[];
  run: (action: SceneIoAction) => void;
  finding?: { count: number } | null; // '레퍼런스 찾기' 도는 중 — 그 단추가 '대기 중단'이 된다
}) {
  const groups = GROUPS.map((group) => group.filter((action) => actions.includes(action))).filter((group) => group.length);
  return (
    <div className="scene-io-btns">
      {groups.map((group, index) => (
        <Fragment key={group[0]}>
          {index > 0 && <span className="scene-io-sep" aria-hidden="true" />}
          <div className="scene-io-col">
            {group.map((action) => {
              const stopping = action === "find" && finding;
              return (
                <button
                  key={action}
                  className="scene-io-btn"
                  title={stopping ? "기다리기만 멈춥니다 — 서버는 하던 확인을 끝까지 합니다" : TITLES[action]}
                  onClick={() => run(action)}
                >
                  {stopping ? `◌ 레퍼런스 ${finding.count}개 찾는 중 · 대기 중단` : LABELS[action]}
                </button>
              );
            })}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
