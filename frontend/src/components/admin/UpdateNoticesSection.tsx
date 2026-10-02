// 관리자 창 · 업데이트 탭 — 최근 업데이트 목록·고정·공지·해제. 예전 '공유 서버' 탭 안에 있던 것을 떼어 냈다(2026-10-02).
// B안(docs/UPDATE_ANNOUNCEMENTS.md): 릴리스 스크립트는 NAS 에 '후보'만 올리고, 처음 [공지]가 공지 뒤 후보를 팀 표지로
// 올린다(promote). [재공지]는 알림만 · [배포 반영]은 공지 뒤 NAS 쓰기만 실패했을 때 표지만 · [해제]는 목록·알림에서만.
// 상태와 API 호출은 이 안에만 둔다 — 탭을 열 때마다(마운트) 새로 읽는다.
import { useEffect, useState } from "react";
import { HttpError } from "../../lib/http";
import { getLatestReleaseMetadata, promoteRelease, type LatestReleaseMetadata } from "../../lib/releaseUpdate";
import { updateNoticeApi, type UpdateNotice } from "../../lib/updateNotices";

const errText = (error: unknown) =>
  error instanceof HttpError ? error.detail : String(error).replace(/^Error:\s*\d+:\s*/, "");

export function UpdateNoticesSection() {
  const [latestRelease, setLatestRelease] = useState<LatestReleaseMetadata | null>(null);
  const [releaseError, setReleaseError] = useState("");
  const [lookupError, setLookupError] = useState(""); // 목록 밖 후보 조회 실패 — 등록 여부를 모른다(미등록으로 단정하지 않음)
  const [updateNotices, setUpdateNotices] = useState<UpdateNotice[]>([]);
  const [updateNoticeBusy, setUpdateNoticeBusy] = useState("");
  const [updateNoticeMsg, setUpdateNoticeMsg] = useState("");

  const loadUpdateManagement = async () => {
    const [items, latest] = await Promise.all([
      updateNoticeApi.adminList().catch((error) => {
        setUpdateNoticeMsg("목록을 읽지 못했습니다: " + errText(error));
        return [] as UpdateNotice[];
      }),
      getLatestReleaseMetadata().then(
        (value) => { setReleaseError(""); return value; },
        (error) => { setReleaseError(errText(error)); return null; },
      ),
    ]);
    // 후보가 최근 5개 밖으로 밀려 있어도 맨 위에 보인다(등록 단추가 다시 뜨는 혼란 방지).
    let candidate: UpdateNotice | null = null;
    setLookupError("");
    if (latest?.source === "candidate" && !items.some((item) => item.sha256 === latest.sha256)) {
      candidate = await updateNoticeApi.adminItem(latest.sha256).catch((error) => {
        // 404 = 아직 등록 안 됨(옛 서버의 Not Found 도 — 등록은 같은 sha 면 멱등이라 단추를 보여도 안전). 그 밖은 모른다.
        if (!(error instanceof HttpError && error.status === 404)) setLookupError(errText(error));
        return null;
      });
    }
    setUpdateNotices(candidate ? [candidate, ...items] : items);
    setLatestRelease(latest);
  };
  useEffect(() => {
    void loadUpdateManagement();
  }, []);

  const run = async (busy: string, work: () => Promise<string>, failPrefix: string) => {
    setUpdateNoticeBusy(busy);
    setUpdateNoticeMsg("");
    try {
      setUpdateNoticeMsg(await work());
    } catch (error) {
      setUpdateNoticeMsg(failPrefix + errText(error));
    } finally {
      await loadUpdateManagement();
      setUpdateNoticeBusy("");
    }
  };

  const candidateBlocked = Boolean(latestRelease?.candidate_error);
  const isCandidate = (item: UpdateNotice) =>
    latestRelease?.source === "candidate" && item.sha256 === latestRelease.sha256;
  const isLive = (item: UpdateNotice) => Boolean(item.sha256) && latestRelease?.published?.sha256 === item.sha256;
  // 공지됐지만 아직 팀 표지가 아님 — 공개 표지를 정상으로 읽었을 때만 판단한다(못 읽으면 null = 확인 불가)
  const awaitingDeploy = (item: UpdateNotice) =>
    isCandidate(item) && item.announcement_revision > 0 && latestRelease?.pending === true;
  const liveVersion = latestRelease?.published?.version;

  const promote = async (item: UpdateNotice) => {
    const result = await promoteRelease(item.id, item.sha256 || "");
    return result.already
      ? `v${item.version} 은(는) 이미 팀에 배포된 판입니다.`
      : `v${item.version} 을(를) 팀에 배포했습니다 — 팀원 PC 에 '업데이트 있음'이 뜹니다.`;
  };

  const registerLatestRelease = () =>
    latestRelease && run("register", async () => {
      const result = await updateNoticeApi.register(latestRelease);
      return result.created ? "목록에 등록했습니다. [공지]를 누르면 팀에 배포됩니다." : "이미 등록된 업데이트입니다.";
    }, "등록 실패: ");

  const toggleUpdatePin = (item: UpdateNotice) =>
    run(`pin:${item.id}`, async () => {
      await updateNoticeApi.pin(item.id, !item.pinned);
      return "";
    }, "고정 변경 실패: ");

  const announceUpdate = (item: UpdateNotice) =>
    run(`announce:${item.id}`, async () => {
      const first = item.announcement_revision === 0;
      const result = await updateNoticeApi.announce(item.id);
      const told = `v${item.version} 업데이트를 공지했습니다 (${result.item.announcement_revision}번째).`;
      // 처음 [공지]만 배포까지 — [재공지]는 알림만(롤백한 판이 되살아나지 않게, B안 r3)
      if (!first || !isCandidate(item) || latestRelease?.pending !== true) return told;
      try {
        return `${told} ${await promote(item)}`;
      } catch (error) {
        // 500 = 표지 교체 결과를 확인 못 함 — '배포 안 됨'으로 단정하지 않는다(Codex 코드 리뷰). 4xx 는 바뀌기 전에 멈춘 것.
        if (!(error instanceof HttpError) || error.status >= 500) {
          return `${told} 다만 팀 배포 결과를 확인할 수 없습니다 — 업데이트 탭을 다시 열어 확인하세요. 이유: ${errText(error)}`;
        }
        return `${told} 다만 팀 배포는 아직입니다 — 지금 설치는 현재 공개본${liveVersion ? `(v${liveVersion})` : ""}을 따릅니다. 이유: ${errText(error)}`;
      }
    }, "공지 실패: ");

  const deployUpdate = (item: UpdateNotice) =>
    run(`deploy:${item.id}`, () => promote(item), "배포 반영 실패: ");

  const removeUpdate = (item: UpdateNotice) => {
    if (!window.confirm(`v${item.version} 을(를) 이 목록과 팀원 알림에서 지웁니다.\n설치 파일과 이미 배포된 버전은 그대로입니다.`)) return;
    void run(`remove:${item.id}`, async () => {
      try {
        await updateNoticeApi.remove(item.id);
      } catch (error) {
        if (error instanceof HttpError && error.status === 404) throw new Error("공유 서버를 업데이트한 뒤 사용할 수 있습니다");
        throw error;
      }
      return `v${item.version} 을(를) 목록에서 지웠습니다.`;
    }, "해제 실패: ");
  };

  const registered = Boolean(lookupError) ||  // 조회 실패면 등록 단추를 다시 띄우지 않는다
    Boolean(latestRelease && updateNotices.some((item) => item.sha256 === latestRelease.sha256));
  const newCandidate = latestRelease?.source === "candidate" && latestRelease.pending === true;

  return (
    <section className="admin-section">
      <h4>업데이트 관리</h4>
      <div className="admin-note-sub">
        릴리스 스크립트는 NAS 에 <b>후보</b>로만 올립니다. <b>[공지]</b>를 눌러야 팀원 PC 에 업데이트가 보이고
        설치됩니다(관리자 PC 포함). <b>[재공지]</b>는 알림만 다시, <b>[해제]</b>는 이 목록과 팀원 알림에서만
        지웁니다(설치 파일·배포된 판은 그대로). 고정한 항목은 새 업데이트가 생겨도 남습니다(최대 4개).
      </div>
      {releaseError && <div className="admin-update-warn">릴리스 폴더를 읽지 못했습니다 — {releaseError}</div>}
      {candidateBlocked && (
        <div className="admin-update-warn">
          NAS 의 후보 파일(candidate.json)을 읽을 수 없어 등록·공지·배포를 막았습니다. 릴리스를 다시 만들어 올리세요.
        </div>
      )}
      {lookupError && <div className="admin-update-warn">후보가 목록에 등록됐는지 확인하지 못했습니다 — {lookupError}</div>}
      {latestRelease?.published_state === "error" && (
        <div className="admin-update-warn">팀 공개 표지(latest.json)를 읽을 수 없어 배포 상태를 확인할 수 없습니다.</div>
      )}
      {latestRelease && !registered && !candidateBlocked && (
        newCandidate ? (
          <div className="admin-update-cand">
            <span>새 후보 <b>v{latestRelease.version}</b> 이(가) NAS 에 올라왔습니다 — 아직 팀원에게는 안 보입니다.</span>
            <button className="settings-action" onClick={() => void registerLatestRelease()} disabled={!!updateNoticeBusy}>
              {updateNoticeBusy === "register" ? "등록 중…" : "목록에 등록"}
            </button>
          </div>
        ) : (
          <button
            className="settings-action"
            style={{ width: "auto", marginBottom: 10 }}
            onClick={() => void registerLatestRelease()}
            disabled={!!updateNoticeBusy}
          >
            {updateNoticeBusy === "register" ? "등록 중…" : `최신 업데이트 v${latestRelease.version} 등록`}
          </button>
        )
      )}
      <div className="admin-update-list">
        {updateNotices.length ? updateNotices.map((item) => {
          const candidate = isCandidate(item);
          const waiting = awaitingDeploy(item);
          // 첫 [공지]를 막는 경우: 후보 파일이 깨짐(어느 줄이 후보인지 모름 → 모든 줄) · 이 줄이 후보인데 배포 상태를 확인 불가
          const firstAnnounceBlocked = item.announcement_revision === 0 &&
            (candidateBlocked || (candidate && latestRelease?.pending == null));
          return (
            <div className={"admin-update-row" + (waiting ? " warn" : "")} key={item.id}>
              <label className="admin-update-pin" title="이 업데이트를 최근 5개 목록에 고정">
                <input
                  type="checkbox"
                  checked={item.pinned}
                  disabled={!!updateNoticeBusy}
                  onChange={() => void toggleUpdatePin(item)}
                />
                고정
              </label>
              <span className="admin-update-file" title={item.file}>
                <b>
                  v{item.version}
                  {isLive(item) ? <span className="admin-update-tag live">팀 배포 중</span>
                    : waiting ? <span className="admin-update-tag warn">공지됨 · 아직 배포 안 됨</span>
                    : candidate && item.announcement_revision === 0 ? <span className="admin-update-tag cand">후보 · 공지 전</span>
                    : null}
                </b>
                <small>{item.file}</small>
                {waiting && (
                  <small className="admin-update-warnline">
                    지금 설치는 현재 공개본{liveVersion ? `(v${liveVersion})` : ""}을 따릅니다 — [배포 반영]으로 마저 배포하세요.
                  </small>
                )}
              </span>
              <span className="admin-update-actions">
                {waiting ? (
                  <button
                    className="settings-action"
                    disabled={!!updateNoticeBusy || candidateBlocked}
                    onClick={() => void deployUpdate(item)}
                    title="알림은 다시 보내지 않고 팀 표지만 바꿉니다"
                  >
                    {updateNoticeBusy === `deploy:${item.id}` ? "배포 중…" : "배포 반영"}
                  </button>
                ) : (
                  <button
                    className="settings-action"
                    disabled={!!updateNoticeBusy || firstAnnounceBlocked}
                    onClick={() => void announceUpdate(item)}
                    title={item.announcement_revision > 0 ? "알림만 다시 보냅니다(배포는 바꾸지 않음)" : undefined}
                  >
                    {updateNoticeBusy === `announce:${item.id}`
                      ? "공지 중…"
                      : item.announcement_revision > 0 ? "재공지" : "공지"}
                  </button>
                )}
                <button
                  className="settings-action ghost"
                  disabled={!!updateNoticeBusy}
                  onClick={() => removeUpdate(item)}
                >
                  {updateNoticeBusy === `remove:${item.id}` ? "해제 중…" : "해제"}
                </button>
              </span>
            </div>
          );
        }) : (
          <div className="admin-note-sub">등록된 업데이트가 없습니다.</div>
        )}
      </div>
      {updateNoticeMsg && (
        <p style={{ marginTop: 8, fontSize: 12, color: "var(--muted)" }}>
          {updateNoticeMsg}
        </p>
      )}
    </section>
  );
}
