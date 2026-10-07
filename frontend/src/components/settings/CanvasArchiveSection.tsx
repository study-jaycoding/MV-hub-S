import { useEffect, useRef, useState } from "react";
import { downloadSceneArchive, importSceneArchiveText } from "../../lib/sceneArchive";
import { sceneStoreReady } from "../../lib/sceneStore";
import { isSceneSaveFailing, subscribeSceneSaveState } from "../../lib/scenes";
import { SettingsDescription } from "./SettingsDescription";

// 캔버스 전체를 파일 하나로 내려받고, 그 파일에서 다시 가져온다(백업·PC 옮기기·저장소가 막혔을 때 건지기).
// 씬 하나를 주고받는 캔버스의 [저장]/[불러오기]와 다르다 — 이쪽은 계정·씬 id 를 그대로 싣고, 가져올 때 합친다.
export function CanvasArchiveSection() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [failing, setFailing] = useState(isSceneSaveFailing);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => subscribeSceneSaveState(setFailing), []);

  // 분리 창(Assets·관리)은 캔버스 저장소를 열지 않는다 — 거기서는 내보낼 것이 없다.
  if (!sceneStoreReady()) return null;

  const run = async (work: () => Promise<string>) => {
    setBusy(true);
    try {
      setMsg(await work());
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "실패했습니다.");
    } finally {
      setBusy(false);
    }
  };
  const exportAll = () =>
    run(async () => `캔버스 ${await downloadSceneArchive()}개를 파일로 내려받았습니다.`);
  const importAll = (file: File) =>
    run(async () => {
      const { added, recovered } = await importSceneArchiveText(await file.text());
      if (!added && !recovered) return "파일의 캔버스가 이미 모두 있습니다 — 더한 것이 없습니다.";
      return (
        `캔버스 ${added}개를 가져왔습니다` +
        (recovered ? ` · 내용이 다른 ${recovered}개는 '[사본]' 탭으로 따로 두었습니다.` : ".")
      );
    });

  return (
    <section className="settings-section">
      <h4>캔버스 자료</h4>
      <div className="settings-row">
        <button className="settings-action" onClick={exportAll} disabled={busy}>
          ⤓ 전체 내보내기
        </button>
        <button className="settings-action" onClick={() => fileRef.current?.click()} disabled={busy}>
          ⤒ 전체 가져오기
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importAll(file);
          event.target.value = ""; // 같은 파일을 다시 고를 수 있게 초기화
        }}
      />
      {/* 실시간 정보(저장 실패·방금 한 일의 결과)는 접기 밖 한 줄에 둔다(Jay 규칙). */}
      <SettingsDescription
        summary={
          msg ||
          (failing
            ? "⚠ 지금 캔버스가 저장되지 않고 있습니다 — 내보내 두세요."
            : "이 PC 의 모든 캔버스를 파일 하나로 내려받거나, 그 파일에서 다시 가져옵니다.")
        }
      >
        <p>내보낸 파일에는 아직 저장되지 않은 편집까지 들어갑니다. 그림·영상 파일은 들어가지 않습니다(참조만).</p>
        <p>
          가져오기는 지금 캔버스를 덮지 않습니다 — 없는 캔버스만 더하고, 같은 캔버스인데 내용이 다르면
          &apos;[사본] 이름&apos; 탭으로 따로 둡니다.
        </p>
      </SettingsDescription>
    </section>
  );
}
