// 편집 탭의 [타임라인 Resolve 보내기] 확인 창 — 무엇이 어디로 가는지 보여 주고, 보낼 수 없으면 왜인지 말한다.
//  편집 탭은 Resolve 가 켜져 있는지 늘 알고 있지 않다(상태를 물어 두지 않는다) — 창이 열릴 때 한 번 묻고, [다시 확인]으로 또 묻는다.
//  [보내기]는 그때 열려 있던 Resolve 프로젝트를 받는 곳으로 넘긴다. 그사이 프로젝트가 바뀌면 받는 쪽(서버)이 멈춘다.
import { useCallback, useEffect, useRef, useState } from "react";
import type { TimelineExport } from "../../lib/editResolveExport";
import { timecode } from "../../lib/editTimeline";
import { useT } from "../../lib/i18n";
import { useModalFocus } from "../../lib/keyGate";
import {
  checkResolveSelection,
  getResolveConnectionStatus,
  type ResolveProjectTarget,
} from "../../lib/resolveTransfer";
import { useEscapeClose } from "../../lib/useEscapeClose";

// null = 묻는 중
type Asked = { ready: true; target: ResolveProjectTarget } | { ready: false; message: string } | null;

export function EditExportConfirm({ exported, onSend, onClose }: {
  exported: TimelineExport;
  onSend: (target: ResolveProjectTarget) => void;
  onClose: () => void;
}) {
  const t = useT();
  useEscapeClose(onClose);
  const modalRef = useRef<HTMLDivElement>(null);
  useModalFocus(modalRef); // 초점을 창 안에 둔다 — 떠 있는 동안 편집 키(Space·방향키)가 뒤 타임라인으로 가지 않는다
  const [asked, setAsked] = useState<Asked>(null);
  const turn = useRef(0); // 늦게 온 옛 답(다시 확인을 누른 뒤·창을 닫은 뒤)은 버린다
  const ask = useCallback(() => {
    const mine = ++turn.current;
    setAsked(null);
    getResolveConnectionStatus().then(
      (status) => {
        if (turn.current !== mine) return;
        setAsked(status.status === "ready"
          ? { ready: true, target: { project_id: status.project_id, project_name: status.project_name } }
          : { ready: false, message: status.message || "DaVinci Resolve에 연결할 수 없습니다." });
      },
      (error) => {
        if (turn.current !== mine) return;
        const message = error instanceof Error ? error.message : String(error);
        setAsked({ ready: false, message: `Resolve 연결 확인 실패: ${message.replace(/^\d+:\s*/, "")}` });
      },
    );
  }, []);
  useEffect(() => {
    ask();
    return () => { turn.current += 1; };
  }, [ask]);

  const { plan, gens, unresolved, perTrack, disabled, markersDropped } = exported;
  const checked = checkResolveSelection(gens);
  // 보낼 수 없는 까닭 — 못 이은 클립을 빼고 보내면 '그대로'가 아니다(lib/editResolveExport)
  const problem = unresolved > 0
    ? t("공유 목록에서 찾지 못한 클립이 {count}개 있습니다 — 목록을 다 받았는지 확인하고, 없어진 클립은 빼거나 바꿔 주세요.")
      .replace("{count}", String(unresolved))
    : !plan.clips.length ? t("타임라인에 넣은 클립이 없습니다.")
      : checked.ok ? null : t(checked.message);
  const tracks = perTrack.map((count, index) => ({ count, track: index + 1 })).filter((item) => item.count > 0);

  return (
    <>
      <div className="gradestep-catcher" onMouseDown={onClose} />
      <div ref={modalRef} className="gradestep-modal ed-export" role="dialog" aria-modal="true" aria-label={t("타임라인 Resolve 보내기")}>
        <div className="gradestep-title">{t("타임라인 Resolve 보내기")}</div>
        <div className="gradestep-body">
          <p>{t("Resolve 에 새 타임라인을 지금 보이는 그대로 만듭니다.")}</p>
          <dl className="ed-export-rows">
            <dt>{t("이름")}</dt>
            <dd className="ed-export-name">{plan.name}</dd>
            <dt>{t("내용")}</dt>
            <dd>
              {tracks.map((item) => `V${item.track} ${item.count}`).join(" · ") || "—"}
              {" · "}{timecode(plan.total / plan.fps)}
              {disabled > 0 && <>{" · "}{t("끈 클립 {count}").replace("{count}", String(disabled))}</>}
              {plan.markers.length > 0 && <>{" · "}{t("북마크 {count}").replace("{count}", String(plan.markers.length))}</>}
              {plan.mark && <>{" · "}{t("인/아웃")}</>}
            </dd>
            <dt>{t("받는 곳")}</dt>
            <dd className={"ed-export-to" + (asked && !asked.ready ? " ed-export-bad" : "")} role="status">
              {asked === null ? t("Resolve 연결을 확인하는 중…")
                : asked.ready ? asked.target.project_name
                  : (
                    <>
                      {t(asked.message)}{" "}
                      <button type="button" className="ed-link" onClick={ask}>{t("다시 확인")}</button>
                    </>
                  )}
            </dd>
          </dl>
          {problem && <p className="ed-export-bad" role="alert">{problem}</p>}
          {markersDropped > 0 && (
            <p>{t("같은 프레임에 겹친 북마크 {count}개는 빠집니다.").replace("{count}", String(markersDropped))}</p>
          )}
          <p className="ed-export-note">
            {t("누를 때마다 새 타임라인을 만듭니다 — 앞서 만든 타임라인은 바꾸지 않습니다. 소리는 맨 위에 보이는 영상의 것만 가고, 트랙 색과 위쪽 컷 이름 줄은 넘어가지 않습니다.")}
          </p>
        </div>
        <div className="gradestep-actions">
          <button type="button" className="gradestep-btn cancel" onClick={onClose}>{t("취소")}</button>
          <button type="button" className="gradestep-btn confirm" disabled={!!problem || !asked?.ready}
            onClick={() => { if (asked?.ready && !problem) onSend(asked.target); }}>
            {t("보내기")}
          </button>
        </div>
      </div>
    </>
  );
}
