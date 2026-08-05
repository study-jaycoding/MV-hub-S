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
  ) => void;
  dispose: () => void;
}

/** 전역 드래그 리스너와 rAF 합치기를 관리한다. React·DOM에 직접 의존하지 않는다. */
export function createSceneDragSession<Event>(
  environment: SceneDragEnvironment<Event>,
): SceneDragSession<Event> {
  let cleanupActive: (() => void) | null = null;
  let cancelActive: (() => void) | null = null;

  const begin: SceneDragSession<Event>["begin"] = (move, up, onCancel) => {
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

    cleanupActive = teardown;
    cancelActive = cancel;
    environment.addListener("mousemove", onMove);
    environment.addListener("mouseup", onUp);
    environment.addListener("blur", cancel);
  };

  return {
    begin,
    // 언마운트는 화면 상태를 다시 쓰지 않도록 pending 이동과 onCancel을 실행하지 않고 정리만 한다.
    dispose: () => cleanupActive?.(),
  };
}
