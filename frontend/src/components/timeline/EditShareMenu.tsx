// 편집 공유(Jay 2026-10-23 — 모의 그림 _shots/mock_edit1023_share_edit.png) — '나만 보는 편집' 알약을 목록으로: 나만 보는 편집 · 서버에 저장 ·
//  다른 편집 보기(따로 켜기). 서버에 저장 = 지금 보이는 것(lib/editShare 의 스냅샷)을 공유 서버에 한 벌 — 바뀌면 라임, 누르면 다시 저장.
//  다른 편집 보기 = 'V0 · 이름' 알약 + V1 아래 V0 줄(EditTimeline) — 그 사람이 다시 저장하면 라임, 누르면 최신. 저절로 보내거나 바꾸지 않는다.
//  규칙의 정본: docs/status/편집탭_편집공유_설계_2026-10-23.md(§4~6) · 계약 docs/status/편집탭_편집공유_구현_2026-10-23.md.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type EditShareRow } from "../../api";
import { getAccountNamespace } from "../../lib/accountScope";
import { parseShareSnapshot, sha256Hex, shareLayout, shareSnapshot, type ShareLayout } from "../../lib/editShare";
import type { EditDoc, EditLayout } from "../../lib/editTimeline";
import { HttpError, isRouteMissing } from "../../lib/http";
import { useT } from "../../lib/i18n";
import { loadJSON, saveJSON } from "../../lib/storage";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { EditMenu } from "./EditTrackMenu";

export const POLL_MS = 15_000; // 팀 목록과 같은 주기 — 다른 사람의 새 저장을 이만큼 늦게 안다(새 WS 종류는 두지 않는다)

export interface ShareUi {
  mode: "mine" | "server";
  others: boolean; // 다른 편집 보기
  owner: string | null; // V0 에 고른 사람의 열쇠(서버의 owner_key)
  color: string | null; // V0 트랙 색
  confirmed: { revision: number; hash: string } | null; // 서버가 확인해 준 내 것 — 라임 판정의 기준
}
const DEFAULT_UI: ShareUi = { mode: "mine", others: false, owner: null, color: null, confirmed: null };
export type ShareError = "missing" | "login" | "denied" | "noserver" | "account" | "offline" | "other";
const NOT_CONNECTED = "공유 서버에 로그인하지 않아 서버에 저장할 수 없습니다"; // routers/edit_shares.NOT_CONNECTED

export function shareErrorOf(error: unknown): ShareError {
  if (isRouteMissing(error)) return "missing";
  if (!(error instanceof HttpError)) return "offline";
  if (error.status === 401) return "login";
  if (error.status === 403) return "denied";
  if (error.status === 409) return error.detail === NOT_CONNECTED ? "noserver" : "account";
  return error.status === 502 || error.status === 504 ? "offline" : "other";
}
export const ERROR_TEXT: Record<ShareError, string> = {
  missing: "서버가 아직 이 기능을 모릅니다 — 공유 서버 업데이트가 필요합니다",
  login: "공유 서버 로그인이 필요합니다",
  denied: "이 프로젝트의 편집 공유를 볼 권한이 없습니다",
  noserver: NOT_CONNECTED,
  account: "화면과 허브의 계정이 달라 멈췄습니다 — 새로 고쳐 주세요",
  offline: "공유 서버에 연결하지 못했습니다",
  other: "편집 공유를 처리하지 못했습니다",
};

export interface V0State {
  scope: string; // 받은 문맥(계정·서버·프로젝트·시퀀스) — 문맥이 바뀐 첫 화면에도 옛 V0 을 내보이지 않는다
  key: string;
  revision: number;
  share: ShareLayout | null; // null = 읽지 못함
}

// 편집 공유의 상태·요청 — scope(계정·서버·프로젝트·시퀀스)가 바뀌면 화면 상태를 그 시퀀스의 것으로 바꾸고 늦게 온 응답은 버린다.
export function useEditShare({ scope, target, layout, doc, flash }: {
  scope: string | null; // `${authKey}:${projectId}:${seq}` — 없으면(시퀀스 안 고름) 꺼져 있다
  target: { projectId: string; seq: string } | null;
  layout: EditLayout;
  doc: EditDoc;
  flash: (message: string) => void;
}) {
  const t = useT();
  const storageKey = scope ? `${STORAGE_KEYS.editShare}:${scope}` : null;
  const [ui, setUi] = useState<ShareUi>(DEFAULT_UI);
  const [rows, setRows] = useState<EditShareRow[]>([]);
  const [saveError, setSaveError] = useState<ShareError | null>(null);
  const [readError, setReadError] = useState<ShareError | null>(null); // 목록·V0 읽기 실패 — 있는 동안 V0 을 쓰지 않는다(권한 상실·읽기 실패)
  const [saving, setSaving] = useState(false);
  const [v0, setV0] = useState<V0State | null>(null);
  const ctx = useRef(0); // 문맥 번호 — 바뀌면 늦게 온 응답을 버린다
  const loadSeq = useRef(0); // V0 본문 요청 번호 — 마지막 것만 받는다(목록 읽기가 실패해도 올려 도는 본문을 버린다)
  const uiRef = useRef(ui);
  uiRef.current = ui;
  useEffect(() => {
    ctx.current += 1;
    setUi(storageKey ? { ...DEFAULT_UI, ...(loadJSON<Partial<ShareUi>>(storageKey) ?? {}) } : DEFAULT_UI);
    setRows([]);
    setSaveError(null);
    setReadError(null);
    setV0(null);
    setSaving(false);
  }, [storageKey]);
  const patch = useCallback((next: Partial<ShareUi>) => {
    setUi((prev) => {
      const merged = { ...prev, ...next };
      if (storageKey) saveJSON(storageKey, merged);
      return merged;
    });
  }, [storageKey]);
  // 확인된 내 것 — revision 이 지금 것보다 클 때만. 비교를 갱신 안에서 한다(저장 응답·목록 응답이 한 화면 사이에 잇달아 와도 최신 값과 견준다).
  const confirm = useCallback((revision: number, hash: string) => {
    setUi((prev) => {
      if (prev.confirmed && revision <= prev.confirmed.revision) return prev;
      const merged = { ...prev, confirmed: { revision, hash } };
      if (storageKey) saveJSON(storageKey, merged);
      return merged;
    });
  }, [storageKey]);

  // 지금 보이는 것 — 보낼 글자와 그 hash(비동기로 잰다)
  const text = useMemo(() => {
    const snap = shareSnapshot(layout, doc);
    return snap ? JSON.stringify(snap) : null;
  }, [layout, doc]);
  const [hashed, setHashed] = useState<{ text: string; hash: string } | null>(null);
  useEffect(() => {
    if (!text) return;
    let live = true;
    void sha256Hex(text).then((hash) => live && setHashed({ text, hash }));
    return () => { live = false; };
  }, [text]);
  const hash = hashed && hashed.text === text ? hashed.hash : null;
  const dirty = ui.mode === "server" && !!text && (!ui.confirmed || (hash !== null && hash !== ui.confirmed.hash));
  const unchanged = !!ui.confirmed && hash !== null && hash === ui.confirmed.hash; // 재는 중(hash 없음)은 '바뀐 것 없음'이 아니다

  // 저장 — 저절로 보내지 않는다(누를 때만). 응답은 요청 번호로 묶어 늦게 온 옛 응답을 버린다.
  const saveSeq = useRef(0);
  const save = useCallback(async () => {
    if (!target || !text) return;
    const sent = text;
    const expect = getAccountNamespace(); // 누른 순간의 계정 — 재는 사이 바뀌면 허브가 거절한다(A 의 편집이 B 이름으로 올라가지 않게)
    const mine = ++saveSeq.current;
    const at = ctx.current;
    setSaving(true);
    try {
      const sentHash = await sha256Hex(sent);
      if (at !== ctx.current || mine !== saveSeq.current) return; // 재는 사이 문맥이 바뀌었거나 새 저장이 나갔다 — 보내지 않는다
      const head = await api.saveEditShare({ project_id: target.projectId, seq: target.seq, data: sent }, expect);
      if (at !== ctx.current || mine !== saveSeq.current) return;
      setSaveError(null);
      if (head.data_hash === sentHash) confirm(head.revision, head.data_hash);
    } catch (caught) {
      if (at !== ctx.current || mine !== saveSeq.current) return;
      const kind = shareErrorOf(caught);
      setSaveError(kind);
      flash(t(ERROR_TEXT[kind]));
    } finally {
      if (at === ctx.current && mine === saveSeq.current) setSaving(false);
    }
  }, [target, text, confirm, flash, t]);
  const saveNow = useCallback(() => {
    if (unchanged) return flash(t("저장됨 — 바뀐 것 없음"));
    void save();
  }, [unchanged, save, flash, t]);
  const setMode = useCallback((mode: ShareUi["mode"]) => {
    patch({ mode });
    if (mode === "server") void save(); // 고르면 바로 한 번 저장
  }, [patch, save]);

  // 목록 — '서버에 저장' 방식이거나 다른 편집 보기가 켜져 있으면 15초마다 + 창 초점이 돌아올 때. 하나가 도는 동안 다음을 보내지 않는다.
  const active = !!target && (ui.mode === "server" || ui.others);
  const busy = useRef(false);
  const poll = useCallback(async () => {
    if (!target || busy.current) return;
    busy.current = true;
    const at = ctx.current;
    try {
      const list = await api.listEditShares(target.projectId, target.seq, getAccountNamespace());
      if (at !== ctx.current) return;
      setReadError(null);
      setRows(list);
      const mine = list.find((row) => row.mine);
      if (mine) confirm(mine.revision, mine.data_hash); // 다른 창이 저장했어도 따라온다
    } catch (caught) {
      if (at !== ctx.current) return;
      // 읽기 실패 — 받아 둔 V0 을 버리고 도는 본문 요청도 버린다(실패 전에 나간 본문이 늦게 성공해 오류를 지우지 못하게). 풀리면 본문을 다시 받는다.
      loadSeq.current += 1;
      setV0(null);
      setReadError(shareErrorOf(caught));
    } finally {
      busy.current = false;
    }
  }, [target, confirm]);
  useEffect(() => {
    if (!active) return;
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, poll]);

  // V0 — 고른 사람의 것을 받는다(고를 때·누를 때·다시 열 때·읽기 실패가 풀릴 때). 받은 본문은 남기지 않는다(다시 열면 최신).
  //  마지막 요청의 응답만 받고, 같은 사람의 더 새 revision 을 옛 것으로 되돌리지 않는다.
  const load = useCallback(async (key: string) => {
    if (!target || !storageKey) return;
    const at = ctx.current;
    const mine = ++loadSeq.current;
    try {
      const got = await api.getEditShare(target.projectId, target.seq, key, getAccountNamespace());
      if (at !== ctx.current || mine !== loadSeq.current || uiRef.current.owner !== key) return;
      const snap = got.data === null ? null : parseShareSnapshot(got.data);
      const revision = got.data === null ? 0 : got.revision;
      setV0((prev) => (prev && prev.scope === storageKey && prev.key === key && prev.revision > revision ? prev
        : { scope: storageKey, key, revision, share: snap ? shareLayout(snap) : null }));
      setReadError(null);
    } catch (caught) {
      if (at !== ctx.current || mine !== loadSeq.current || uiRef.current.owner !== key) return;
      setV0(null);
      setReadError(shareErrorOf(caught));
    }
  }, [target, storageKey]);
  // held = 이 문맥에서 마지막으로 받은 것(사람을 바꾸는 동안은 앞 사람의 것) · current = 지금 고른 사람의 것
  const held = v0 && v0.scope === storageKey ? v0 : null;
  const current = held && held.key === ui.owner ? held : null;
  useEffect(() => {
    if (ui.others && ui.owner && !current && !readError) void load(ui.owner);
  }, [ui.others, ui.owner, current, readError, load]);
  const unnamed = t("이름 없는 작업자");
  const others = rows.filter((row) => !row.mine).map((row) => (row.name ? row : { ...row, name: unnamed }));
  const ownerRow = others.find((row) => row.key === ui.owner) ?? null;
  const newer = !!ownerRow && !!current && ownerRow.revision > current.revision;
  const pickOwner = useCallback((key: string) => patch({ owner: key }), [patch]); // 앞 사람의 것은 새 사람의 것이 올 때까지 끝(tail)만 쥔다
  const refreshV0 = useCallback(() => {
    if (ui.owner) void load(ui.owner);
  }, [ui.owner, load]);
  const usable = ui.others && !readError;

  return {
    ui, patch, rows: others, error: readError ?? saveError, readError, saving, dirty, saveNow, setMode,
    v0: usable ? current : null,
    tail: usable ? held?.share?.layout.total ?? 0 : 0, // 재생 범위의 끝(EditTab — 내 것보다 길면 빈 꼬리)
    ownerName: ownerRow?.name ?? null, newer, pickOwner, refreshV0,
    toggleOthers: () => {
      if (ui.others) { // 끄면 버린다(도는 본문 요청도) — 다시 켜면 최신을 받는다
        loadSeq.current += 1;
        setV0(null);
      }
      patch({ others: !ui.others });
    },
  };
}
export type EditShare = ReturnType<typeof useEditShare>;

// 저장 시각 글자 — '10-23 14:20'
export function shareTime(at: string): string {
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return "";
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(time.getMonth() + 1)}-${two(time.getDate())} ${two(time.getHours())}:${two(time.getMinutes())}`;
}

// 알약 — 방식 단추(누르면 그 방식의 일: 서버에 저장이면 다시 저장) + ▾ 목록 + 다른 편집 보기 중이면 'V0 · 이름' 알약.
export function EditShareMenu({ share, onOpenWorkers }: { share: EditShare; onOpenWorkers: (x: number, y: number) => void }) {
  const t = useT();
  const caret = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const server = share.ui.mode === "server";
  const openMenu = () => {
    const box = caret.current?.getBoundingClientRect();
    setMenu(menu ? null : { x: box?.left ?? 0, y: (box?.bottom ?? 0) + 4 });
  };
  const item = (checked: boolean, label: string, hint: string, onClick: () => void, role: "menuitemradio" | "menuitemcheckbox") => (
    <button type="button" role={role} aria-checked={checked} className={"ed-tmenu-item ed-share-item" + (checked ? " ed-here" : "")}
      onClick={() => {
        setMenu(null);
        onClick();
      }}>
      <span className="ed-share-check" aria-hidden="true">{checked ? "✓" : ""}</span>
      <span><b>{label}</b><small>{hint}</small></span>
    </button>
  );
  const v0Label = share.ui.owner && share.ownerName ? `V0 · ${share.ownerName}` : t("V0 — 작업자 선택");
  return (
    <span className="ed-share">
      <span className={"ed-mine ed-share-pill" + (share.dirty ? " ed-lime" : "")}>
        <button type="button" className="ed-share-main" disabled={share.saving}
          title={server ? (share.dirty ? t("바뀐 것이 있다 — 누르면 서버에 다시 저장") : t("저장됨 — 바뀐 것 없음"))
            : t("이 편집은 이 브라우저(계정)에만 저장됩니다. 팀에 공유되지 않습니다.")}
          onClick={() => (server ? share.saveNow() : openMenu())}>
          {server ? t("서버에 저장") : t("나만 보는 편집")}
        </button>
        <button ref={caret} type="button" className="ed-share-caret" aria-haspopup="menu" aria-expanded={!!menu} aria-label={t("편집 공유")}
          onClick={openMenu}>▾</button>
      </span>
      {share.ui.others && (
        <button type="button" className={"ed-mine ed-v0chip" + (share.newer ? " ed-lime" : "")}
          title={share.newer ? t("새로 저장됨 — 누르면 최신을 V0 에") : t("V0 작업자 고르기")}
          onClick={(event) => {
            if (share.newer) return share.refreshV0();
            const box = event.currentTarget.getBoundingClientRect();
            onOpenWorkers(box.left, box.bottom + 4);
          }}>
          {v0Label}
        </button>
      )}
      {menu && (
        <EditMenu x={menu.x} y={menu.y} width={300} height={260} label={t("편집 공유")} trigger={caret} onClose={() => setMenu(null)}>
          <div className="ed-tmenu-head">{t("편집 공유")}</div>
          {item(!server, t("나만 보는 편집"), t("이 PC(계정)에만 저장 — 팀에는 안 보인다"), () => share.setMode("mine"), "menuitemradio")}
          {item(server, t("서버에 저장"), t("지금 보는 편집을 서버 DB 에 올린다 — 바뀌면 단추가 라임, 누르면 다시 저장"), () => share.setMode("server"), "menuitemradio")}
          <div className="ed-tmenu-sep" />
          {item(share.ui.others, t("다른 편집 보기"), t("서버에 저장한 다른 작업자의 편집을 V1 아래 V0 트랙에 — 새로 저장되면 단추가 라임"),
            share.toggleOthers, "menuitemcheckbox")}
        </EditMenu>
      )}
    </span>
  );
}
