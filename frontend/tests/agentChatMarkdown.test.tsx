// @vitest-environment jsdom
// MV Agent 답 글 마크다운(첫 연결 설계 13절) — 굵게·기울임·목록·코드·제목만, 링크는 http/https 만, 이미지·HTML·위험 링크는 글자로.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentMarkdown, safeHref } from "../src/components/agent-chat/AgentMarkdown";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const show = (text: string) => act(() => root.render(<AgentMarkdown text={text} />));

describe("AgentMarkdown", () => {
  it("굵게·기울임·코드·목록·제목·줄바꿈", () => {
    show("# 계획\n이 칸에서는 **빈 노드**를 *바로* 못 만들어요. `read_context` 로 봐요.\n둘째 줄\n\n1. 종류\n2. 내용\n\n- 하나\n- 둘");
    expect(host.querySelector("strong")!.textContent).toBe("계획");
    expect([...host.querySelectorAll("strong")].map((s) => s.textContent)).toContain("빈 노드");
    expect(host.querySelector("em")!.textContent).toBe("바로");
    expect(host.querySelector("code")!.textContent).toBe("read_context");
    expect(host.querySelectorAll("br").length).toBe(1);
    expect([...host.querySelectorAll("ol li")].map((li) => li.textContent)).toEqual(["종류", "내용"]);
    expect([...host.querySelectorAll("ul li")].map((li) => li.textContent)).toEqual(["하나", "둘"]);
    expect(host.textContent).not.toContain("**");
  });

  it("코드 블록은 글자로만", () => {
    show("```\n<script>alert(1)</script>\nrm -rf\n```");
    const pre = host.querySelector("pre.agent-md-code")!;
    expect(pre.textContent).toBe("<script>alert(1)</script>\nrm -rf");
    expect(host.querySelector("script")).toBeNull();
  });

  it("링크는 http/https 만 새 창(noopener noreferrer) — javascript:/data:/file:/외부 앱·이미지는 글자로", () => {
    show("[문서](https://code.claude.com/docs) [나쁨](javascript:alert(1)) [데이터](data:text/html,x) [파일](file:///C:/x) [앱](ms-settings:x) ![그림](https://example.com/a.png)");
    const links = [...host.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]))
      .toEqual([["문서", "https://code.claude.com/docs", "_blank", "noopener noreferrer"]]);
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("[나쁨](javascript:alert(1))");
    expect(host.textContent).toContain("![그림](https://example.com/a.png)");
  });

  it("HTML 은 요소가 아니라 글자", () => {
    show('<img src=x onerror="alert(1)"> <b>굵게?</b> <iframe src="https://x"></iframe>');
    expect(host.querySelector("img, b, iframe")).toBeNull();
    expect(host.textContent).toContain("<img src=x");
  });

  it("safeHref", () => {
    expect(safeHref("https://claude.ai/x")).toBe("https://claude.ai/x");
    expect(safeHref("http://example.com")).toBe("http://example.com/");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "file:///C:/x", "vbscript:x", "nota url"]) expect(safeHref(bad)).toBeNull();
  });
});
