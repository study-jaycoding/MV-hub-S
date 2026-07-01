// 업로드 파일 → MCP 아이템 배열. JSON 배열 / {items|generations|data:[...]} / JSONL(줄마다 객체) 허용.
//  (backfill_import.py load_items + JSONL 폴백과 동일 규칙 — 통째 JSON 먼저, 실패 시 줄단위.)
export function parseMcpItems(text: string): Record<string, unknown>[] {
  const t = text.trim();
  if (!t) return [];
  try {
    const data = JSON.parse(t);
    if (Array.isArray(data)) return data.filter(isObjectRecord);
    if (isObjectRecord(data)) {
      for (const key of ["items", "generations", "data"]) {
        const arr = data[key];
        if (Array.isArray(arr)) return arr.filter(isObjectRecord);
      }
    }
  } catch {
    /* JSONL 폴백 */
  }

  const out: Record<string, unknown>[] = [];
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const item = JSON.parse(s);
      if (isObjectRecord(item)) out.push(item);
    } catch {
      /* 불량 줄 건너뜀 */
    }
  }
  return out;
}

export function buildBackfillInstructions(origin: string): string {
  return `# History 전체 백필 — Claude가 파일로 만들기

힉스필드 MCP의 show_generations 로 내 생성 이력 전체를 끝까지 가져와 **한 파일로 저장**하세요.
그 파일을 허브에 업로드하면 끝입니다(허브가 멱등 적재).
**허브에 직접 접속·POST 할 필요 없습니다 — 파일만 만들면 됩니다.** (허브 주소: ${origin})

## 할 일
1. show_generations 를 next_cursor 가 없어질 때까지 끝까지 페이지네이션합니다.
2. 모든 페이지의 items 를 한 파일로 저장합니다(손타이핑 금지 — 코드로 덤프):
   - my_history.jsonl  (한 줄에 아이템 1개)   또는
   - my_history.json   (아이템 배열 [ ... ])
3. 허브 웹에서 설정 > "과거 생성물 가져오기" > "② 만든 파일 올려서 적용" 에 그 파일을 업로드합니다. 끝.

## 저장할 아이템 키 (이대로 담으면 출처까지 보존됨)
       {
         "id":        "<job id>",            // 필수 · 멱등 키
         "status":    "completed",
         "model":     "<job_set_type>",
         "createdAt": "<ISO 시각>",
         "results":   { "rawUrl": "<결과 미디어 URL>" },
         "params":    { "prompt": "<프롬프트>",
                        "input_images": [ { "role": "@image", "url": "<레퍼런스 URL>" } ] }
       }

- id 는 필수(멱등 키). results.rawUrl 의 user_<id> 로 '내 작업' 귀속이 정해집니다.
- 프롬프트/레퍼런스 출처는 params.prompt / params.input_images 로 보존됩니다.

## ⚠️ 프롬프트/파라미터 누락 주의
show_generations 가 id/type/status/model/url/createdAt 만 주고 prompt·params 를 빼는 경우가 있습니다.
이 허브의 최우선 가치는 '출처(프롬프트·레퍼런스) 보존'이라, 비면 재사용·변형이 약해집니다.
- 가능하면 각 항목을 풍부화해 params.prompt / params.input_images 를 채워 저장하세요.
- 당장 어려우면 메타만 먼저 저장·업로드하고, 나중에 같은 id 로 프롬프트를 보강해 다시 업로드하면 멱등으로 덮어써집니다.

## 참고
- CLI(generate list)는 최신 100건까지만 — 100건 밖 과거 전체는 이 백필로만 채워집니다.
- 멱등이라 같은 파일을 또 올려도 중복이 안 생깁니다.
`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}
