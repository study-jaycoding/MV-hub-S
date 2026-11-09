// MV Agent 답 글 — 안전한 마크다운(첫 연결 설계 13절): 굵게·기울임·목록·코드·줄바꿈·제목 줄만.
//  HTML 은 글자 그대로(React 가 글자로 넣는다) · 링크는 URL 파서로 검증한 http/https 만 새 창(noopener noreferrer) ·
//  javascript:·data:·file:·외부 앱 링크와 이미지·임베드는 불러오지 않고 원래 글자로 · 코드 블록은 글자로만(실행 기능 없음).
import type { ReactNode } from "react";

/** 새 창으로 열어도 되는 주소면 정규화한 주소, 아니면 null. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const TOKEN = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(!?\[[^\]\n]*\]\([^)\s]+\))|(\*[^*\s][^*\n]*\*)/g;
const LINK = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/;

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = match[0];
    const key = `${keyBase}-${n++}`;
    if (match[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (match[2]) out.push(<strong key={key}>{inline(token.slice(2, -2), key)}</strong>);
    else if (match[3]) {
      const link = LINK.exec(token);
      const href = link && !link[1] ? safeHref(link[3]) : null; // 이미지(![..])는 불러오지 않는다
      out.push(href ? <a key={key} href={href} target="_blank" rel="noopener noreferrer">{link![2] || href}</a> : token);
    } else if (match[4]) out.push(<em key={key}>{token.slice(1, -1)}</em>);
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const FENCE = /^\s*```/;
const HEADING = /^\s*#{1,6}\s+(.*)$/;

export function AgentMarkdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i += 1;
      blocks.push(<pre key={key++} className="agent-md-code"><code>{body.join("\n")}</code></pre>);
      continue;
    }
    if (BULLET.test(line) || NUMBERED.test(line)) {
      const pattern = NUMBERED.test(line) ? NUMBERED : BULLET;
      const items: string[] = [];
      while (i < lines.length && pattern.test(lines[i])) items.push(pattern.exec(lines[i++])![1]);
      const k = key++;
      const children = items.map((item, n) => <li key={n}>{inline(item, `${k}-${n}`)}</li>);
      blocks.push(pattern === NUMBERED
        ? <ol key={k} className="agent-md-list">{children}</ol>
        : <ul key={k} className="agent-md-list">{children}</ul>);
      continue;
    }
    if (HEADING.test(line)) {
      const k = key++;
      blocks.push(<p key={k} className="agent-md-p"><strong>{inline(HEADING.exec(line)![1], `${k}`)}</strong></p>);
      i += 1;
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !BULLET.test(lines[i])
      && !NUMBERED.test(lines[i]) && !HEADING.test(lines[i])) para.push(lines[i++]);
    const k = key++;
    blocks.push(
      <p key={k} className="agent-md-p">
        {para.flatMap((p, n) => (n ? [<br key={`br${n}`} />, ...inline(p, `${k}-${n}`)] : inline(p, `${k}-${n}`)))}
      </p>,
    );
  }
  return <div className="agent-md">{blocks}</div>;
}
