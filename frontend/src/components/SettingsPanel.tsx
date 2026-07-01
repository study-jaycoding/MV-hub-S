// 설정 — AccountMenu의 "설정"으로 열리는 플로팅 창(ManageAccount 와 같은 패턴).
//  · 강조색 팔레트(프리셋 → CSS 변수 즉시 적용·영속)
//  · 언어 한글/English (선택 영속 — 전체 번역은 단계 적용)
//  · 단축키(변경은 별도 플로팅 창 ShortcutsWindow)
//  · 과거 생성물 가져오기(100건 밖 과거 전체를 MCP 백필 .md→파일 업로드로 서버에 적재)
import { useEffect, useState } from "react";
import {
  loadAccent,
  loadLang,
  loadReduceMotion,
  saveAccent,
  saveReduceMotion,
  type Lang,
} from "../lib/theme";
import { setLang, useT } from "../lib/i18n";
import { downloadText } from "../lib/download";
import {
  clearDownloadDir,
  downloadDirName,
  pickDownloadDir,
} from "../lib/downloadDir";
import { api } from "../api";
import { buildBackfillInstructions, parseMcpItems } from "../lib/settingsBackfill";
import { useEscapeClose } from "../lib/useEscapeClose";
import { ShortcutsWindow } from "./ShortcutsWindow";
import {
  AppearanceSettingsSection,
  BackfillSettingsSection,
  DownloadLocationSection,
  MetadataContinuitySection,
  SyncToolsSection,
} from "./settings/SettingsSections";

export function SettingsPanel({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported?: (msg: string) => void; // 라이브러리 변경 후 리로드+안내(휴지통 이동 등)
}) {
  const t = useT();
  const [accent, setAccent] = useState(loadAccent());
  const [lang, setLangState] = useState<Lang>(loadLang());
  const [reduceMotion, setReduceMotion] = useState(loadReduceMotion());
  const [msg, setMsg] = useState("");
  const [uploading, setUploading] = useState(false);
  const [scOpen, setScOpen] = useState(false);
  const [dbBusy, setDbBusy] = useState(false);
  const [dbMsg, setDbMsg] = useState("");
  const [syncMsg, setSyncMsg] = useState("");
  const [hfMsg, setHfMsg] = useState("");
  const [dlDir, setDlDir] = useState<string | null>(null);
  const [dlErr, setDlErr] = useState("");

  useEffect(() => {
    downloadDirName().then(setDlDir).catch(() => {});
  }, []);

  const pickDir = async () => {
    setDlErr("");
    try {
      setDlDir(await pickDownloadDir());
    } catch (e) {
      if ((e as DOMException)?.name !== "AbortError") setDlErr(String((e as Error)?.message || e));
    }
  };

  const clearDir = async () => {
    await clearDownloadDir().catch(() => {});
    setDlDir(null);
  };

  // '외부 생성물 올리기' — 내 에이전트를 깨워 허브 밖(Claude·웹·CLI)에서 만든 결과물을 push.
  const syncMine = async () => {
    setSyncMsg("요청 보냄…");
    try {
      const r = await api.agentSync();
      setSyncMsg(r.connected ? "✓ 에이전트에 전달됨" : "에이전트가 꺼져 있어요");
    } catch {
      setSyncMsg("실패");
    }
    setTimeout(() => setSyncMsg(""), 2500);
  };

  // '힉스필드 삭제물 검토' — 내 생성물 중 힉스필드에서 삭제된 것을 찾아 휴지통으로 보낸다.
  const reviewHfDeleted = async () => {
    setHfMsg("힉스필드 점검 중…");
    try {
      const r = await api.trashHfMissing();
      setHfMsg(r.trashed > 0 ? `✓ ${r.trashed}건 휴지통으로` : `삭제물 없음 (${r.checked}건 점검)`);
      if (r.trashed > 0) onImported?.(`힉스필드 삭제물 ${r.trashed}건을 휴지통으로 보냈습니다.`);
    } catch {
      setHfMsg("실패");
    }
    setTimeout(() => setHfMsg(""), 2800);
  };

  const downloadBackfillMd = () => {
    downloadText(
      "MV_history_backfill.md",
      buildBackfillInstructions(window.location.origin),
      "text/markdown",
    );
    setMsg("MV_history_backfill.md 를 받았습니다. 힉스필드 MCP가 연결된 Claude 세션에 이 파일을 주면 결과 파일을 만들어 줍니다.");
  };

  const onBackfillFile = async (file: File | null | undefined) => {
    if (!file) return;
    setUploading(true);
    setMsg("파일 읽는 중…");
    try {
      const items = parseMcpItems(await file.text());
      if (!items.length) {
        setMsg("올린 파일에서 항목을 못 찾았습니다 (JSON 배열·{items:[...]}·JSONL 형식이어야 함).");
        return;
      }
      let inserted = 0;
      let updated = 0;
      let unchanged = 0;
      let skipped = 0;
      const batchSize = 200;
      for (let i = 0; i < items.length; i += batchSize) {
        setMsg(`적재 중… ${Math.min(i + batchSize, items.length)}/${items.length}`);
        const r = await api.ingestMcp(items.slice(i, i + batchSize));
        inserted += r.inserted;
        updated += r.updated;
        unchanged += r.unchanged;
        skipped += r.skipped;
      }
      setMsg(
        `적재 완료 · 신규 ${inserted} · 갱신 ${updated} · 중복 ${unchanged} · 건너뜀 ${skipped}. 새로고침하면 보입니다.`,
      );
    } catch (e) {
      setMsg("적재 실패: " + String(e));
    } finally {
      setUploading(false);
    }
  };

  // 내 DB 가져오기(통째 교체) — 성공하면 라이브러리를 새로 읽도록 전체 새로고침.
  const importDb = async (file: File | null | undefined) => {
    if (!file) return;
    if (!window.confirm("현재 로컬 DB를 이 파일로 통째 교체합니다. (현재 DB는 자동 백업)\n계속할까요?")) {
      return;
    }
    setDbBusy(true);
    setDbMsg("가져오는 중…");
    try {
      await api.importDb(file);
      setDbMsg("가져오기 완료 — 라이브러리를 새로고침합니다…");
      setTimeout(() => window.location.reload(), 800);
    } catch (e) {
      setDbMsg("가져오기 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setDbBusy(false);
    }
  };

  const serverBackup = async () => {
    setDbBusy(true);
    setDbMsg("서버에 백업 중…");
    try {
      const r = await api.serverBackup();
      setDbMsg(`✓ 서버에 백업 완료 (보관 ${r.count}개)`);
    } catch (e) {
      setDbMsg("백업 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setDbBusy(false);
    }
  };

  const serverRestore = async () => {
    if (
      !window.confirm(
        "서버에 백업해둔 내 계정 DB로 현재 로컬을 통째 교체합니다.\n(현재 DB는 자동 백업, 복원 후 재로그인)\n계속할까요?",
      )
    ) {
      return;
    }
    setDbBusy(true);
    setDbMsg("서버에서 가져오는 중…");
    try {
      await api.serverRestore();
      setDbMsg("복원 완료 — 다시 로그인해 주세요…");
      setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      setDbMsg("가져오기 실패: " + String(e).replace(/^Error:\s*\d+:\s*/, ""));
    } finally {
      setDbBusy(false);
    }
  };

  useEscapeClose(onClose);

  const pickAccent = (hex: string) => {
    setAccent(hex);
    saveAccent(hex);
  };

  const pickLang = (nextLang: Lang) => {
    setLangState(nextLang);
    setLang(nextLang);
  };

  const pickReduceMotion = (value: boolean) => {
    setReduceMotion(value);
    saveReduceMotion(value);
  };

  return (
    <>
      <div className="info-catcher" onMouseDown={onClose} />
      <div className="manage-float settings-float" role="dialog" aria-label={t("설정")}>
        <header className="admin-head">
          <span className="admin-title">⚙ {t("설정")}</span>
          <button className="assets-x" onClick={onClose} title={t("닫기")}>
            ✕
          </button>
        </header>

        <div className="admin-body">
          <AppearanceSettingsSection
            accent={accent}
            lang={lang}
            reduceMotion={reduceMotion}
            onAccent={pickAccent}
            onLang={pickLang}
            onReduceMotion={pickReduceMotion}
          />

          <DownloadLocationSection
            dlDir={dlDir}
            dlErr={dlErr}
            onPickDir={pickDir}
            onClearDir={clearDir}
          />

          <section className="settings-section">
            <h4>{t("단축키")}</h4>
            <button className="settings-action" onClick={() => setScOpen(true)}>
              ⌨ {t("단축키 설정")}
            </button>
            <p className="settings-hint">{t("지정된 단축키를 보고 원하는 키로 바꿀 수 있습니다.")}</p>
          </section>

          <BackfillSettingsSection
            uploading={uploading}
            msg={msg}
            onDownloadBackfill={downloadBackfillMd}
            onBackfillFile={onBackfillFile}
          />

          <MetadataContinuitySection
            dbBusy={dbBusy}
            dbMsg={dbMsg}
            onServerBackup={serverBackup}
            onServerRestore={serverRestore}
            onImportDb={importDb}
          />

          <SyncToolsSection
            syncMsg={syncMsg}
            hfMsg={hfMsg}
            onSyncMine={syncMine}
            onReviewHfDeleted={reviewHfDeleted}
          />
        </div>
      </div>

      {scOpen && <ShortcutsWindow onClose={() => setScOpen(false)} />}
    </>
  );
}
