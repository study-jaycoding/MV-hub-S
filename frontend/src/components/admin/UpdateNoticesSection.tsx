// 관리자 창 · 업데이트 탭 — NAS 의 모든 판을 줄로 보이고, 어느 판이든 [배포] 한 번(알림 + 팀 표지 교체). Jay 2026-10-05.
// 계약 docs/UPDATE_ANNOUNCEMENTS.md: 후보 줄의 [배포]는 기존 promote(후보가 바뀌면 거절), 그 밖의 줄은 deploy-package
// (옛 판이면 팀 되돌리기, 화면이 본 표지·후보가 그새 바뀌면 거절). [재공지]는 알림만 · [배포 반영]은 후보 줄에서만 표지만 ·
// [해제]는 팀원 알림만 거둔다(A안 — 줄은 NAS 라서 남는다). 공지 항목은 sha 로 찾고 없을 때만 등록한다(서버 시각 보존).
// 상태와 API 호출은 이 안에만 둔다 — 탭을 열 때마다(마운트) 새로 읽는다.
import { useEffect, useState } from "react";
import { HttpError } from "../../lib/http";
import {
  deployPackage,
  getLatestReleaseMetadata,
  getPackageManifest,
  getReleaseUpdateStatus,
  listReleasePackages,
  promoteRelease,
  startCandidateUpdate,
  type LatestReleaseMetadata,
  type ReleasePackage,
  type ReleaseUpdateStatus,
} from "../../lib/releaseUpdate";
import { updateNoticeApi, type UpdateNotice } from "../../lib/updateNotices";

const errText = (error: unknown) =>
  error instanceof HttpError ? error.detail : String(error).replace(/^Error:\s*\d+:\s*/, "");
const unconfirmed = (error: unknown) => !(error instanceof HttpError) || error.status >= 500;

const VISIBLE_ROWS = 6;
// 판 이름 = 제작 시각(YYYY.MM.DD-HHMM) — 줄 아래 '10-05 12:52 제작'
const builtAt = (version: string) => {
  const m = /^\d{4}\.(\d{2})\.(\d{2})-(\d{2})(\d{2})$/.exec(version);
  return m ? `${m[1]}-${m[2]} ${m[3]}:${m[4]} 제작` : "";
};

type ReleaseFields = Pick<LatestReleaseMetadata, "version" | "file" | "sha256" | "size" | "created_at">;

export function UpdateNoticesSection() {
  const [overview, setOverview] = useState<LatestReleaseMetadata | null>(null);
  const [overviewError, setOverviewError] = useState("");
  const [packages, setPackages] = useState<ReleasePackage[]>([]);
  const [packagesError, setPackagesError] = useState("");
  const [notices, setNotices] = useState<UpdateNotice[]>([]);
  const [noticeError, setNoticeError] = useState("");
  // 표지·후보의 공지를 단건으로 찾다 실패한 sha(404 '없음'이 아닌 오류) — 그 줄의 공지 상태를 모른다(Codex 코드 리뷰 P2)
  const [lookupFailed, setLookupFailed] = useState<{ shas: string[]; error: string }>({ shas: [], error: "" });
  const [thisPc, setThisPc] = useState<ReleaseUpdateStatus | null>(null); // 이 PC 판 — 먼저 설치 단추·'이 PC 설치됨'
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [showAll, setShowAll] = useState(false);

  const load = async (refreshPc = false) => {
    void getReleaseUpdateStatus(refreshPc).then(setThisPc, () => setThisPc(null));
    const [items, view, rows] = await Promise.all([
      updateNoticeApi.adminList().then(
        (value) => { setNoticeError(""); return value; },
        (error) => { setNoticeError(errText(error)); return [] as UpdateNotice[]; },
      ),
      getLatestReleaseMetadata().then(
        (value) => { setOverviewError(""); return value; },
        (error) => { setOverviewError(errText(error)); return null; },
      ),
      listReleasePackages().then(
        (value) => { setPackagesError(""); return value; },
        (error) => { setPackagesError(errText(error)); return [] as ReleasePackage[]; },
      ),
    ]);
    // 표지·후보의 공지는 최근 5개 밖으로 밀려 있어도 sha 로 찾는다(없으면 404 = 아직 등록 안 됨).
    const wanted = [view?.published?.sha256, view?.source === "candidate" ? view.sha256 : ""]
      .filter((sha): sha is string => Boolean(sha) && !items.some((item) => item.sha256 === sha));
    const failed: string[] = [];
    let failure = "";
    const found = await Promise.all([...new Set(wanted)].map((sha) => updateNoticeApi.adminItem(sha).catch((error) => {
      // 새 서버의 '항목 없음' 404 만 부재다. 옛 서버(Not Found)·권한·연결 오류는 모른다 — '공지 없음'으로 단정하면
      // 이미 공지된 후보에 [배포]가 떠서 알림을 다시 보낸다.
      if (!(error instanceof HttpError && error.status === 404 && error.detail !== "Not Found")) {
        failed.push(sha);
        failure = errText(error);
      }
      return null;
    })));
    setLookupFailed({ shas: failed, error: failure });
    setNotices([...items, ...found.filter((item): item is UpdateNotice => item !== null)]);
    setOverview(view);
    setPackages(rows);
  };
  useEffect(() => {
    void load();
  }, []);

  const run = async (label: string, work: () => Promise<string>) => {
    setBusy(label);
    setMsg("");
    try {
      setMsg(await work());
    } catch (error) {
      setMsg(errText(error));
    } finally {
      await load(true);
      setBusy("");
    }
  };

  const pubSha = overview?.published?.sha256 ?? "";
  const pubFile = overview?.published?.file ?? "";
  const pubVersion = overview?.published?.version ?? "";
  const candSha = overview?.source === "candidate" ? overview.sha256 : "";
  const candFile = overview?.source === "candidate" ? overview.file : "";
  const candidateBlocked = Boolean(overview?.candidate_error);
  // 배포 단추는 두 표지를 모두 확인했을 때만(공개 표지를 못 읽으면 '확인 불가' — 고쳐 쓰지 않는다)
  const deployBlocked = !overview || overview.published_state === "error" || candidateBlocked;

  const noticeFor = (row: ReleasePackage) => {
    const sha = row.file === pubFile ? pubSha : row.file === candFile ? candSha : "";
    // 표지·후보 줄은 sha 까지 같아야 — 그 밖의 줄은 파일명으로 보이기만(해제 대상 표시용)
    return notices.find((item) => item.file === row.file && (!sha || item.sha256 === sha)) ?? null;
  };

  // 공지 항목은 sha 로 찾고, 없을 때만 등록한다 — 재등록이 서버의 released_at 을 덮지 않게(Codex 설계 검토 P2).
  const ensureNotice = async (release: ReleaseFields): Promise<UpdateNotice> => {
    try {
      return await updateNoticeApi.adminItem(release.sha256);
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error;
      if (error.detail === "Not Found") throw new Error("공유 서버를 업데이트한 뒤 사용할 수 있습니다");
    }
    return (await updateNoticeApi.register(release as LatestReleaseMetadata)).item;
  };

  const announceThen = async (
    release: ReleaseFields, deploy: (item: UpdateNotice) => Promise<{ already: boolean; rolled_back?: boolean }>,
  ) => {
    let item: UpdateNotice;
    try {
      item = await ensureNotice(release);
    } catch (error) {
      throw new Error(`등록을 확인하지 못해 공지하지 않았습니다 — ${errText(error)}`);
    }
    try {
      await updateNoticeApi.announce(item.id);
    } catch (error) {
      throw new Error(`공지 결과를 확인할 수 없어 배포하지 않았습니다 — 탭을 다시 열어 확인하세요. 이유: ${errText(error)}`);
    }
    try {
      const result = await deploy(item);
      if (result.already) return `v${release.version} 은(는) 이미 팀에 배포된 판입니다 — 알림만 다시 보냈습니다.`;
      return result.rolled_back
        ? `v${release.version} 으로 되돌렸습니다 — 팀원 PC 에 '업데이트 있음'이 뜹니다.`
        : `v${release.version} 을(를) 팀에 배포했습니다 — 팀원 PC 에 '업데이트 있음'이 뜹니다.`;
    } catch (error) {
      // 500·응답 없음 = 표지 교체 결과를 모른다 — '배포 안 됨'으로 단정하지 않는다(Codex 코드 리뷰). 4xx 는 서버 문구에 단계가 있다.
      return unconfirmed(error)
        ? `알림은 나갔지만 팀 배포 결과를 확인할 수 없습니다 — 업데이트 탭을 다시 열어 확인하세요. 이유: ${errText(error)}`
        : `알림은 나갔지만 팀 배포는 하지 못했습니다 — ${errText(error)}`;
    }
  };

  const candidateFields = (): ReleaseFields | null =>
    overview && overview.source === "candidate"
      ? { version: overview.version, file: overview.file, sha256: overview.sha256, size: overview.size, created_at: overview.created_at }
      : null;

  const deployCandidate = (row: ReleasePackage) => {
    const release = candidateFields();
    if (!release) return;
    if (!window.confirm(`v${row.version} 을(를) 팀에 배포합니다.\n팀원에게 알림이 가고 그 판으로 업데이트됩니다. 계속할까요?`)) return;
    void run(`deploy:${row.file}`, () => announceThen(release, (item) => promoteRelease(item.id, release.sha256)));
  };

  const deployOther = (row: ReleasePackage) => {
    const older = Boolean(pubVersion) && row.version < pubVersion;
    const dropsCandidate = overview?.pending === true && candFile && candFile !== row.file
      ? `\n배포 전 후보 v${overview.version} 는 후보에서 내려옵니다(목록에는 남습니다).` : "";
    const text = older
      ? `v${row.version} 으로 되돌립니다.\n팀원 PC 가 지금(v${pubVersion})보다 옛 판으로 내려갑니다. DB 변경은 되돌아가지 않습니다.`
      : `v${row.version} 을(를) 팀에 배포합니다.\n팀원에게 알림이 가고 그 판으로 업데이트됩니다.`;
    if (!window.confirm(`${text}${dropsCandidate}\n계속할까요?`)) return;
    const [expectPub, expectCand] = [pubSha, candSha]; // 화면이 본 그대로 — 그새 바뀌면 서버가 거절
    void run(`deploy:${row.file}`, async () => {
      setBusy(`hash:${row.file}`);
      const manifest = await getPackageManifest(row.file);
      setBusy(`deploy:${row.file}`);
      return announceThen(manifest, (item) => deployPackage(item.id, manifest.sha256, expectPub, expectCand));
    });
  };

  // [재공지] — 알림만(표지는 그대로, B r3: 되돌린 판이 재공지로 되살아나지 않게). 해제 뒤엔 [공지](등록부터).
  const announceLive = (row: ReleasePackage, notice: UpdateNotice | null) =>
    run(`announce:${row.file}`, async () => {
      let item = notice;
      if (!item) {
        const manifest = await getPackageManifest(row.file);
        if (manifest.sha256 !== pubSha) throw new Error("공개 표지와 설치 파일이 다릅니다 — 탭을 다시 열어 확인하세요");
        item = await ensureNotice(manifest);
      }
      const result = await updateNoticeApi.announce(item.id);
      return `v${row.version} 업데이트를 공지했습니다 (${result.item.announcement_revision}번째) — 배포는 그대로입니다.`;
    });

  const deployAgain = (row: ReleasePackage, notice: UpdateNotice) =>
    run(`deploy:${row.file}`, async () => {
      const result = await promoteRelease(notice.id, candSha);
      return result.already ? `v${row.version} 은(는) 이미 팀에 배포된 판입니다.` : `v${row.version} 을(를) 팀에 배포했습니다.`;
    });

  // 관리자 후보 선설치(2026-10-03) — 공지 전 후보를 이 PC 에만 먼저 설치. 등록은 알림이 아니다(없을 때만 등록).
  const thisPcHas = (row: ReleasePackage) => thisPc?.current_version === row.version;
  const preinstall = (row: ReleasePackage) => {
    const release = candidateFields();
    if (!release) return;
    const again = thisPcHas(row);
    if (!window.confirm(
      `v${row.version} 을(를) 이 PC 에만 ${again ? "다시" : "먼저"} 설치합니다.\n`
      + "팀 배포는 [배포]를 따로 눌러야 합니다(이 설치로 팀원 PC 는 바뀌지 않습니다).\n"
      + "설치 중 프로그램이 다시 시작됩니다. 계속할까요?",
    )) return;
    void run(`preinstall:${row.file}`, async () => {
      const item = await ensureNotice(release);
      await startCandidateUpdate(item.id, release.sha256);
      return `v${row.version} 을(를) 이 PC 에 설치하기 시작했습니다 — 프로그램이 다시 시작됩니다.`;
    });
  };

  const removeNotice = (row: ReleasePackage, notice: UpdateNotice) => {
    if (!window.confirm(`v${row.version} 알림을 팀원 알림 목록에서 거둡니다.\n배포된 판과 이 줄은 그대로입니다.`)) return;
    void run(`remove:${row.file}`, async () => {
      try {
        await updateNoticeApi.remove(notice.id);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) throw new Error("공유 서버를 업데이트한 뒤 사용할 수 있습니다");
        throw error;
      }
      return `v${row.version} 알림을 거뒀습니다.`;
    });
  };

  const unpin = (item: UpdateNotice) =>
    run(`unpin:${item.id}`, async () => {
      await updateNoticeApi.pin(item.id, false);
      return `v${item.version} 알림 고정을 풀었습니다.`;
    });

  const visible = packages.filter(
    (row, index) => showAll || index < VISIBLE_ROWS || row.file === pubFile || row.file === candFile,
  );
  const hidden = packages.length - visible.length;
  const pinned = notices.filter((item) => item.pinned);

  return (
    <section className="admin-section">
      <h4>업데이트 관리</h4>
      <div className="admin-note-sub">
        NAS 에 올라온 <b>모든 판</b>이 보입니다. <b>[배포]</b>를 누르면 팀원에게 알림이 가고 그 판으로 업데이트됩니다(옛 판이면 되돌리기).
        <b> [이 PC에 먼저 설치]</b>는 팀원에게 알리지 않고 이 관리자 PC 에만 먼저 깝니다. <b>[재공지]</b>는 알림만 다시,
        <b> [해제]</b>는 팀원 알림만 거둡니다(배포된 판·줄은 그대로).
      </div>
      {overviewError && <div className="admin-update-warn">릴리스 폴더를 읽지 못했습니다 — {overviewError}</div>}
      {packagesError && <div className="admin-update-warn">판 목록을 읽지 못했습니다 — {packagesError}</div>}
      {noticeError && <div className="admin-update-warn">공유 서버의 알림 목록을 읽지 못했습니다 — {noticeError}</div>}
      {lookupFailed.shas.length > 0 && (
        <div className="admin-update-warn">
          배포 중인 판·새 후보의 알림 상태를 확인하지 못해 그 줄의 단추를 막았습니다 — {lookupFailed.error}
        </div>
      )}
      {candidateBlocked && (
        <div className="admin-update-warn">
          NAS 의 후보 파일(candidate.json)을 읽을 수 없어 배포를 막았습니다. 릴리스를 다시 만들어 올리세요.
        </div>
      )}
      {overview?.published_state === "error" && (
        <div className="admin-update-warn">팀 공개 표지(latest.json)를 읽을 수 없어 배포 상태를 확인할 수 없습니다.</div>
      )}
      {pinned.map((item) => (
        <div className="admin-update-pinned" key={item.id}>
          <span>고정된 알림: <b>v{item.version}</b> — 팀원 알림 맨 위에 남아 있습니다.</span>
          <button className="settings-action ghost" disabled={!!busy} onClick={() => void unpin(item)}>
            {busy === `unpin:${item.id}` ? "푸는 중…" : "고정 풀기"}
          </button>
        </div>
      ))}
      <div className="admin-update-list">
        {visible.length ? visible.map((row) => {
          const notice = noticeFor(row);
          const live = row.file === pubFile;
          const candidate = !live && row.file === candFile && overview?.pending === true;
          const waiting = candidate && (notice?.announcement_revision ?? 0) > 0; // 공지됐지만 표지 교체 전(후보 줄에서만)
          const older = !live && Boolean(pubVersion) && row.version < pubVersion;
          // 공개본보다 새 판만 먼저 설치할 수 있다(백엔드와 같은 규칙) — 되돌리기가 후보만 바꾸고 멈춘 옛 판에는 없다(Codex P3)
          const canPreinstall = candidate && !candidateBlocked && thisPc?.install_mode === "release"
            && Boolean(pubVersion) && row.version > pubVersion;
          const unknown = lookupFailed.shas.includes(live ? pubSha : row.file === candFile ? candSha : "-");
          const lock = !!busy || unknown; // 공지 상태를 모르는 줄은 공지·배포·해제를 막는다
          const rowBusy = busy.endsWith(`:${row.file}`) ? busy.split(":")[0] : "";
          return (
            <div className={"admin-update-row" + (waiting ? " warn" : live ? " live" : candidate ? " cand" : "")} key={row.file}>
              <span className="admin-update-file" title={row.file}>
                <b>
                  v{row.version}
                  {live ? <span className="admin-update-tag live">팀 배포 중</span>
                    : waiting ? <span className="admin-update-tag warn">공지됨 · 아직 배포 안 됨</span>
                    : candidate ? <span className="admin-update-tag cand">새 후보 · 배포 전</span>
                    : null}
                  {thisPcHas(row) && <span className="admin-update-tag pc">이 PC 설치됨</span>}
                </b>
                <small>
                  {row.file} · {Math.round(row.size / 1024 / 1024)}MB · {builtAt(row.version)}
                  {notice && notice.announcement_revision > 0 ? ` · 알림 ${notice.announcement_revision}회` : ""}
                </small>
                {waiting && (
                  <small className="admin-update-warnline">
                    지금 설치는 현재 공개본{pubVersion ? `(v${pubVersion})` : ""}을 따릅니다 — [배포 반영]으로 마저 배포하세요.
                  </small>
                )}
              </span>
              <span className="admin-update-actions">
                {canPreinstall && (
                  <button
                    className="settings-action ghost"
                    disabled={!!busy}
                    onClick={() => preinstall(row)}
                    title="팀원에게 알리기 전에 이 PC 에서 먼저 확인합니다(팀 배포는 바뀌지 않음)"
                  >
                    {rowBusy === "preinstall" ? "설치 시작 중…" : thisPcHas(row) ? "이 PC에 다시 설치" : "이 PC에 먼저 설치"}
                  </button>
                )}
                {live ? (
                  <button
                    className="settings-action"
                    disabled={lock}
                    onClick={() => void announceLive(row, notice)}
                    title="알림만 다시 보냅니다(배포는 바꾸지 않음)"
                  >
                    {rowBusy === "announce" ? "공지 중…" : notice && notice.announcement_revision > 0 ? "재공지" : "공지"}
                  </button>
                ) : waiting && notice ? (
                  <button
                    className="settings-action"
                    disabled={lock || deployBlocked}
                    onClick={() => void deployAgain(row, notice)}
                    title="알림은 다시 보내지 않고 팀 표지만 바꿉니다"
                  >
                    {rowBusy === "deploy" ? "배포 중…" : "배포 반영"}
                  </button>
                ) : (
                  <button
                    className={"settings-action" + (older ? " ghost" : "")}
                    disabled={lock || deployBlocked}
                    onClick={() => (candidate ? deployCandidate(row) : deployOther(row))}
                    title={older ? "팀 전체를 이 판으로 되돌립니다" : undefined}
                  >
                    {rowBusy === "hash" ? "지문 확인 중…" : rowBusy === "deploy" ? "배포 중…" : "배포"}
                  </button>
                )}
                {notice && (
                  <button className="settings-action ghost" disabled={lock} onClick={() => removeNotice(row, notice)}>
                    {rowBusy === "remove" ? "해제 중…" : "해제"}
                  </button>
                )}
              </span>
            </div>
          );
        }) : (
          <div className="admin-note-sub">릴리스 폴더에 판이 없습니다.</div>
        )}
        {hidden > 0 && (
          <button className="admin-update-more" onClick={() => setShowAll(true)}>
            이전 판 {hidden}개 더 보기 ▾
          </button>
        )}
      </div>
      {msg && (
        <p style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
          {msg}
        </p>
      )}
    </section>
  );
}
