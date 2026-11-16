import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../api";
import type {
  BackupContinuityStatus,
  BackupPolicyPreview,
  BackupPolicyValues,
  BackupPolicyView,
  BackupRetentionStatus,
} from "../../lib/assetsApi";
import { HttpError } from "../../lib/http";
import { useT } from "../../lib/i18n";
import { BACKUP_STATE_LABELS } from "./SettingsSections";
import { SettingsDescription } from "./SettingsDescription";

// 설정 '자료 관리' ② 백업 — 저장 통합 1-A(docs/status/저장통합_1A_자료관리칸_2026-11-12.md, 시안 2판).
// 보관 규칙·삭제 확인은 서버가 지킨다: 줄이는 값은 dry_run 미리보기 → 확인 → 그 확인 토큰으로만 저장된다.

export function formatBytes(size: number): string {
  if (size >= 1024 ** 3) return `${(size / 1024 ** 3).toFixed(1)} GB`;
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(size / 1024))} KB`;
}

function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 막힌 이유·실패를 쉬운 말로 — 상태 줄과 묶음 제목 밑 줄이 같이 쓴다. */
export function backupWarnings(retention: BackupRetentionStatus | undefined): string[] {
  if (!retention) return [];
  const out: string[] = [];
  if (retention.blocked === "clock_skew") out.push("컴퓨터 시계가 맞지 않아 오래된 백업 정리를 멈췄습니다");
  if (retention.blocked === "policy_invalid") out.push("보관 설정을 읽지 못해 정리를 멈췄습니다 — 남기는 양을 다시 골라 주세요");
  if (retention.inverted > 0) out.push(`시계가 맞지 않던 때의 백업 때문에 오래된 백업 ${retention.inverted}세트를 정리하지 않고 있습니다`);
  if (retention.leftovers > 0) out.push(`대표 파일이 없는 반쪽 백업 ${retention.leftovers}개는 지우지 않고 남겨 둡니다`);
  if (retention.delete_failed > 0) out.push(`오래된 백업 ${retention.delete_failed}세트를 지우지 못했습니다(다음에 다시)`);
  if (retention.last_error?.code === "disk_full") out.push("디스크가 부족해 백업하지 못했습니다");
  else if (retention.last_error?.code === "registry_unreadable") out.push("백업 폴더의 기록을 읽지 못해 백업하지 못했습니다 — 폴더 권한·연결을 확인해 주세요");
  else if (retention.last_error?.code === "agent_chat_busy") out.push("대화 기록을 복원 중이어서 백업하지 못했습니다 — 잠시 뒤 다시 시도합니다");
  else if (retention.last_error?.code === "agent_chat_unreadable") out.push("대화 기록을 읽지 못해 백업하지 못했습니다 — 기존 백업은 그대로 남아 있습니다");
  else if (retention.last_error?.code === "asset_mounts_invalid") out.push("폴더 등록 자료를 읽지 못해 백업하지 못했습니다 — 기존 백업은 그대로 남아 있습니다");
  else if (retention.last_error?.code === "backup_scope_changed" || retention.last_error?.code === "share_database_changed") out.push("백업 중 계정 자료가 바뀌어 완료하지 못했습니다 — 다시 시도해 주세요");
  else if (retention.last_error) out.push(`마지막 백업 실패(${retention.last_error.code})`);
  return out;
}

/** 묶음 제목 밑 줄의 백업 부분 — '백업 N세트(MM-DD부터)'. */
export function backupSummary(status: BackupContinuityStatus | null): string {
  const retention = status?.local.retention;
  if (!retention) return status?.local.set_count != null ? `백업 ${status.local.set_count}세트` : "";
  const since = retention.oldest_created_at ? `(${day(retention.oldest_created_at)}부터)` : "";
  return [`백업 ${retention.set_count}세트${since}`, ...backupWarnings(retention).map((w) => `⚠ ${w}`)].join(" · ");
}

const FIELD_LABELS: Record<keyof BackupPolicyValues, string> = {
  quiet_minutes: "조용해진 뒤",
  min_interval_minutes: "최소 간격",
  recent: "최근",
  daily_days: "날마다 1장",
  weekly_weeks: "주마다 1장",
};

const FIELDS: { key: keyof BackupPolicyValues; unit: string }[] = [
  { key: "quiet_minutes", unit: "분" },
  { key: "min_interval_minutes", unit: "분" },
  { key: "recent", unit: "장" },
  { key: "daily_days", unit: "일" },
  { key: "weekly_weeks", unit: "주" },
];

const BACKUP_ROLE_LABELS = {
  content: "작업 기록(생성물·캔버스·편집)",
  trash: "휴지통",
  agent_chat: "MV Agent 대화",
  asset_mounts: "폴더 등록",
};

function confirmText(preview: BackupPolicyPreview): string {
  const period = preview.delete_oldest_at
    ? ` (${day(preview.delete_oldest_at)} ~ ${day(preview.delete_newest_at)})`
    : "";
  return (
    `이렇게 바꾸면 오래된 백업 ${preview.delete_count}세트${period}, ${formatBytes(preview.delete_bytes)}가 지워집니다.\n` +
    (preview.oldest_kept_at ? `남는 가장 오래된 백업: ${day(preview.oldest_kept_at)}\n` : "") +
    (preview.blocked === "inverted"
      ? "시계가 맞지 않던 때의 백업이 있어 이 수는 실제보다 많아 보일 수 있습니다. 그 백업이 정리된 뒤 그때의 시각으로 다시 계산해 지웁니다.\n"
      : "") +
    "지운 백업은 되돌릴 수 없습니다. 계속할까요?"
  );
}

// 자료 관리 옆 창의 뼈대(Jay 2026-11-16 시안 v3): 숫자 요약 → 상태 한 줄 → [지금 백업]+actions → children → '백업 자동 설정 · 고급' 접기(보관 설정 + advanced).
export function BackupSection({
  status,
  onRefresh,
  held = 0,
  transfer = null,
  actions,
  advanced,
  children,
}: {
  status: BackupContinuityStatus | null;
  onRefresh: () => void;
  /** 복원 보류 수(주황 숫자) */
  held?: number;
  /** 전송 대기 수 — 모르면 null */
  transfer?: number | null;
  actions?: ReactNode;
  advanced?: ReactNode;
  children?: ReactNode;
}) {
  const t = useT();
  const [view, setView] = useState<BackupPolicyView | null>(null);
  const [readonly, setReadonly] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const loadPolicy = async () => {
    try {
      setView(await api.backupPolicy());
      setReadonly("");
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) setReadonly(error.detail);
      else setMsg(t("보관 설정을 읽지 못했습니다"));
    }
  };
  useEffect(() => {
    void loadPolicy();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 창을 열 때 한 번
  }, []);

  const retention = status?.local.retention;
  const shared = status?.shared;

  // 지금 값이 목록 밖(환경변수 등)이면 서버가 받지 않는다 — 고르지 않은 칸도 허용값으로 맞춰야 하는데, 몰래 바꾸지
  //  않고 무엇이 어떻게 바뀌는지 보여 주고 묻는다. 맞추는 쪽: 남기는 양은 더 많이 남기는 쪽, 간격은 더 자주 찍는 쪽.
  const fit = (field: keyof BackupPolicyValues, current: number): number => {
    const choices = view?.choices[field] ?? [];
    if (!choices.length || choices.includes(current)) return current;
    if (field === "quiet_minutes" || field === "min_interval_minutes") {
      return [...choices].reverse().find((choice) => choice <= current) ?? choices[0];
    }
    return choices.find((choice) => choice >= current) ?? choices[choices.length - 1];
  };

  const change = async (key: keyof BackupPolicyValues, value: number) => {
    if (!view || busy) return;
    const next = Object.fromEntries(
      FIELDS.map(({ key: field }) => [field, field === key ? value : fit(field, view.policy[field])]),
    ) as unknown as BackupPolicyValues;
    const fitted = FIELDS.filter(({ key: field }) => field !== key && next[field] !== view.policy[field]);
    if (fitted.length) {
      const lines = fitted.map(({ key: field, unit }) => `${FIELD_LABELS[field]} ${view.policy[field]}${unit} → ${next[field]}${unit}`);
      if (!window.confirm(`지금 값 중 고를 수 없는 값이 있어 함께 바꿉니다.\n${lines.join("\n")}\n계속할까요?`)) {
        setMsg(t("바꾸지 않았습니다"));
        return;
      }
    }
    setBusy(true);
    setMsg("");
    try {
      const dry = await api.saveBackupPolicy({ ...next, version: view.version, dry_run: true });
      let token: string | null = null;
      if (dry.preview.delete_count > 0 && dry.preview.blocked === "clock_skew") {
        // 시계 문제가 남아 있으면 지울 대상을 확정할 수 없다 — 서버도 저장을 거절한다(늘리는 값은 된다).
        setMsg(t("시계가 맞지 않던 백업이 남아 있어 지금은 남기는 양을 줄일 수 없습니다"));
        await loadPolicy();
        return;
      }
      if (dry.preview.delete_count > 0) {
        if (!window.confirm(confirmText(dry.preview))) {
          setMsg(t("바꾸지 않았습니다"));
          return;
        }
        token = dry.preview.confirm_token;
      }
      const saved = await api.saveBackupPolicy({ ...next, version: view.version, confirm_token: token });
      // 실제로 지운 수(applied) — 미리보기 수와 다를 수 있다. failed 는 이번에 새로 못 지운 것만(이어 지우기 실패 제외).
      //  보류(쌍 보호·사용 중)는 다음 정리 때 그때의 정책·시각으로 다시 계산한다 — 지운다고 약속하지 않는다.
      const deleted = saved.applied?.deleted ?? 0;
      const failed = saved.applied?.failed ?? 0;
      const held = Math.max(0, saved.preview.delete_count - deleted - failed);
      setMsg([
        t("저장했습니다"),
        deleted ? `오래된 백업 ${deleted}세트를 정리했습니다` : "",
        failed ? `${failed}세트는 지우지 못했습니다(다음에 다시)` : "",
        held ? `${held}세트는 현재 정리 보류 중입니다` : "",
      ].filter(Boolean).join(" · "));
      await loadPolicy();
      onRefresh();
    } catch (error) {
      const code = error instanceof HttpError ? (error.info?.code as string | undefined) : undefined;
      if (code === "version_conflict" || code === "confirm_required") await loadPolicy();
      setMsg(
        code === "confirm_required"
          ? t("그사이 백업이 늘어 지울 것이 바뀌었습니다 — 다시 골라 주세요")
          : error instanceof HttpError ? error.detail : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  const backupNow = async () => {
    setBusy(true);
    setMsg(t("백업하는 중"));
    try {
      const result = await api.backupNow();
      setMsg(result.ok ? t("지금 상태를 백업했습니다") : t("백업할 데이터가 아직 없습니다"));
      onRefresh();
    } catch (error) {
      setMsg(`${t("백업하지 못했습니다")}: ${error instanceof HttpError ? error.detail : String(error)}`);
      onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const select = (key: keyof BackupPolicyValues, unit: string) => {
    const current = view?.policy[key];
    const options = [...(view?.choices[key] ?? [])];
    if (current != null && !options.includes(current)) options.unshift(current); // 환경변수 값 등 목록 밖이면 그 값도 한 칸
    return (
      <select
        className="settings-select"
        aria-label={key}
        value={current ?? ""}
        disabled={!view || busy || !!readonly}
        onChange={(event) => void change(key, Number(event.target.value))}
      >
        {options.map((value) => (
          <option key={value} value={value}>{value}{unit}</option>
        ))}
      </select>
    );
  };

  const policy = view?.policy;
  const slots = policy ? policy.recent + policy.daily_days + policy.weekly_weeks : 0;
  const estimate = retention?.latest_set_bytes ? retention.latest_set_bytes * slots : null;
  const warnings = backupWarnings(retention);

  const sets = retention?.set_count ?? status?.local.set_count;
  return (
    <section className="settings-section settings-backup">
      <div className="settings-tiles" aria-live="polite">
        <div className="settings-tile" data-tile="backup">
          <span className="settings-tile-label">{t("백업")}</span>
          <span className="settings-tile-value">{sets ?? "—"}{sets != null ? t("세트") : ""}</span>
        </div>
        <div className="settings-tile" data-tile="held">
          <span className="settings-tile-label">{t("복원 보류")}</span>
          <span className={"settings-tile-value" + (held > 0 ? " is-warn" : "")}>{held}</span>
        </div>
        <div className="settings-tile" data-tile="transfer">
          <span className="settings-tile-label">{t("전송 대기")}</span>
          <span className="settings-tile-value">{transfer ?? "—"}</span>
        </div>
      </div>
      <p className="settings-backup-status" aria-live="polite">
        {retention && (
          <>
            {t("가장 오래된 것")} {day(retention.oldest_created_at)}
            {" · "}{formatBytes(retention.total_bytes || 0)}
            {" · "}
          </>
        )}
        {t("서버 복제")} <b>{shared ? t(BACKUP_STATE_LABELS[shared.state] || shared.state) : t("확인 중")}</b>
      </p>
      {shared && ["server_update_required", "failed", "login_required"].includes(shared.state)
        && !!shared.unsent_roles?.length && (
        <p className="settings-backup-warn" aria-live="polite">
          ⚠ {t(shared.state === "server_update_required"
            ? "공유 서버가 이 백업을 아직 받지 못하는 버전입니다"
            : shared.state === "login_required" ? "로그인하면 보냅니다" : "서버 전송을 다시 시도합니다")}
          {" · "}{t("서버에 안 간 것")}: {shared.unsent_roles.map((role) => t(BACKUP_ROLE_LABELS[role])).join(" · ")}
          {" · "}{t("앱이 실행 중이면 자동으로 다시 확인합니다")}
        </p>
      )}
      {warnings.map((warning) => (
        <p key={warning} className="settings-backup-warn">⚠ {t(warning)}</p>
      ))}

      <div className="settings-row">
        <button className="settings-action" onClick={() => void backupNow()} disabled={busy}>
          {t("지금 백업")}
        </button>
        {actions}
      </div>
      {msg && <p className="manage-msg">{msg}</p>}

      {children}

      <details className="settings-adv">
        <summary>{t("백업 자동 설정 · 고급")} <span className="settings-adv-hint">{t("사진 찍는 때 · 남기는 양 · 파일로 직접 주고받기")}</span></summary>
        {/* 좁은 패널에서도 '이름 + 고르는 칸' 묶음 단위로만 줄이 바뀌게 묶는다 */}
        <div className="settings-backup-label">{t("사진 찍는 때")}</div>
        <div className="settings-backup-line">
          <span className="settings-backup-pick">{t("바뀐 뒤")} {select("quiet_minutes", FIELDS[0].unit)} {t("조용하면")}</span>
          <span className="settings-backup-pick">{t("최소")} {select("min_interval_minutes", FIELDS[1].unit)} {t("간격")}</span>
        </div>
        <div className="settings-backup-label">{t("남기는 양")}</div>
        <div className="settings-backup-line">
          <span className="settings-backup-pick">{t("최근")} {select("recent", FIELDS[2].unit)}</span>
          <span className="settings-backup-pick">{t("날마다 1장")} {select("daily_days", FIELDS[3].unit)}</span>
          <span className="settings-backup-pick">{t("주마다 1장")} {select("weekly_weeks", FIELDS[4].unit)}</span>
        </div>
        <p className="settings-hint">
          {readonly
            || (estimate ? `${t("이대로면 최대 약")} ${formatBytes(estimate)}` : t("백업이 쌓이면 예상 용량이 보입니다"))}
        </p>
        <SettingsDescription summary={t("작업이 조용해지면 이 PC 에 사진을 찍어 두고, 오래된 것은 고른 양만큼만 남깁니다.")}>
          <p>{t("백업은 이 PC 의 허브 DB(생성물 기록·캔버스·편집 사본·코멘트)를 통째로 찍습니다. 그림·영상 파일은 들어가지 않습니다.")}</p>
          <p>{t("남기는 양을 줄이면 지워질 백업을 먼저 보여 주고 물어봅니다. 시계가 맞지 않거나 설정을 읽지 못하면 아무것도 지우지 않습니다.")}</p>
        </SettingsDescription>
        {advanced}
      </details>
    </section>
  );
}
