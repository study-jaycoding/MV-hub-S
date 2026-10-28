// 표시 전용 분류. 제출 여부/과금/재시도 허가는 이 결과로 판단하지 않는다.
// 배포 에이전트는 단일 파일이므로 Python 구현과 tests/fixtures의 공통 사례로 맞춘다.
export type GenerationIssueCode =
  | "group_credit_limit" | "insufficient_credits" | "credit_issue"
  | "auth" | "forbidden" | "invalid_input" | "rate_limit"
  | "provider_error" | "network_timeout";

function diagnosticBody(error: string): string {
  const marker = "제출 진단: ";
  const at = error.indexOf(marker);
  return (at < 0 ? error : error.slice(at + marker.length))
    .split(/\s*[—–]\s*cmd:/, 1)[0].trim();
}

function stripPrefix(value: string): string {
  return value.replace(/^(?:(?:\[경고\]|CLI 실패:|Error:|오류:)\s*)+/i, "").trim();
}

// JSON 이면 오류 필드(error·message·detail)만, 아니면 앞말을 뗀 본문. JSON 이 깨졌거나 오류 필드가 없으면 "".
function errorValue(body: string): string {
  const value = stripPrefix(body);
  if (/^[{[]/.test(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      const message = typeof error === "string" ? error
        : error && typeof error === "object" && !Array.isArray(error)
          ? ((error as Record<string, unknown>).message ?? (error as Record<string, unknown>).detail)
          : (record.message ?? record.detail);
      return typeof message === "string" ? message : "";
    } catch { return ""; }
  }
  return value;
}

// 명령 인자, JSON prompt/input, 스택/URL에 등장하는 오류 단어를 원인으로 오인하지 않는다.
function errorMessage(body: string): string {
  return messageLines(errorValue(body)).join("\n");
}

// 프롬프트·본문·스택 줄에서 멈추고(그 뒤는 사용자 글이나 경로다) JSON 줄은 건너뛴다. keep 이 참인 줄만 멈춤 판별에서 뺀다.
function messageLines(value: string, keep?: (line: string) => boolean): string[] {
  const lines: string[] = [];
  for (const line of value.split(/\r\n|[\n\r\u2028\u2029]/)) {
    const clean = stripPrefix(line.trim());
    if (/^(?:Traceback\b|at\s|File\s["']|(?:prompt|negative_prompt|display_prompt|request|body|args|command)\s*[:=])/i.test(clean) && !keep?.(clean)) break;
    if (/^[{[]/.test(clean)) continue;
    lines.push(clean.replace(/https?:\/\/\S+/gi, ""));
  }
  return lines;
}

const ISSUE_PATTERNS: [Exclude<GenerationIssueCode, "credit_issue">, RegExp][] = [
  ["group_credit_limit", /^(?:you(?:['’]ve| have) reached your monthly workspace group credit limit\b|monthly workspace group credit limit (?:reached|exceeded)\b)/i],
  ["insufficient_credits", /^(?:insufficient credits\b|not enough credits\b|you (?:do not|don't) have enough credits\b|(?:your )?credit balance (?:is )?(?:insufficient|too low|exhausted)\b)/i],
  ["auth", /^(?:not authenticated\b|authentication (?:required|failed)\b|(?:your )?(?:session|access token|authentication token) (?:has )?expired\b|invalid (?:access|authentication|auth) token\b|HTTP (?:status(?: code)?\s*:?[ \t]*)?401\b)/i],
  ["forbidden", /^(?:permission denied\b|access denied\b|forbidden\b|you (?:do not|don't) have (?:access|permission)\b|HTTP (?:status(?: code)?\s*:?[ \t]*)?403\b)/i],
  ["invalid_input", /^(?:invalid (?:media UUID|input|parameter|argument|reference|image|video|audio)\b|validation (?:error|failed)\b|unsupported (?:image|video|audio|file|format)\b|missing required (?:input|parameter|argument)\b|HTTP (?:status(?: code)?\s*:?[ \t]*)?(?:400|422)\b)/i],
  ["rate_limit", /^(?:rate limit (?:exceeded|reached)\b|too many requests\b|HTTP (?:status(?: code)?\s*:?[ \t]*)?429\b)/i],
  ["provider_error", /^(?:internal server error\b|service unavailable\b|bad gateway\b|gateway timeout\b|HTTP (?:status(?: code)?\s*:?[ \t]*)?5\d\d\b)/i],
  ["network_timeout", /^(?:(?:connection|request|connect|read) (?:has )?timed out\b|connect ETIMEDOUT\b|network (?:error|unreachable)\b|connection (?:refused|reset|closed)\b|fetch failed\b)/i],
];

// 안내용 JSON 오류 글 — 명시적 오류 필드(error·message·msg·detail)와 그 안의 객체·배열 항목까지 모은다.
//  다른 키(prompt·input 등 사용자 입력)는 보지 않는다. 분류(errorValue)는 에이전트 Python 과 짝이라 그대로 둔다.
function errorFieldTexts(value: unknown, depth = 0): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object" || depth > 3) return [];
  const items = Array.isArray(value)
    ? value
    : ["error", "message", "msg", "detail"].map((key) => (value as Record<string, unknown>)[key]);
  return items.flatMap((item) => errorFieldTexts(item, depth + 1));
}

// 분류 밖에서 특정 CLI 오류 문장(pattern — 줄 맨 앞부터 맞출 것)을 알아본다. 명령 인자는 빼고, 부분 응답은 내용을 보지 않으며,
//  JSON 은 오류 필드만, 프롬프트·본문 경계 뒤는 보지 않는다(분류와 같은 기준). pattern 에 맞는 줄만 'at ' 스택 판별에서 뺀다 —
//  CLI 원문 'Error: at most 3 …' 가 스택 줄로 잘리지 않게.
export function generationErrorMatches(error: string | null | undefined, pattern: RegExp): boolean {
  if (!error) return false;
  const body = diagnosticBody(error.slice(0, 8192));
  if (body.startsWith("CLI 타임아웃") || body.startsWith("CLI JSON 파싱 실패")) return false;
  const value = stripPrefix(body);
  let texts = [value];
  if (/^[{[]/.test(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      texts = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? errorFieldTexts(parsed) : [];
    } catch { return false; }
  }
  const keep = (line: string) => pattern.test(line);
  return texts.some((text) => messageLines(text, keep).some(keep));
}

export function classifyGenerationError(error?: string | null): GenerationIssueCode | null {
  if (!error) return null;
  const body = diagnosticBody(error.slice(0, 8192));
  // 부분 응답은 실제 오류문과 사용자 데이터가 섞일 수 있다. 내용 분류 금지.
  if (body.startsWith("CLI 타임아웃")) return "network_timeout";
  if (body.startsWith("CLI JSON 파싱 실패")) return null;
  const messages = errorMessage(body).split(/\n|[.!?]\s+/).map(stripPrefix);
  const found = ISSUE_PATTERNS.filter(([, pattern]) => messages.some(text => pattern.test(text))).map(([code]) => code);
  if (found.includes("group_credit_limit") && found.includes("insufficient_credits")) return "credit_issue";
  return found[0] ?? null;
}
