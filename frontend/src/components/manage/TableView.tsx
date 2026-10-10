// 테이블 뷰 — Notion 데이터베이스식. 시퀀스·마감·설명만 인라인 편집, 컷 셀은 생성물 드롭 타깃.
// 행 체크박스로 다중선택(하단 선택바에서 삭제), 드래그 핸들(⠿)로 순서 변경. 격자선으로 표 가독성.
// 생성자는 실제 생성자(연결 컷 파생)만 — 수동 담당 배정 개념은 폐기됨(2026-08-21).
import { Fragment, useEffect, useRef, useState } from "react";
import { fmtElapsed } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ColorTag } from "./ColorTag";
import { CutThumbs } from "./CutThumbs";
import { taskModelUsage } from "./personalWork";
import { HoverMetric } from "./WorkspaceUsageDashboard";
import {
  GEN_MIME,
  statusColor,
  statusLabel,
  taskIsReadOnly,
  workActivityStatusLabel,
  newDescDraftStore,
  type DescDraftStore,
  type Task,
  type WorkViewProps,
} from "./types";

const ROW_MIME = "application/x-work-row"; // 행 순서변경 드래그 키(생성물 드롭과 구분)

// YYYY-MM-DD → M/D(월/일). 기간 표시용 짧은 포맷.
function fmtMD(d?: string | null): string {
  if (!d) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  return m ? `${+m[2]}/${+m[3]}` : d;
}

export function TableView(props: WorkViewProps) {
  const {
    tasks,
    seqOptions,
    thumb,
    disabled,
    colorMap,
    readOnly,
    selected,
    onToggleSelect,
    onToggleSelectAll,
    onReorder,
    onPatch,
    onLinkGen,
    onUnlinkGen,
    descDrafts,
  } = props;
  useT(); // 언어 토글 시 상태 라벨 리렌더
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const commitText = (t: Task, value: string) => onPatch(t.id, { description: value }); // 보낼지 말지는 칸(DescCell)이 정한다

  const allIds = tasks.filter((task) => !taskIsReadOnly(task, readOnly)).map((t) => t.id);
  const allSelected = allIds.length > 0 && allIds.every((id) => selected?.has(id));
  const toggleDetails = (id: string) =>
    setExpanded((previous) => {
      const next = new Set(previous);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="manage-table-wrap" tabIndex={0}>
      <table className="manage-table work-table work-table-grid">
        <thead>
          <tr>
            <th className="work-sel-col">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={!allIds.length}
                onChange={(e) => onToggleSelectAll?.(allIds, e.target.checked)}
                title="전체 선택"
              />
            </th>
            <th>프로젝트</th>
            <th>에피소드</th>
            <th>시퀀스</th>
            <th>생성물</th>
            <th>생성자</th>
            <th>상태</th>
            <th>크레딧</th>
            <th>생성시간</th>
            <th>생성기간</th>
            <th>설명</th>
            <th>코멘트</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const isSel = !!selected?.has(t.id);
            const modelUsage = taskModelUsage(t);
            const stateColor = statusColor(t.status);
            const detailsOpen = expanded.has(t.id);
            const locked = taskIsReadOnly(t, readOnly);
            const detailId = `work-detail-${t.id}`;
            return (
              <Fragment key={t.id}>
              <tr
                className={(isSel ? "work-row-sel" : "") + (t.archived ? " work-row-archived" : "")}
                onDragOver={(e) => {
                  if (!locked && e.dataTransfer.types.includes(ROW_MIME)) e.preventDefault();
                }}
                onDrop={(e) => {
                  if (locked) return;
                  if (!e.dataTransfer.types.includes(ROW_MIME)) return;
                  const src = e.dataTransfer.getData(ROW_MIME);
                  if (src && src !== t.id) onReorder?.(src, t.id);
                }}
              >
                <td className="work-sel-col">
                  <span
                    className="work-row-handle"
                    draggable={!locked}
                    title={locked ? "읽기 전용 작업" : "드래그해 순서 변경"}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(ROW_MIME, t.id);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                  >
                    ⠿
                  </span>
                  <input
                    type="checkbox"
                    checked={isSel}
                    disabled={locked}
                    onChange={() => onToggleSelect?.(t.id)}
                  />
                  <button
                    type="button"
                    className="work-mobile-detail-btn"
                    aria-expanded={detailsOpen}
                    aria-controls={detailId}
                    aria-label={`${t.project_name || "프로젝트"} ${t.name} ${t.sequence || ""} 상세`}
                    title={detailsOpen ? "상세 접기" : "상세 펼치기"}
                    onClick={() => toggleDetails(t.id)}
                  >
                    {detailsOpen ? "▴" : "▾"}
                  </button>
                </td>
                <td>
                  <ColorTag field="project" value={t.project_name} colorMap={colorMap} plainClass="work-proj-static" />
                </td>
                <td>
                  {/* 에피소드(작업명) — 폴더 구조에서 받아온 정보라 읽기전용. */}
                  <ColorTag
                    field="episode"
                    value={t.name}
                    colorMap={colorMap}
                    plainClass="work-name-static"
                    title={t.folder_path || t.name}
                  />
                </td>
                <td>
                  {t.folder_path ? (
                    // 시퀀스도 프로젝트/에피소드처럼 평문(색 지정 시 색 라벨).
                    <ColorTag
                      field="sequence"
                      value={t.sequence || t.name}
                      colorMap={colorMap}
                      plainClass="work-seq-plain"
                      title={t.folder_path}
                    />
                  ) : (
                    <select
                      className="work-cell-sel"
                      value={t.sequence || ""}
                      disabled={locked}
                      onChange={(e) => onPatch(t.id, { sequence: e.target.value })}
                    >
                      <option value="">—</option>
                      {seqOptions.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td
                  className="work-cut-cell"
                  onDragOver={(e) => {
                    if (!locked && e.dataTransfer.types.includes(GEN_MIME)) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    if (locked) return;
                    const gid = e.dataTransfer.getData(GEN_MIME);
                    if (gid) onLinkGen(t.id, gid);
                  }}
                >
                  <CutThumbs
                    task={t}
                    myUid={props.myUid}
                    thumb={thumb}
                    disabled={disabled}
                    readOnly={locked}
                    onUnlinkGen={onUnlinkGen}
                  />
                </td>
                <td className="work-creators">
                  {/* 실제 생성자(연결 컷 파생)만. */}
                  {t.creators?.length
                    ? t.creators.map((c, i) => (
                        <span key={c}>
                          {i > 0 && " "}
                          <ColorTag field="creator" value={c} colorMap={colorMap} />
                        </span>
                      ))
                    : "—"}
                </td>
                <td>
                  {/* 상태 — 기존 색을 유지한 텍스트 배지. 자동 폴더 작업은 생성·공유·완료로 읽는다. */}
                  <span
                    className="work-status-badge"
                    title={statusLabel(t.status)}
                    style={{ color: stateColor, backgroundColor: `${stateColor}22` }}
                  >
                    {workActivityStatusLabel(t.status)}
                  </span>
                  {t.workspace_unresolved && (
                    <span className="work-readonly-badge" title="기존 기록의 워크스페이스를 확인해야 합니다">
                      귀속 확인 필요
                    </span>
                  )}
                  {t.workspace_historical && (
                    <span className="work-readonly-badge" title="과거 워크스페이스 기록">
                      읽기 전용
                    </span>
                  )}
                  {!!t.archived && (
                    <span className="work-readonly-badge work-archived-badge" title="보관 처리된 작업 — 보관 기록에서만 표시됩니다">
                      보관됨
                    </span>
                  )}
                </td>
                <td className="work-credit-cell">
                  <HoverMetric
                    value={t.credits || 0}
                    rows={modelUsage}
                    metric="both"
                    title="모델별 생성·크레딧"
                    suffix=" cr"
                  />
                </td>
                <td>{fmtElapsed(t.elapsed)}</td>
                <td>
                  {/* 마감일 — PM 입력값 우선, 없으면 연결 생성물의 최종 생성일 자동 표시.
                      아래에 시작~끝(생성일 범위) 기간을 함께 보여 시퀀스 진행 폭을 파악. */}
                  <input
                    className="work-cell-in"
                    type="date"
                    value={t.due_date || t.derived_due || ""}
                    disabled={locked}
                    onChange={(e) => onPatch(t.id, { due_date: e.target.value })}
                  />
                  {t.derived_start && t.derived_due && (
                    <div className="work-period" title="연결 생성물의 생성일 범위">
                      {fmtMD(t.derived_start)}
                      {t.derived_start !== t.derived_due ? ` ~ ${fmtMD(t.derived_due)}` : ""}
                    </div>
                  )}
                </td>
                <td>
                  <DescCell task={t} disabled={locked} onCommit={commitText} drafts={descDrafts} />
                </td>
                <td>{t.comment_count ? `💬 ${t.comment_count}` : "—"}</td>
              </tr>
              {detailsOpen && (
                <tr
                  id={detailId}
                  className={"work-mobile-detail-row" + (t.archived ? " work-row-archived" : "")}
                >
                  <td colSpan={12}>
                    <div className="work-mobile-detail-grid">
                      <div>
                        <span className="work-mobile-detail-label">생성시간</span>
                        <b>{fmtElapsed(t.elapsed)}</b>
                      </div>
                      <div>
                        <span className="work-mobile-detail-label">생성기간</span>
                        <input
                          className="work-cell-in"
                          type="date"
                          value={t.due_date || t.derived_due || ""}
                          disabled={locked}
                          onChange={(e) => onPatch(t.id, { due_date: e.target.value })}
                        />
                        {t.derived_start && t.derived_due && (
                          <div className="work-period" title="연결 생성물의 생성일 범위">
                            {fmtMD(t.derived_start)}
                            {t.derived_start !== t.derived_due
                              ? ` ~ ${fmtMD(t.derived_due)}`
                              : ""}
                          </div>
                        )}
                      </div>
                      <label className="work-mobile-detail-wide">
                        <span className="work-mobile-detail-label">설명</span>
                        <DescCell task={t} disabled={locked} onCommit={commitText} drafts={descDrafts} />
                      </label>
                      <div>
                        <span className="work-mobile-detail-label">코멘트</span>
                        <b>{t.comment_count ? `${t.comment_count}개` : "없음"}</b>
                      </div>
                    </div>
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// 설명 칸 — 치는 동안의 글은 이 칸의 초안이다. 칸을 벗어나면 저장하고(Enter), Esc 는 고치던 것을 버린다(전파를 멈춰 창을 닫지 않는다).
//  규칙(하나하나 tests/taskHoldViews 에 시험이 있다 — 2026-10-10 조작 점검, Codex 코드 리뷰와 격리 브라우저 실측을 여러 번 거쳤다):
//  ① 고친 칸만 초안을 쥔다 — 쥐고 있지 않은 칸은 목록의 값을 그대로 보인다. 초점만 두고 안 고친 칸이 옛 글을 쥐고 있으면,
//     벗어날 때 그 글이 저장돼 그사이 남이 바꾼 값을 되돌린다.
//  ② 고친 글은 그 저장이 성공할 때까지 쥔다 — 응답을 기다리는 동안 목록이 새로 와도 덮지 않는다.
//  ③ 저장이 실패하면 글을 남기고 '저장 안 됨'과 [다시 저장]을 보인다(Jay 결정 2026-10-10). 다시 벗어나도 한 번 더 보낸다.
//     그 줄이 잠기면(읽기 전용) [다시 저장] 자리에 [버리기]를 보인다 — 입력칸이 잠겨 Esc 도 못 치므로 표시를 걷을 길이 그것뿐이다.
//  ④ 목록 값과 같은 글은 보내지 않는다(고쳤다가 되돌린 글이 남의 변경을 되돌리지 않게) — 단, **목록 값을 믿을 수 있을 때만**.
//     이 작업에 저장을 보낸 뒤에는, 가는 중인 저장이 없는 채로 목록이 새로 올 때까지 믿지 않는다(store.stale). 그 사이의 목록 값은
//     옛 글이라, 그 글로 되돌린 것을 안 보내면 마지막에 친 글이 앞 저장에 덮인다. 못 믿는 동안은 같아 보여도 보낸다.
//     실패한 저장은 결과(표시)가 먼저 와도 복구 조회가 끝날 때까지 '가는 중'이다 — 그 틈은 WorkBoard 의 onPatch 가 flying 을 대신 세어
//     잇는다. 결과를 받는 자리에서 보호까지 풀면, 복구 도중 도착한 옛 목록이 믿음을 되살린다(tests/workBoardStale 에 시험).
//     '서버에 간 글'을 따로 적어 견주지는 않는다 — 늦게 온 성공 응답이 더 새 목록 값을 덮는 길이 생긴다(한 번 그렇게 했다가 뺐다).
//  ⑤ 아직 서버에 없는 글은 표 밖의 보관함(store.drafts)에 **가장 최근에 친 글**로 적어 둔다 — 보기 전환·검색으로 이 줄이 화면에서
//     빠졌다 돌아오면 칸이 새로 만들어지는데, 그때 글과 표시가 사라졌다(격리 실측 3/3). 항목에는 편집 번호(rev)가 있고 저장 응답은
//     자기 번호의 항목만 고친다(글자가 같아도 옛 응답이 새 편집을 건드리지 않게). ④의 '믿을 수 있나'·'가는 중인 저장'도 보관함에
//     작업별로 둔다 — 새로 만들어진 칸도 앞 칸이 보낸 저장을 안다.
//  ⑥ 보관함이 바뀌면 그 작업의 칸들에게 바로 알린다(store.listeners) — 쥐고 있던 글이 보관함에 없으면(그 글의 주인이 저장했거나
//     버렸다) 놓고, 더 새 글이 있으면 따라 보이고, 같은 글의 실패 여부가 바뀌었으면 표시를 맞춘다. 같은 작업의 칸이 둘(본 줄·상세 줄)
//     이어도, 저장이 가는 중에 새로 만들어진 칸이어도 어긋나지 않는다. 목록이 새로 오기를 기다리면 안 된다 — 내용이 같은 목록은 줄
//     객체가 그대로라 다시 그려지지 않는다(격리 실측: 실패 표시가 42초가 지나도 안 붙었다).
//  ⑦ 보내기 직전에도 본다 — 이 칸의 글이 보관함의 가장 최근 글이 아니면(다른 칸이 그사이 고쳤다) 보내지 않고 보관함을 따른다.
//     안 그러면 옛 글을 쥔 칸이 벗어나면서 그 글을 새 글 뒤에 보내 덮는다.
let descDraftRev = 0; // 보관함 항목의 편집 번호 — 칸을 가리지 않고 늘 오른다
function DescCell({ task, disabled, onCommit, drafts }: {
  task: Task;
  disabled: boolean;
  onCommit: (task: Task, value: string) => Promise<boolean> | boolean | void;
  drafts?: DescDraftStore;
}) {
  const own = useRef<DescDraftStore | null>(null);
  const store = drafts ?? (own.current ??= newDescDraftStore()); // 보관함을 안 받은 곳(이 칸 혼자)은 제 것을 쓴다
  const taskId = task.id;
  const kept = store.drafts.get(taskId);
  const [draft, setDraft] = useState(kept?.text ?? "");
  const [holding, setHolding] = useState(!!kept); // 서버에 없는 글을 쥐고 있나(②) — 아니면 목록의 값을 그대로 보인다(①)
  const [unsaved, setUnsaved] = useState(!!kept?.failed); // 쥔 글의 저장이 실패했다(③)
  const dirty = useRef(!!kept); // holding 의 거울 — 콜백이 읽는다
  const failed = useRef(!!kept?.failed); // unsaved 의 거울
  const rev = useRef(kept?.rev ?? 0); // 이 칸이 쥔 글의 편집 번호(보관함 항목과 같은 번호)
  const edit = useRef(0); // 이 칸의 편집 번호 — 글을 치거나 버릴 때마다 오른다. 늦게 온 옛 저장의 결과를 지금 글에 적용하지 않는다
  const sent = useRef(-1); // 응답을 기다리는 이 칸의 저장의 편집 번호(-1 = 없다) — 그동안은 보관함과 맞추기를 미룬다
  const hold = (on: boolean) => {
    dirty.current = on;
    setHolding(on);
  };
  const mark = (on: boolean) => {
    failed.current = on;
    setUnsaved(on);
  };
  const tell = () => {
    for (const listener of [...store.listeners]) listener(taskId); // ⑥
  };
  // ⑥ 보관함과 맞춘다. 이 칸이 직접 친 글은 늘 보관함에 같은 번호로 있다 — 없거나 번호가 다르면 이 칸의 글은 낡았다.
  const follow = () => {
    const entry = store.drafts.get(taskId);
    if (!entry) {
      if (dirty.current) {
        hold(false);
        mark(false);
      }
    } else if (entry.rev !== rev.current) {
      rev.current = entry.rev;
      setDraft(entry.text);
      hold(true);
      mark(entry.failed);
    } else if (entry.failed !== failed.current) {
      mark(entry.failed);
    }
  };
  const followRef = useRef(follow);
  followRef.current = follow;
  useEffect(() => {
    // 이 칸의 저장이 가는 중이면 그 응답이 정리하므로 기다린다
    const listener = (id: string) => {
      if (id === taskId && sent.current === -1) followRef.current();
    };
    store.listeners.add(listener);
    return () => {
      store.listeners.delete(listener);
    };
  }, [store, taskId]);
  useEffect(() => {
    if (!store.flying.get(taskId)) store.stale.delete(taskId); // 가는 중인 저장이 없는 채로 목록이 새로 왔다 — 다시 믿는다(④)
    if (sent.current === -1) follow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task]);
  const save = () => {
    if (!dirty.current) return; // 쥔 글이 없다
    if (store.drafts.get(taskId)?.rev !== rev.current) {
      follow(); // ⑦ 이 칸의 글은 가장 최근 글이 아니다 — 보내지 않는다
      return;
    }
    if (store.sending.get(taskId) === rev.current) return; // 이 글의 저장이 이미 가는 중이다(이 칸이든 같은 작업의 다른 칸이든)
    const skip = !store.stale.has(taskId) && draft === (task.description || ""); // ④
    const mine = edit.current;
    const mineRev = rev.current;
    sent.current = mine;
    if (!skip) {
      store.stale.add(taskId);
      store.flying.set(taskId, (store.flying.get(taskId) ?? 0) + 1);
      store.sending.set(taskId, mineRev);
    }
    // 같은 작업의 저장은 줄을 서서 보낸 순서대로 간다(WorkBoard 의 taskPatchQueue)
    void Promise.resolve(skip ? true : onCommit(task, draft)).then((ok) => {
      if (!skip) {
        const left = (store.flying.get(taskId) ?? 1) - 1;
        if (left > 0) store.flying.set(taskId, left);
        else store.flying.delete(taskId);
        if (store.sending.get(taskId) === mineRev) store.sending.delete(taskId);
      }
      if (sent.current === mine) sent.current = -1;
      // ⑤ 보관함은 이 편집의 항목일 때만 고친다 — 이 칸이 화면에서 내려간 뒤에 온 응답도 여기까지는 온다
      const entry = store.drafts.get(taskId);
      const owned = !!entry && entry.rev === mineRev;
      if (owned) {
        if (ok === false) store.drafts.set(taskId, { ...entry, failed: true });
        else store.drafts.delete(taskId);
      }
      if (mine === edit.current) {
        // 이 칸이 그사이 다시 고치지도 Esc 로 버리지도 않았다 — 이 결과가 지금 글의 것이다
        hold(ok === false);
        mark(ok === false);
      }
      if (owned) tell();
      if (sent.current === -1) follow(); // 가는 동안 미뤄 둔 맞추기
    });
  };
  // 쥔 글을 버린다 — Esc 와 잠긴 줄의 [버리기]가 같이 쓴다. 보관함에서 지우고 같은 작업의 다른 칸에도 알린다(⑥)
  const discard = () => {
    edit.current += 1; // 가는 중인 저장의 결과도 이 칸에 적용하지 않는다
    hold(false);
    mark(false);
    store.drafts.delete(taskId);
    tell();
  };
  return (
    <span className={"work-desc" + (unsaved ? " unsaved" : "")}>
      <input
        className="work-cell-in"
        value={holding ? draft : task.description || ""}
        disabled={disabled}
        placeholder="설명"
        onChange={(e) => {
          edit.current += 1;
          rev.current = ++descDraftRev;
          hold(true);
          setDraft(e.target.value);
          store.drafts.set(taskId, { text: e.target.value, failed: failed.current, rev: rev.current });
          tell();
        }}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") {
            e.stopPropagation();
            discard();
            e.currentTarget.blur();
          }
        }}
      />
      {unsaved && (
        <>
          <span className="work-desc-chip" title="서버에 저장되지 않았습니다 — 새로 고침하면 사라집니다">저장 안 됨</span>
          {/* 잠긴 줄(읽기 전용)은 다시 저장할 수도, 입력칸에서 Esc 를 칠 수도 없다 — 표시를 걷을 길이 없어 같은 자리에 버리기를 준다 */}
          <button type="button" className="work-desc-retry" onClick={disabled ? discard : save}>{disabled ? "버리기" : "다시 저장"}</button>
        </>
      )}
    </span>
  );
}
