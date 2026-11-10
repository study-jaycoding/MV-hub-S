// MV Agent 별도 창(`/?embed=agent`) — Assets 창과 같은 길(lib/popupWindows). 칸(AgentPanel)을 창 가득 띄운다.
//  '지금 화면'은 메인 창이 브라우저 저장소(STORAGE_KEYS.agentPanelScreen)에 적고 이 창이 storage 알림으로 따라 읽는다.
//  [옆 칸으로 붙이기] = 새 창 모드를 끄고 옆 칸을 연다고 적은 뒤 창을 닫는다 — 메인 창이 storage 알림으로 옆 칸을 연다(docs/status/MVAgent_서랍_새창_2026-11-10.md).
import { useEffect, useLayoutEffect, useState } from "react";
import type { PreviewTarget } from "../../types";
import { configureOperationContext, watchOperationContext } from "../../app/operationContext";
import type { AgentContext } from "../../lib/agentChatApi";
import { useCommentWriteContext } from "../../lib/commentTarget";
import { usePageSelectAllGuard } from "../../lib/keyGate";
import { loadJSON, saveString } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { MediaPreview } from "../MediaPreview";
import { PopupAuthPauseBanner } from "../app/AuthPauseBanner";
import { AgentPanel } from "./AgentPanel";

export interface AgentScreen {
  context: AgentContext;
  label: string;
  projects: Record<string, string>; // 프로젝트 id → 이름(서랍 묶음)
}

const EMPTY: AgentScreen = { context: { tab: "my" }, label: "", projects: {} };

function readScreen(): AgentScreen {
  const saved = loadJSON<Partial<AgentScreen>>(STORAGE_KEYS.agentPanelScreen);
  if (!saved || typeof saved !== "object" || !saved.context || typeof saved.context.tab !== "string") return EMPTY;
  return { context: saved.context, label: typeof saved.label === "string" ? saved.label : "", projects: saved.projects && typeof saved.projects === "object" ? saved.projects : {} };
}

export function AgentWindow() {
  usePageSelectAllGuard(); // 분리 창은 App 밖에서 뜬다 — 조합 중 Enter·입력칸 밖 Ctrl+A 지킴이(lib/keyGate)
  const [screen, setScreen] = useState(readScreen);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const writeContext = useCommentWriteContext(); // 크게 보기의 코멘트 저장 문맥 — Assets 창과 같다
  useLayoutEffect(() => {
    configureOperationContext({
      key: writeContext?.key ?? "",
      serverOrigin: writeContext?.serverUrl || window.location.origin,
      authority: writeContext?.mode === "hub" ? "local" : "team",
      ready: !!writeContext,
    });
    return watchOperationContext();
  }, [writeContext]);

  useEffect(() => {
    document.title = "Millionvolt Hub — MV Agent";
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEYS.agentPanelScreen) setScreen(readScreen());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const dock = () => {
    saveString(STORAGE_KEYS.agentPanelFloat, "0");
    saveString(STORAGE_KEYS.agentPanelOpen, "1");
    window.close();
  };

  return (
    <div className="agent-window">
      <AgentPanel popout context={screen.context} contextLabel={screen.label} onClose={() => window.close()} onDock={dock}
        projectName={(id) => screen.projects[id]} onPreview={setPreview} />
      {preview && <MediaPreview target={preview} onClose={() => setPreview(null)} localHub={writeContext ? writeContext.allowPrivate : false} />}
      <PopupAuthPauseBanner />
    </div>
  );
}
