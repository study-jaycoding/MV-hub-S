// 플로팅 입력 컨텍스트 — 어느 컴포넌트에서나 useAskPrompt() 로 네이티브 window.prompt 대체.
// Promise 를 돌려주므로 `const v = await askPrompt("제목", 초기값, 플레이스홀더)` 로 쓴다.
import { createContext, useCallback, useContext, useState } from "react";
import type { ReactNode } from "react";
import { FloatingPrompt } from "../components/FloatingPrompt";

type AskFn = (
  title: string,
  initial?: string,
  placeholder?: string,
) => Promise<string | null>;

const PromptCtx = createContext<AskFn>(async () => null);

export const useAskPrompt = (): AskFn => useContext(PromptCtx);

export function PromptProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{
    title: string;
    initial: string;
    placeholder: string;
    resolve: (v: string | null) => void;
  } | null>(null);

  const ask = useCallback<AskFn>(
    (title, initial = "", placeholder = "") =>
      new Promise<string | null>((resolve) =>
        setState({ title, initial, placeholder, resolve }),
      ),
    [],
  );

  return (
    <PromptCtx.Provider value={ask}>
      {children}
      {state && (
        <FloatingPrompt
          title={state.title}
          initial={state.initial}
          placeholder={state.placeholder}
          onSubmit={(v) => {
            state.resolve(v);
            setState(null);
          }}
          onCancel={() => {
            state.resolve(null);
            setState(null);
          }}
        />
      )}
    </PromptCtx.Provider>
  );
}
