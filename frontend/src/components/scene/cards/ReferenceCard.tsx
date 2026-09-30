// 레퍼런스 카드 본문 — SceneBoard 렌더 분할(R2). 셸은 부모 소유, Fragment 만 반환(규칙은 OutputCard 참고).
//  genData 는 이벤트 시점 참조라 조회 함수(getGen)로 받는다(ref 역참조 없이 최신값).
import type React from "react";
import type { SceneCard, SceneRef } from "../../../lib/scenes";
import type { Generation, InfoTarget, PreviewTarget } from "../../../types";
import { heldText, refHeldInfo, refJudged, refServerStatus } from "../../../lib/sceneAssetRelink";
import { refMediaSrc, refMediaType, refThumbSrc, refTypeLabel } from "../../../lib/sceneMedia";
import { MediaThumbnail } from "../../MediaThumbnail";
import { CloudOffIcon, CopyIcon, LinkOffIcon, PendingIcon } from "../../common/ViewIcons";

// 안내에 보일 파일 이름 — 이름이 없으면 경로 끝.
const refFileName = (r: SceneRef): string =>
  r.name || r.file_path.split("|").pop()?.split("/").pop() || r.file_path;

export function ReferenceCard({
  card,
  fill,
  workspaceId,
  getGen,
  onInfo,
  onPreview,
  onOutPortDown,
  onBroken,
}: {
  card: SceneCard;
  fill: boolean;
  workspaceId: string; // 서버 판정의 열쇠(캔버스 탭의 공간) — 자동 복구가 물을 때와 같은 값
  getGen: (id: string) => Generation | undefined;
  onInfo?: (target: InfoTarget) => void;
  onPreview?: (t: PreviewTarget) => void;
  onOutPortDown: (e: React.MouseEvent, cardId: string) => void;
  onBroken?: (r: SceneRef) => void; // 그림이 끝내 안 떴다 — 옮겨졌을 수 있어 한 번 다시 묻는다(recheckBrokenRef)
}) {
  const single = (card.refs?.length ?? 0) <= 1;
  return (
    <>
      {/* 내부 래퍼만 클리핑(둥근 모서리) — 포트는 이 밖이라 잡기 영역이 안 잘린다 */}
      <div className="scene-card-inner">
        <div className="scene-card-hd">{refTypeLabel(card.refs)}</div>
        <div className={"scene-card-body" + (single ? " single" : "") + (fill ? "" : " fit-contain")}>
          {(card.refs || []).map((r, i) => {
            const isVid = refMediaType(r) === "video";
            // missing = 서버 어디에도 없음(받은 사람) · local = 이 PC 안 사본에만 있음(가진 사람)
            const status = refServerStatus(workspaceId, r);
            const missing = status === "missing";
            // 판정 보류 = 못 이었고 이유가 있다 — 서버에 없음처럼 빨간 빗금 + 이유(Jay 2026-09-30)
            const held = status === "held" ? heldText(refHeldInfo(workspaceId, r)!) : null;
            const unlinked = missing || !!held;
            return (
              <div
                className="scene-refthumb"
                key={i}
                title={
                  (r.name || `레퍼런스 ${i + 1}`) +
                  (missing
                    ? " · 서버에 없음 · 미들클릭=정보"
                    : held
                      ? ` · ${held.title}${held.detail ? ` — ${held.detail}` : ""} · ${held.fix}` +
                        `${held.more ? ` · ${held.more}` : ""} · 미들클릭=정보`
                      : " · 더블클릭=큰 화면 · 미들클릭=정보")
                }
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault(); // 휠클릭 자동스크롤 방지(정보는 auxclick 에서)
                }}
                onAuxClick={(e) => {
                  // 미들클릭 = 정보. asset 토큰(어셋/임포트/캡처) → 어셋창과 동일한 파일 정보 팝업,
                  //  생성물에서 온 레퍼런스(source_gen_id) → 생성 정보 팝업.
                  if (e.button !== 1) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const fp = r.file_path || "";
                  if (fp.startsWith("asset:")) {
                    const [proj, path] = fp.slice(6).split("|");
                    if (proj && path) {
                      const mt = refMediaType(r);
                      onInfo?.({
                        kind: "file",
                        project: proj,
                        node: {
                          name: r.name || path.split("/").pop() || path,
                          type: mt === "video" ? "video" : mt === "audio" ? "audio" : "image",
                          path,
                        },
                        x: e.clientX,
                        y: e.clientY,
                      });
                      return;
                    }
                  }
                  const g = r.source_gen_id ? getGen(r.source_gen_id) : undefined;
                  if (g) onInfo?.({ kind: "generation", gen: g, x: e.clientX, y: e.clientY });
                }}
                onMouseEnter={
                  isVid
                    ? (e) => {
                        const v = e.currentTarget.querySelector("video");
                        if (v) {
                          v.muted = true; // React <video muted> 반영 버그 → 재생 직전 무음 강제
                          v.play().catch(() => {});
                        }
                      }
                    : undefined
                }
                onMouseLeave={
                  isVid
                    ? (e) => {
                        const v = e.currentTarget.querySelector("video");
                        if (v) {
                          v.pause();
                          v.currentTime = 0;
                        }
                      }
                    : undefined
                }
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (unlinked) return; // 서버에 없거나 연결 안 돼 열 것이 없다
                  const url = refMediaSrc(r);
                  if (url) onPreview?.({ url, type: refMediaType(r), name: r.name || "레퍼런스" });
                }}
              >
                {missing ? (
                  // 서버가 방금 어디에도 없다고 확인했다 — 썸네일을 부르지 않는다(브라우저에 남은 옛 썸네일이
                  //  안내를 가리지 않게, Codex 2026-09-29). 한 장이면 이유와 파일 이름, 여러 장이면 아이콘만.
                  <>
                    <span className="scene-refthumb-ph off-server" />
                    {single ? (
                      <span className="scene-ref-offmsg">
                        <CloudOffIcon />
                        <b>서버에 없음</b>
                        <small>{refFileName(r)}</small>
                      </span>
                    ) : (
                      <span className="scene-ref-offmini">
                        <CloudOffIcon />
                      </span>
                    )}
                  </>
                ) : held ? (
                  // 판정 보류 — 서버에 없음과 같게 썸네일을 부르지 않는다(남은 옛 썸네일이 안내를 가리지 않게)
                  <>
                    <span className="scene-refthumb-ph off-server" />
                    {single ? (
                      <span className="scene-ref-offmsg">
                        {held.copy ? <CopyIcon /> : <LinkOffIcon />}
                        <b>{held.title}</b>
                        {held.detail && <span className="scene-ref-why">{held.detail}</span>}
                        <span className="scene-ref-why">{held.fix}</span>
                        <small>{refFileName(r)}</small>
                      </span>
                    ) : (
                      <span className="scene-ref-offmini">{held.copy ? <CopyIcon /> : <LinkOffIcon />}</span>
                    )}
                  </>
                ) : status === "incomplete" ? (
                  // 판정을 못 끝냈다(NAS 끊김 등) — 빨강 아님(없는지 모른다), 다음 시작·찾기 단추에 다시 묻는다
                  <>
                    <span className="scene-refthumb-ph" />
                    {single && (
                      <span className="scene-ref-checkmsg">
                        <PendingIcon />
                        <b>확인 못 함</b>
                        <span>NAS 연결 확인 뒤 레퍼런스 찾기</span>
                        <small>{refFileName(r)}</small>
                      </span>
                    )}
                  </>
                ) : (
                  <MediaThumbnail
                    thumb={refThumbSrc(r)}
                    isVideo={isVid}
                    src={refMediaSrc(r)}
                    fallback={
                      // 그림이 안 뜨는데 서버가 아직 판정 전이면 '확인 중'(아무 말 없는 빗금은 판정 전에만 남긴다)
                      !single || refJudged(workspaceId, r) ? (
                        <span className="scene-refthumb-ph" />
                      ) : (
                        <>
                          <span className="scene-refthumb-ph" />
                          <span className="scene-ref-checkmsg">
                            <PendingIcon />
                            <b>확인 중…</b>
                            <small>{refFileName(r)}</small>
                          </span>
                        </>
                      )
                    }
                    onError={() => onBroken?.(r)}
                    retrySrcOnThumbError
                  />
                )}
                {unlinked ? null : isVid ? (
                  <span className="scene-refthumb-vid vid">▶</span>
                ) : refMediaType(r) === "audio" ? (
                  <span className="scene-refthumb-vid aud">♪</span>
                ) : null}
                {status === "local" && (
                  <span
                    className="scene-ref-offmark"
                    role="img"
                    aria-label="서버에 없음"
                    title="서버에 없음 — 이 PC 에만 있어 다른 사람에게는 안 보입니다"
                  >
                    <CloudOffIcon />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <span
        className="scene-port out"
        onMouseDown={(e) => onOutPortDown(e, card.id)}
        title="드래그해 생성 카드에 연결"
      />
    </>
  );
}
