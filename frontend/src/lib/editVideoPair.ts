// 영상 요소 둘을 하나처럼 — 앞의 것이 보이고, 뒤의 것은 다음에 보일 영상을 미리 받아 그 자리에 세워 둔다. 계약은 docs/EDIT_TAB.md.
//  요소 하나에 주소만 갈면 컷이 넘어갈 때마다 새 영상을 받는 시간만큼 화면이 선다(Jay 2026-10-08). 재생 엔진(useEditPlayback)은
//  여전히 영상 하나를 다루듯 쓰고, 넘어가는 순간에만 swap 으로 '미리 받아 둔 것을 앞으로' 를 청한다. 넘어가기 직전에는 뒤의
//  것을 소리 없이 미리 굴려 둔다(roll) — 다 받아 둔 영상도 재생을 시작하는 데 시간이 든다.
//  · 굴리는 동안의 소리는 volume 으로 끈다. muted 는 화면(React)의 것이다 — 굴리는 중에 사용자가 소리를 켜면 화면이 두
//    요소의 muted 를 함께 풀어, 가려진 영상의 소리가 났다(Codex 코드 리뷰).
//  · 주소는 넘겨받은 글자 그대로 견준다(DOM 의 src 는 절대 주소로 바뀌어 있다).
//  · 이벤트는 앞의 것에서 온 것만 엔진에 전한다 — 뒤의 것이 받는 중에 내는 loadedmetadata·seeked·error 는 엔진 몫이 아니다.
import { useLayoutEffect, useRef } from "react";
import { videoEnd, type EditVideo } from "./useEditPlayback";

// 미리 굴리는 길이의 한도(실제 시간, 초). 앞의 것이 받느라 서 있으면 넘어가는 순간이 오지 않는다 — 그동안 뒤의 것이 혼자
//  멀리 가면 그만큼 건너뛰게 되므로, 이만큼 가면 제자리로 돌려 세운다(엔진의 ROLL_SLOP 보다 짧다).
const ROLL_MAX = 0.25;
const HAVE_CURRENT_DATA = 2; // 지금 자리의 그림이 있다

// holdFrame = 넘길 때 새 것이 그림을 낼 때까지 옛 그림을 둔다(클린 피드). 끈 짝(앱 뷰어·소스 판의 재생 엔진)은 바로 바꿔 보인다 — 기다리는 동안
//  다음 것을 미리 받지 않게 되므로 엔진의 넘김 순서까지 바뀐다(이번엔 피드만).
export function pairVideo(a: HTMLVideoElement, b: HTMLVideoElement, holdFrame = false): EditVideo {
  let front = a;
  let back = b;
  let frontUrl = "";
  let backUrl = ""; // 뒤의 것에 올려 둔 주소
  let backTime = NaN; // 뒤의 것을 세워 둔 시각. NaN = 모른다(방금까지 앞에서 재생하던 요소다 — 다시 세워야 한다)
  let rolling = false; // 뒤의 것을 미리 굴리는 중이다(volume 0)
  let backRate = 1; // 뒤의 것을 굴릴 배속 — 그 클립의 속도 × 재생 배속(앞의 것과 다를 수 있다 — 클립마다 속도가 다르다)
  // 앞뒤를 바꿨지만 새 앞 요소가 아직 그림이 없다(받는 중) — 그 동안은 옛 요소(이제 뒤)의 마지막 그림을 그대로 보인다. 그림 없는 요소를 보이면
  //  검은 화면이다(2026-10-26 Jay "클립 넘어갈 때 검은 화면이 생겼다가 재생" — 서버 중계로 미리 받기가 넘김까지 못 끝난 때).
  let held = false;
  const wraps = new Map<() => void, (event: Event) => void>();
  const mark = () => {
    held = false;
    delete front.dataset.spare;
    back.dataset.spare = ""; // CSS 가 가린다(.ed-media[data-spare]) — 자리는 차지한 채라 디코딩된 프레임이 바로 나온다
  };
  const reveal = (event: Event) => {
    // 새 것이 그림을 냈다 — 또는 못 받았다(오류 — 추종 판이 썸네일로 알린다. 기다림을 풀어야 다시 미리 받는다)
    if (held && event.currentTarget === front && (event.type === "error" || front.readyState >= HAVE_CURRENT_DATA)) mark();
  };
  if (holdFrame) for (const el of [a, b]) for (const type of ["loadeddata", "seeked", "canplay", "error"]) el.addEventListener(type, reveal);
  mark();
  return {
    get src() { return frontUrl; },
    set src(url: string) {
      frontUrl = url;
      front.src = url;
    },
    get currentTime() { return front.currentTime; },
    set currentTime(time: number) { front.currentTime = time; },
    get playbackRate() { return front.playbackRate; },
    set playbackRate(rate: number) { front.playbackRate = rate; },
    get paused() { return front.paused; },
    get seeking() { return front.seeking; },
    get duration() { return front.duration; },
    get readyState() { return front.readyState; },
    play: () => front.play(),
    pause: () => front.pause(),
    load: () => front.load(),
    removeAttribute(name: string) {
      if (name === "src") {
        frontUrl = "";
        if (held) mark(); // 영상을 내린다(빈 자리·그림 클립) — 옛 그림을 남기지 않는다
      }
      front.removeAttribute(name);
    },
    addEventListener(type: string, listener: () => void) {
      let wrap = wraps.get(listener);
      if (!wrap) wraps.set(listener, (wrap = (event) => { if (event.currentTarget === front) listener(); }));
      a.addEventListener(type, wrap);
      b.addEventListener(type, wrap);
    },
    removeEventListener(type: string, listener: () => void) {
      const wrap = wraps.get(listener);
      if (!wrap) return;
      a.removeEventListener(type, wrap);
      b.removeEventListener(type, wrap);
    },
    // 다음에 보일 영상을 뒤의 것에 올려 그 시각에 세워 둔다(null = 비운다). 이미 그렇게 해 두었으면 아무것도 하지 않는다.
    //  rate = 그것을 미리 굴릴 배속(그 클립의 속도 × 재생 배속).
    prepare(url: string | null, time: number, rate = 1) {
      if (held) return; // 뒤의 것이 아직 보이는 옛 그림이다 — 건드리지 않는다(새 것이 그림을 내면 다음 프레임에 다시 불린다)
      backRate = rate;
      if (rolling) back.playbackRate = rate;
      const next = url ?? "";
      if (next === backUrl && (time === backTime || !next)) return;
      const same = next === backUrl; // 같은 영상(방금까지 앞에서 틀던 것 포함) — 다시 받지 않고 자리만 옮긴다
      if (!same) {
        if (rolling) back.volume = front.volume; // 굴리던 것을 내린다 — 꺼 둔 소리를 돌려놓는다
        rolling = false;
        if (next) back.src = next;
        else back.removeAttribute("src");
        back.load();
      }
      // 메타데이터를 받기 전에 적은 시각은 '처음 자리'가 되어, 받는 대로 그리로 간다(HTML 표준).
      if (next && (same || time > 0)) back.currentTime = time;
      backUrl = next;
      backTime = time;
    },
    // 뒤의 것이 그 주소를 들고 있으면 앞으로 내놓는다(받지 않는다). 못 받은 것(error)은 내놓지 않는다 — 평소 길로 다시 받는다.
    swap(url: string) {
      if (!url || url !== backUrl || back.error) return false;
      [front, back] = [back, front];
      [frontUrl, backUrl, backTime] = [url, frontUrl, NaN];
      if (rolling) front.volume = back.volume; // 굴리느라 꺼 둔 소리를 돌려준다(방금까지 앞이던 요소의 값으로)
      rolling = false;
      if (!holdFrame || front.readyState >= HAVE_CURRENT_DATA) mark();
      else held = true; // 아직 받는 중 — 그림이 나오면(reveal) 바꿔 보인다
      return true;
    },
    // 넘어가기 직전 — 뒤의 것을 소리 없이 미리 굴린다(prepare 가 받은 그 클립의 배속). 끄면 세우고 세워 둔 자리로 돌린다.
    //  굴리는 동안 프레임마다 다시 불린다 — 너무 멀리 갔으면(ROLL_MAX) 제자리로 돌려 세운다.
    roll(on: boolean) {
      if (held) return; // 뒤의 것은 보이는 옛 그림이다(바꿔 끼운 뒤라 굴리던 것도 없다)
      // 실제 끝에 세워 둔 것은 굴리지 않는다(적어 둔 길이보다 짧은 영상 — 세울 자리가 그 끝으로 잘렸다): 끝난 영상에 play() 를
      //  걸면 처음부터 다시 돌아, 넘어온 순간 엉뚱한 시각의 영상이 시계를 받는다(Codex 코드 리뷰).
      if (on && (!backUrl || back.currentTime >= videoEnd(back))) return;
      if (on === rolling) {
        if (on && !back.paused && back.currentTime - backTime > ROLL_MAX * back.playbackRate) {
          back.pause();
          back.currentTime = backTime;
        }
        return;
      }
      rolling = on;
      if (on) {
        back.volume = 0;
        back.playbackRate = backRate;
        back.play().catch(() => {}); // 못 굴려도(아직 받는 중·세워짐) 넘어갈 때 평소 길로 간다
      } else {
        back.pause();
        back.volume = front.volume;
        if (Number.isFinite(backTime)) back.currentTime = backTime;
      }
    },
  };
}

// 뷰어 한 판의 영상 요소 둘과, 그 둘을 묶은 것(엔진에 넘긴다). 묶음은 레이아웃 단계에서 만든다 — 엔진이 이벤트를 거는 것보다 먼저.
export function useVideoPair(holdFrame = false) {
  const front = useRef<HTMLVideoElement>(null);
  const spare = useRef<HTMLVideoElement>(null);
  const pair = useRef<EditVideo | null>(null);
  useLayoutEffect(() => {
    pair.current = front.current && spare.current ? pairVideo(front.current, spare.current, holdFrame) : null;
  }, [holdFrame]);
  return { pair, front, spare };
}
