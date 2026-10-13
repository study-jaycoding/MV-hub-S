export type SceneDragEventType = "mousemove" | "mouseup" | "blur";
export type SceneDragListener<Event> = (event: Event) => void;

export interface SceneDragEnvironment<Event> {
  addListener: (type: SceneDragEventType, listener: SceneDragListener<Event>) => void;
  removeListener: (type: SceneDragEventType, listener: SceneDragListener<Event>) => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
}

export interface SceneDragSession<Event> {
  begin: (
    move: SceneDragListener<Event>,
    up: SceneDragListener<Event>,
    onCancel?: () => void,
    onRebase?: () => void,
    /** Esc 로 끌기를 **버릴** 때(아래 discard) — 이동을 되돌리는 일은 끌기가 한다. 없는 끌기는 Esc 로 버릴 수 없다(범위 선택·판 밀기·가위). */
    onDiscard?: () => void,
  ) => void;
  /** 도는 끌기를 이동을 **버리고** 끝낸다(Esc — 29회차, Jay 안 A) — 밀린 걸음도 버리고 onDiscard 만 부른다(up·onCancel 은 안 부른다).
   *  버렸으면 true. 끌기가 없거나 onDiscard 가 없는 끌기면 아무 일도 없이 false — 그 Esc 는 평소대로 간다(선택 해제 등). */
  discard: () => boolean;
  /** 남아 있는 끌기(mouseup 을 놓친 것)를 지금 끝낸다 — 밀린 걸음을 반영하고 취소의 길로(blur 와 같다). 없으면 아무 일도 없다.
   *  begin 도 같은 일을 하지만 그때는 새 조작이 시작 좌표를 이미 읽은 뒤다 — 새 누름의 첫머리에서 먼저 부른다(SceneBoard). */
  settle: () => void;
  /** 끄는 중에 밖에서 값이 갈렸다(SceneBoard 의 씬 동기화) — 도는 끌기의 onRebase 를 부른다: 끌기가 쥔 값(옮긴 자리·늘린 크기)을
   *  새 값 위에 다시 얹는다. 이벤트를 다시 넣지 않는다 — move 는 속도 표본·마우스 밑 찾기까지 하므로 '한 번 더'가 같은 일이 아니다
   *  (Codex 설계 검토). 밀린 걸음은 건드리지 않는다(다음 프레임에 평소대로 들어간다). onRebase 가 없는 끌기·끌기가 없으면 아무 일도 없다. */
  rebase: () => void;
  dispose: () => void;
}

/** 전역 드래그 리스너와 rAF 합치기를 관리한다. React·DOM에 직접 의존하지 않는다. */
export function createSceneDragSession<Event>(
  environment: SceneDragEnvironment<Event>,
): SceneDragSession<Event> {
  let cleanupActive: (() => void) | null = null;
  let cancelActive: (() => void) | null = null;
  let rebaseActive: (() => void) | null = null;
  let discardActive: (() => boolean) | null = null;

  const begin: SceneDragSession<Event>["begin"] = (move, up, onCancel, onRebase, onDiscard) => {
    // mouseup을 놓친 이전 세션이 있으면 마지막 이동을 반영하고 취소한 뒤 새 세션을 연다.
    cancelActive?.();

    let frameId: number | null = null;
    let pendingEvent: Event | null = null;
    let closed = false;

    const runPending = () => {
      frameId = null;
      if (pendingEvent === null) return;
      const event = pendingEvent;
      pendingEvent = null;
      move(event);
    };
    const onMove = (event: Event) => {
      // 단추를 다 뗀 채 온 움직임 = mouseup 을 놓쳤다(창 밖에서 뗌·브라우저가 삼킴). 그대로 두면 단추를 뗀 마우스를 카드가 따라오고
      //  끌기 상태가 다음 누름까지 남는다. 창을 떠날 때(blur)와 같은 길로 끝낸다 — 앞의 마지막 움직임까지만 반영하고, 뗀 뒤의 자리인
      //  이 이벤트는 반영하지 않는다(up 으로 끝내면 연결선·범위 선택이 '돌아온 자리'에 놓인 것으로 처리된다).
      //  판정은 '눌린 단추가 하나도 없다'다. 왼쪽 단추 비트만 보지 않는다 — 이 세션은 가운데 단추의 화면 이동(buttons 4)도 맡고,
      //  어느 단추로 시작했는지 모른다(mouseup 도 단추를 가리지 않고 끝낸다). buttons 가 없는 이벤트(마우스가 아닌 환경)는 건드리지 않는다.
      if ((event as { buttons?: unknown }).buttons === 0) {
        cancel();
        return;
      }
      pendingEvent = event;
      if (frameId === null) frameId = environment.requestFrame(runPending);
    };
    const flush = () => {
      if (frameId !== null) {
        environment.cancelFrame(frameId);
        frameId = null;
      }
      if (pendingEvent === null) return;
      const event = pendingEvent;
      pendingEvent = null;
      move(event);
    };
    const teardown = () => {
      if (closed) return false;
      closed = true;
      if (frameId !== null) {
        environment.cancelFrame(frameId);
        frameId = null;
      }
      pendingEvent = null;
      environment.removeListener("mousemove", onMove);
      environment.removeListener("mouseup", onUp);
      environment.removeListener("blur", cancel);
      if (cleanupActive === teardown) cleanupActive = null;
      if (cancelActive === cancel) cancelActive = null;
      if (rebaseActive === rebase) rebaseActive = null;
      if (discardActive === discard) discardActive = null;
      return true;
    };
    const onUp = (event: Event) => {
      flush();
      if (teardown()) up(event);
    };
    const cancel = () => {
      flush();
      if (teardown()) onCancel?.();
    };
    // 밀린 걸음은 반영하지 않는다(teardown 이 버린다) — 버리는 끌기의 마지막 걸음이 화면에 들어갔다 되돌아오지 않게.
    const discard = () => {
      if (!onDiscard || !teardown()) return false;
      onDiscard();
      return true;
    };

    const rebase = () => onRebase?.();

    cleanupActive = teardown;
    cancelActive = cancel;
    rebaseActive = rebase;
    discardActive = discard;
    environment.addListener("mousemove", onMove);
    environment.addListener("mouseup", onUp);
    environment.addListener("blur", cancel);
  };

  return {
    begin,
    settle: () => cancelActive?.(),
    rebase: () => rebaseActive?.(),
    discard: () => discardActive?.() ?? false,
    // 언마운트는 화면 상태를 다시 쓰지 않도록 pending 이동과 onCancel을 실행하지 않고 정리만 한다.
    dispose: () => cleanupActive?.(),
  };
}
