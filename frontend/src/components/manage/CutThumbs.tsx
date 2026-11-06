// 카드/행의 컷 썸네일 — 최종(★)→공유(↗)→일반 순(백엔드 정렬)에서 최대 3장.
// 시퀀스 자동 귀속분은 ✕(해제) 없음(태그로 들어온 것). 수동 드래그 링크(linked)만 ✕로 뺀다.
// 비디오는 poster 가 없어도 <video>(MediaThumbnail)로 첫 프레임을 보여준다(라이브러리와 동일).
import { MediaThumbnail } from "../MediaThumbnail";
import { useT } from "../../lib/i18n";
import { cutHasPreview, cutLocalId, privateCutLabel } from "./taskPreviews";
import { CUT_THUMB_MAX, type Task, type WorkViewProps } from "./types";

export function CutThumbs({
  task,
  thumb,
  disabled,
  readOnly = false,
  myUid,
  onUnlinkGen,
  privateBelow = false,
}: {
  task: Task;
  thumb: WorkViewProps["thumb"];
  disabled?: Set<string>; // d 로 비활성화된 컷 → 회색 표시
  readOnly?: boolean;
  myUid?: string | null;
  onUnlinkGen: WorkViewProps["onUnlinkGen"];
  privateBelow?: boolean; // 표: '미공유 N개' 같은 글을 썸네일 줄 아래로 — 생성물 칸이 좁아져 설명 칸이 넓어진다(2026-11-05 Jay A안)
}) {
  const t = useT();
  const cuts = task.cuts || [];
  if (!cuts.length) return <span className="work-cut-empty">컷 드롭</span>;
  const visible = cuts.filter(cutHasPreview);
  const shown = visible.slice(0, CUT_THUMB_MAX);
  const extra = visible.length - shown.length;
  const privateLinked = cuts.filter((cut) => !cutHasPreview(cut) && cut.linked &&
    !cut.id.startsWith("fact:") && !readOnly);
  const privateLinkedIds = new Set(privateLinked.map((cut) => cut.id));
  const privateCounts = new Map<string, number>();
  for (const cut of cuts.filter((item) => !cutHasPreview(item))) {
    if (privateLinkedIds.has(cut.id)) continue;
    const label = privateCutLabel(cut, myUid);
    privateCounts.set(label, (privateCounts.get(label) || 0) + 1);
  }
  const privates = (
    <>
      {[...privateCounts].map(([label, count]) => (
        <span key={label} className="work-cut-private" title={t(label)}>
          {t("{label} {count}개").replace("{label}", t(label)).replace("{count}", String(count))}
        </span>
      ))}
      {privateLinked.map((cut) => <span key={cut.id} className="work-cut-private">
        {t(privateCutLabel(cut, myUid))}
        <button className="work-cut-private-unlink" title="연결 해제(수동)"
          onClick={() => onUnlinkGen(task.id, cut.id)}>✕</button>
      </span>)}
    </>
  );
  const hasPrivates = privateCounts.size > 0 || privateLinked.length > 0;
  const row = (
    <div className="work-cut-thumbs">
      {shown.map((c) => {
        const isVideo = c.media_type === "video";
        const th = thumb(c.thumb, c.file_path, c.media_type);
        const localId = cutLocalId(c);
        const off = !!localId && disabled?.has(localId);
        const held = !!c.shared && !c.is_final && !!c.is_held;
        const cls =
          "work-cut" +
          (c.is_final ? " final" : c.shared ? " shared" : "") +
          (off ? " deactivated" : "");
        return (
          <span
            key={c.id}
            className={cls}
            title={off ? "비활성화됨" : c.is_final ? "최종" : held ? t("보류") : c.shared ? "공유됨" : undefined}
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
            ) : held ? (
              <span className="work-cut-badge held" title={t("보류")}>
                S
              </span>
            ) : c.shared ? (
              <span className="work-cut-badge shared" title="공유됨">
                ↗
              </span>
            ) : null}
            {c.linked && !c.id.startsWith("fact:") && !readOnly ? (
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
      {!privateBelow && privates}
    </div>
  );
  if (!privateBelow || !hasPrivates) return row;
  return (
    <>
      {row}
      <div className="work-cut-privates">{privates}</div>
    </>
  );
}
