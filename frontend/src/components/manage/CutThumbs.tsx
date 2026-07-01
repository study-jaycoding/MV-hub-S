// 카드/행의 컷 썸네일 — 최종(★)→공유(↗)→일반 순(백엔드 정렬)에서 최대 3장.
// 시퀀스 자동 귀속분은 ✕(해제) 없음(태그로 들어온 것). 수동 드래그 링크(linked)만 ✕로 뺀다.
// 비디오는 poster 가 없어도 <video>(MediaThumbnail)로 첫 프레임을 보여준다(라이브러리와 동일).
import { MediaThumbnail } from "../MediaThumbnail";
import { CUT_THUMB_MAX, type Task, type WorkViewProps } from "./types";

export function CutThumbs({
  task,
  thumb,
  onUnlinkGen,
}: {
  task: Task;
  thumb: WorkViewProps["thumb"];
  onUnlinkGen: WorkViewProps["onUnlinkGen"];
}) {
  const cuts = task.cuts || [];
  if (!cuts.length) return <span className="work-cut-empty">컷 드롭</span>;
  const shown = cuts.slice(0, CUT_THUMB_MAX);
  const extra = (task.gen_count ?? cuts.length) - shown.length;
  return (
    <div className="work-cut-thumbs">
      {shown.map((c) => {
        const th = thumb(c.thumb);
        const isVideo = c.media_type === "video";
        const cls =
          "work-cut" + (c.is_final ? " final" : c.shared ? " shared" : "");
        return (
          <span
            key={c.id}
            className={cls}
            title={c.is_final ? "최종" : c.shared ? "공유됨" : undefined}
          >
            <MediaThumbnail
              thumb={th}
              isVideo={isVideo}
              src={isVideo ? c.file_path ?? undefined : undefined}
              fallback={<span className="work-cut-ph" />}
            />
            {c.is_final ? (
              <span className="work-cut-badge final" title="최종">
                ★
              </span>
            ) : c.shared ? (
              <span className="work-cut-badge shared" title="공유됨">
                ↗
              </span>
            ) : null}
            {c.linked ? (
              <button
                className="work-cut-x"
                title="연결 해제(수동)"
                onClick={() => onUnlinkGen(task.id, c.id)}
              >
                ✕
              </button>
            ) : null}
          </span>
        );
      })}
      {extra > 0 && (
        <span className="work-cut-more" title={`외 ${extra}장`}>
          +{extra}
        </span>
      )}
    </div>
  );
}
