// PM 대시보드 '관리 표' — 엑셀 시트처럼 멤버·그룹·크레딧을 나눠 보고, 편집 가능한 칸은 바로 저장한다.
// 설계: docs/MEMBER_TABLE_DESIGN.md. 표에는 자기만의 쓰기 API 가 없다 — 칸마다 기존 API 를 부른다(권한·감사 그대로).
// 저장은 직렬 큐 하나로 줄 세우고, 큐가 비면 성공·실패와 관계없이 표를 다시 읽는다(다른 창·다른 사람의 변경은 큐 밖이다).
// 재조회는 서버 표시만 갱신한다. 편집 기준과 실패한 저장 의도는 성공할 때까지 보존한다.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "../../api";
import {
  draftFromSettings,
  autoShareLabel,
  formatDecimal,
  formatThousands,
  GROUP_COLOR_PALETTE,
  groupColor,
  newDraftGroup,
  newGroupId,
  periodSuffix,
  remainingTone,
  stripDecimal,
  stripThousands,
  TOPUP_DAY_OPTIONS,
  todayLocal,
  topupsOnlyBody,
  validateTopup,
  type CreditPlanDraft,
  type CreditPlanSettings,
  type CreditPlanSaveBody,
  type CreditTopup,
  type DraftGroup,
  type DraftTopup,
  type LimitPeriod,
} from "../../lib/creditPlan";
import { formatCredits as credits } from "../../lib/formatCredits";
import { isHttpStatus, isRouteMissing } from "../../lib/http";
import { manageApi } from "../../lib/manageApi";
import {
  applyProjectRoles,
  creditAccessors,
  fillReorder,
  mainPeople,
  groupAssignBody,
  groupColorBody,
  memberQuotaBody,
  groupEditBody,
  groupTermsBody,
  matchesMemberQuery,
  type MemberTableData,
  type MemberTableGroup,
  type MainPerson,
  type MainPersonEntry,
  type MemberTableRow,
  type SubCreditTable,
} from "../../lib/memberTable";
import { createMutationQueue } from "../../lib/mutationQueue";
import {
  BUDGET_PERIOD_OPTIONS,
  planningBudgetInput,
  planningBudgetPeriod,
  validateProjectPlanning,
} from "../../lib/projectPlanning";
import { defaultProjectRoles, GLOBAL_ROLE_LABEL, PROJECT_ROLE_LABEL, PROJECT_ROLES, type Member } from "../../types";
import { GroupEditor } from "./CreditPlanFields";
import { PROJECT_STATUS_OPTIONS } from "./ProjectPlanningDialog";
import type { Planning } from "./types";
import { mergeCreditPlan } from "../../lib/creditPlanMerge";
import {
  consoleSchedule,
  consoleStatusOf,
  nextRecurringDay,
  PERIOD_UNIT,
  PLAN_STATUS,
  recurringEditBody,
  scheduleLabel,
  STATUS_LABEL as CONSOLE_STATUS_LABEL,
  syncConsoleStatus,
  type ConsoleStatus,
} from "../../lib/workspaceConsole";
import { AddMemberDialog } from "./console/ConsoleSubView";
import { ManageEditCancelled, useManageEditConflict } from "./useManageEditConflict";

const STATUS_LABEL: Record<string, string> = { approved: "승인", pending: "대기", rejected: "거절" };
const short = (label: string | undefined, fallback: string) => (label ? label.split(" · ")[0] : fallback);
// 크레딧 표기는 공용 계약을 따른다(소수 2자리 — 0.12 를 0 으로 찍던 옛 버릇을 막는다). 이름만 짧게 빌린다.
type TableSheet = "members" | "projects" | "groups" | "credits";
const UNASSIGNED = "__unassigned__";
const GLOBAL_ROLE_ORDER = ["admin", "production_director", "product_manager", "member"] as const;
const GLOBAL_ROLE_SET = new Set<string>(GLOBAL_ROLE_ORDER);
const GROUP_COLOR_NAMES = ["라임", "초록", "청록", "시안", "파랑", "인디고", "보라", "핑크", "빨강", "주황", "노랑", "회색"];

interface TableFilters {
  members: { status: string; role: string; project: string };
  projects: { status: string };
  groups: { group: string; sub: string };
  credits: { group: string; usage: string; sub: string }; // sub = 메인 합본에서 고른 서브
}

interface MemberAddState {
  options: Member[];
  projectId: string;
  uid: string;
  roles: string[];
  loading: boolean;
  saving: boolean;
  error: string;
}

interface PlanningDraft {
  baseline: Planning;
  form: Planning;
  budgetInput: string;
  touched: Partial<Record<Exclude<keyof Planning, "project_id"> | "budgetInput", true>>;
}

// 렌더 폴더 칸 — 이 PC 설정(서브스페이스 폴더 창과 같은 API·규칙)
interface FolderCell { root: string; initial: string; selected: string; state: "loading" | "ready" | "saving" | "saved" | "error"; error?: string }

const errorText = (reason: unknown) => String(reason).replace(/^Error:\s*/, "");

const groupColorStyle = (color: string | null | undefined) => ({
  "--mtable-group-color": groupColor(color),
}) as CSSProperties;

function GroupChip({ group }: { group: MemberTableGroup | undefined }) {
  return group ? (
    <span className="mtable-chip mtable-group-chip" style={groupColorStyle(group.color)}>{group.name}</span>
  ) : (
    <span className="mtable-dim">그룹 없음</span>
  );
}

function GroupColorInput({ label, color, disabled, onCommit }: {
  label: string;
  color: string;
  disabled: boolean;
  onCommit: (color: string) => boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const commitRef = useRef(onCommit);
  const colorRef = useRef(color);
  commitRef.current = onCommit;
  colorRef.current = color;

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const commit = () => {
      if (!commitRef.current(input.value)) input.value = colorRef.current;
    };
    // React의 color onChange는 드래그 중 input 이벤트도 받는다. 네이티브 change만 들어 최종 선택색을 저장한다.
    input.addEventListener("change", commit);
    return () => input.removeEventListener("change", commit);
  }, []);
  useEffect(() => {
    if (inputRef.current && inputRef.current.value !== color) inputRef.current.value = color;
  }, [color]);

  return <input ref={inputRef} type="color" aria-label={label} title={label} defaultValue={color} disabled={disabled} />;
}

function GroupColorPicker({ label, color, disabled, onCommit, onEditingChange }: {
  label: string;
  color: string;
  disabled: boolean;
  onCommit: (color: string) => boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editingColor, setEditingColor] = useState(color);
  const commitRef = useRef(onCommit);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const presetIndex = GROUP_COLOR_PALETTE.indexOf(color as typeof GROUP_COLOR_PALETTE[number]);
  const currentColorName = presetIndex >= 0 ? GROUP_COLOR_NAMES[presetIndex] : `커스텀 ${color}`;

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const closeKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const closeScroll = () => setOpen(false);
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeKey);
    window.addEventListener("resize", closeScroll);
    window.addEventListener("scroll", closeScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeKey);
      window.removeEventListener("resize", closeScroll);
      window.removeEventListener("scroll", closeScroll, true);
    };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => { onEditingChange?.(open); }, [open, onEditingChange]);

  const choose = (nextColor: string) => {
    if (disabled) return false;
    const accepted = commitRef.current(nextColor);
    if (accepted) setOpen(false);
    return accepted;
  };
  const toggle = () => {
    if (disabled) return;
    if (!open) { commitRef.current = onCommit; setEditingColor(color); }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) {
      const width = 222;
      const height = 136;
      const below = rect.bottom + 6;
      const top = below + height > window.innerHeight - 8 ? rect.top - height - 6 : below;
      setPosition({ top: Math.max(8, top), left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)) });
    }
    setOpen((current) => !current);
  };

  return (
    <div ref={rootRef} className="mtable-color-picker">
      <button
        ref={buttonRef}
        type="button"
        className="mtable-color-trigger"
        style={{ backgroundColor: color }}
        aria-label={`${label} 색상 선택 (현재 ${currentColorName})`}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={toggle}
      />
      {open ? (
        <div ref={panelRef} className="mtable-color-popover" role="dialog" aria-label={`${label} 색상 팔레트`} style={position}>
          <div className="mtable-color-presets">
            {GROUP_COLOR_PALETTE.map((preset, index) => (
              <button
                key={preset}
                type="button"
                className={preset === color ? "on" : ""}
                style={{ backgroundColor: preset }}
                aria-label={`${GROUP_COLOR_NAMES[index]} 색상`}
                aria-pressed={preset === color}
                onClick={() => choose(preset)}
              />
            ))}
          </div>
          <div className="mtable-color-custom">
            <span>커스텀</span>
            <GroupColorInput label={`${label} 커스텀 색상`} color={editingColor} disabled={disabled} onCommit={choose} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GroupLimitInput({ label, value, disabled, onCommit, onDirtyChange, field = "크레딧 한도", placeholder = "제한 없음", decimals = false }: {
  label: string;
  value: number | null;
  disabled: boolean;
  onCommit: (value: number | null, accepted: (value: number | null) => void) => boolean;
  onDirtyChange?: (dirty: boolean) => void;
  field?: string;       // 읽어 주는 칸 이름 — 그룹 '크레딧 한도' / 사람 '크레딧 몫'(aria 단위 유지, §15)
  placeholder?: string; // 비었을 때의 뜻 — 그룹은 '제한 없음', 사람은 '자동'
  decimals?: boolean;   // 크레딧은 소수다 — 몫·정기 충전은 소수점을 지우면 안 된다(그룹 한도는 서버가 정수만 받는다)
}) {
  const serverValue = value === null ? "" : String(value);
  const [input, setInput] = useState(serverValue);
  const skipCommitRef = useRef(false);
  const dirtyRef = useRef(false);
  const commitRef = useRef(onCommit);
  const originalRef = useRef(value);
  useEffect(() => { if (!dirtyRef.current) setInput(serverValue); }, [serverValue]);
  const finish = (nextValue: number | null) => {
    dirtyRef.current = false;
    originalRef.current = nextValue;
    setInput(nextValue === null ? "" : String(nextValue));
    onDirtyChange?.(false);
  };
  const commit = () => {
    if (skipCommitRef.current) return;
    const next = input ? Number(input) : null;
    if (!dirtyRef.current) return;
    if (next === originalRef.current || !commitRef.current(next, finish)) finish(value);
  };
  return (
    <div className="mtable-group-limit">
      <input
        type="text"
        inputMode="numeric"
        aria-label={`${label} ${field}`}
        placeholder={placeholder}
        maxLength={11}
        value={decimals ? formatDecimal(input) : formatThousands(input)}
        disabled={disabled}
        onFocus={() => { if (!dirtyRef.current) { commitRef.current = onCommit; originalRef.current = value; } }}
        onChange={(event) => {
          if (!dirtyRef.current) { commitRef.current = onCommit; originalRef.current = value; }
          const nextInput = decimals ? stripDecimal(event.target.value) : stripThousands(event.target.value);
          if ((nextInput ? Number(nextInput) : null) === originalRef.current) { finish(value); return; }
          dirtyRef.current = true;
          onDirtyChange?.(true);
          setInput(nextInput);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            skipCommitRef.current = true;
            finish(value);
            event.currentTarget.blur();
            skipCommitRef.current = false;
          }
        }}
      />
    </div>
  );
}

const emptyFilters = (): TableFilters => ({
  members: { status: "", role: "", project: "" },
  projects: { status: "" },
  groups: { group: "", sub: "" },
  credits: { group: "", usage: "", sub: "" },
});

export function MemberTable({ workspaceId = "", reloadSignal = 0 }: { workspaceId?: string; reloadSignal?: number }) {
  const conflict = useManageEditConflict();
  const [data, setData] = useState<MemberTableData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<TableSheet>("members");
  const [filters, setFilters] = useState<TableFilters>(emptyFilters);
  const [memberAdd, setMemberAdd] = useState<MemberAddState | null>(null);
  const [planningEdits, setPlanningEdits] = useState<Record<string, PlanningDraft>>({});
  const [planningBusy, setPlanningBusy] = useState<Set<string>>(new Set());
  const [planningInvalid, setPlanningInvalid] = useState<Set<string>>(new Set()); // 검사에 걸려 저장을 미룬 줄(빨간 표시)
  // 초안의 최신 값 — 칸마다 바로 저장하는 큐가 **실행되는 순간** 읽는다(렌더 전 연달아 고친 칸도 놓치지 않게)
  const planningEditsRef = useRef(planningEdits);
  planningEditsRef.current = planningEdits;
  const [groupEditor, setGroupEditor] = useState<{
    source: CreditPlanSettings;
    draft: CreditPlanDraft;
    group: DraftGroup;
  } | null>(null);
  const [topup, setTopup] = useState<DraftTopup | null>(null);
  const [creditBusy, setCreditBusy] = useState(false);
  const [creditError, setCreditError] = useState("");
  const [retries, setRetries] = useState<{ key: string; label: string; operation: () => Promise<void> }[]>([]);
  const [statusBusy, setStatusBusy] = useState(false); // 서브스페이스 서브 상태 반영 중(서브 전체 — §16)
  const [folders, setFolders] = useState<Record<string, FolderCell>>({}); // 렌더 폴더(이 PC)
  const [dragProject, setDragProject] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false); // 참가시키기 창
  const [subTables, setSubTables] = useState<SubCreditTable[] | null>(null); // 메인 크레딧 시트 합본(서브 관리 표들)
  const subRequestRef = useRef(0);
  const topupSourceRef = useRef<CreditPlanSettings | null>(null);
  const inlineDirtyRef = useRef(new Set<string>());
  const dirtyRef = useRef(false);
  dirtyRef.current = !!groupEditor || !!topup || Object.keys(planningEdits).length > 0 || retries.length > 0;
  const dataRef = useRef(data);
  dataRef.current = data;
  const ownCreditRef = useRef<CreditPlanSettings | null>(null);
  const creditRef = useRef<CreditPlanSettings | null>(null); // 그룹 저장에 쓰는 최신 원문(revision 포함)
  const requestRef = useRef(0);
  // 저장이 걸리거나 끝날 때마다 올린다 — 그 사이에 떠난 조회(reloadSignal 등)는 저장 전 값일 수 있어 버린다.
  // 안 버리면 낡은 revision 이 creditRef 를 덮어 다음 그룹 저장이 409 로 사라진다(코덱스 P1). 큐가 비면 어차피 다시 읽는다.
  const epochRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    const epoch = epochRef.current;
    const stale = () => requestRef.current !== requestId || epochRef.current !== epoch;
    try {
      const next = await manageApi.memberTable(workspaceId || undefined);
      if (stale()) return;
      const previous = dataRef.current;
      const ownCredit = ownCreditRef.current;
      const acknowledgedCredit = ownCredit && ownCredit.workspace_id === next.credit?.workspace_id && ownCredit.plan.revision === next.credit.plan.revision;
      if (previous && (dirtyRef.current || inlineDirtyRef.current.size) && (
        (previous.credit?.plan.revision !== next.credit?.plan.revision && !acknowledgedCredit) ||
        JSON.stringify(previous.projects.map((p) => p.planning)) !== JSON.stringify(next.projects.map((p) => p.planning))
      )) setNotice({ tone: "bad", text: "서버 설정이 갱신됐습니다. 편집 중인 입력과 시작값은 유지했습니다. 저장 시 변경 내용을 확인합니다." });
      creditRef.current = next.credit;
      setData(previous ? {
        ...next,
        groups: [...next.groups, ...previous.groups.filter((group) => (inlineDirtyRef.current.has(group.id) || inlineDirtyRef.current.has(`color:${group.id}`)) && !next.groups.some((item) => item.id === group.id))],
        rows: [...next.rows, ...previous.rows.filter((row) => inlineDirtyRef.current.has(row.email) && !next.rows.some((item) => item.email === row.email))],
      } : next);
      setError("");
    } catch (reason) {
      if (stale()) return;
      if (dataRef.current) {
        setNotice({ tone: "bad", text: `다시 읽지 못했습니다. 입력은 유지했습니다. ${String(reason)}` });
        return;
      }
      setError(
        isRouteMissing(reason)
          ? "이 서버 버전은 관리 표를 지원하지 않습니다. 공유 서버 업데이트 뒤 표시됩니다."
          : isHttpStatus(reason, 403)
            ? "관리 표를 볼 권한이 없습니다(관리자·PM 전용)."
            : `관리 표를 불러오지 못했습니다. ${String(reason)}`,
      );
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load, reloadSignal]);

  useEffect(() => {
    setMemberAdd(null);
    setPlanningEdits({});
    setPlanningBusy(new Set());
    setGroupEditor(null);
    setTopup(null);
    topupSourceRef.current = null;
    ownCreditRef.current = null;
    inlineDirtyRef.current.clear();
    setRetries([]);
    setCreditError("");
    setFolders({});
    setAddOpen(false);
    setDragProject(null);
    // 그룹·서브 필터는 워크스페이스마다 다른 id — 넘어가면 새 표의 줄을 모두 숨길 수 있다(Codex 코드 리뷰)
    setFilters((current) => ({ ...current, groups: { group: "", sub: "" }, credits: { ...current.credits, group: "", sub: "" } }));
  }, [workspaceId]);

  // 메인 크레딧 시트 = 서브 관리 표 합본 — 크레딧 시트를 열었을 때만, 메인 표를 다시 읽을 때마다 서브도 다시 읽는다(같은 계산·같은 숫자).
  // 요청 번호로 늦은 응답(다른 워크스페이스·옛 조회)을 버린다(Codex 설계 검토). 새 합본이 올 때까지 앞 합본을 두고, 워크스페이스·시트가 바뀌면 비운다.
  const mainSubs = data && data.workspace_id === (workspaceId || null) && (sheet === "groups" || (sheet === "credits" && data.credit))
    ? data.console_subs ?? null : null;
  useEffect(() => {
    const requestId = ++subRequestRef.current;
    if (!mainSubs?.length) { setSubTables(mainSubs ? [] : null); return; } // 연결된 서브 0개 = 빈 합본(로딩 아님 — Codex 코드 리뷰)
    void Promise.allSettled(mainSubs.map((id) => manageApi.memberTable(id))).then((settled) => {
      if (subRequestRef.current !== requestId) return;
      setSubTables(mainSubs.map((id, index) => {
        const result = settled[index];
        return result.status === "fulfilled" ? { id, table: result.value, error: "" } : { id, table: null, error: errorText(result.reason) };
      }));
    });
  }, [mainSubs]);

  // 렌더 폴더는 프로젝트 시트를 열 때 활성 프로젝트마다 이 PC 설정을 읽는다(서브스페이스 폴더 창과 같은 API).
  const folderKey = sheet === "projects" && data && data.workspace_id === (workspaceId || null)
    ? data.projects.filter((project) => !project.archived).map((project) => project.id).join("\n") : "";
  useEffect(() => {
    if (!folderKey) return;
    let alive = true;
    for (const id of folderKey.split("\n")) {
      setFolders((current) => ({ ...current, [id]: { root: "", initial: "", selected: "", state: "loading" } }));
      void (async () => {
        let cell: FolderCell = { root: "", initial: "", selected: "", state: "ready" };
        try {
          const folder = await api.projectFolder(id);
          cell = { root: folder.root_path || "", initial: folder.root_path || "", selected: folder.selected_path || "", state: "ready" };
        } catch { /* 읽지 못하면 빈 칸(연결 없음)으로 — 서브스페이스 폴더 창과 같다 */ }
        if (alive) setFolders((current) => ({ ...current, [id]: cell }));
      })();
    }
    return () => { alive = false; };
  }, [folderKey]);

  const loadRef = useRef(load);
  loadRef.current = load;
  const queue = useMemo(
    () =>
      createMutationQueue(
        async (errors) => {
          const conflict = errors.some((reason) => isHttpStatus(reason, 409));
          setNotice({
            tone: "bad",
            text: conflict
              ? "다른 사람이 먼저 바꿨습니다. 최신 값을 다시 읽었습니다."
              : `저장하지 못했습니다. ${String(errors[0])}`,
          });
          await loadRef.current();
        },
        () => loadRef.current(),
      ),
    [],
  );

  // 저장 한 건 — 걸 때와 끝날 때 epoch 를 올려 그 사이의 조회를 무효로 만든다.
  const save = (operation: () => Promise<void>, retained?: { key: string; label: string }) => {
    epochRef.current += 1;
    void queue.enqueue(async () => {
      try {
        await operation();
        if (retained) setRetries((current) => current.filter((retry) => retry.key !== retained.key));
      } catch (reason) {
        if (retained) setRetries((current) => [...current.filter((retry) => retry.key !== retained.key), { ...retained, operation }]);
        throw reason;
      } finally {
        epochRef.current += 1;
      }
    });
  };
  const saveInline = (key: string, label: string, operation: () => Promise<void>) => save(operation, { key, label });
  const saveCredit = async (source: CreditPlanSettings, body: CreditPlanSaveBody) => {
    const own = ownCreditRef.current;
    if (own && own.plan.revision > source.plan.revision) {
      const merged = mergeCreditPlan(source, body, own);
      if (!merged.changes.some((change) => change.conflict)) { source = own; body = merged.value; }
    }
    const saved = await conflict.saveCredit(workspaceId, source, body);
    ownCreditRef.current = saved;
    creditRef.current = saved;
    return saved;
  };
  // 표가 지금 고른 워크스페이스의 것일 때만 고친다 — 전환 직후 이전 표로 새 워크스페이스에 저장하는 일을 막는다(코덱스 P0).
  const inScope = (data?.workspace_id ?? "") === workspaceId;
  // planning 은 이 화면보다 늦게 추가됐다. 권한만 구형 응답과 호환하고, 원문이 없으면 기본값으로 덮지 않게 잠근다.
  const planningDataReady = Boolean(data && data.projects.every((project) => Object.prototype.hasOwnProperty.call(project, "planning")));
  const canPlan = Boolean(data && planningDataReady && (data.caps.planning ?? (data.caps.credit || data.caps.project_roles)));

  const setGroup = (row: MemberTableRow, groupId: string | null) => {
    if (!data || !inScope || !workspaceId || groupId === row.group_id) return;
    const source = data.credit;
    if (!source) return;
    const groupName = data.groups.find((group) => group.id === groupId)?.name ?? "그룹 없음";
    setData({ ...data, rows: data.rows.map((item) => (item.email === row.email ? { ...item, group_id: groupId } : item)) });
    saveInline(`assign:${row.email}`, `${row.name} 그룹: ${groupName}`, async () => {
      await saveCredit(source, groupAssignBody(source, row.email, groupId));
      setNotice({ tone: "ok", text: `저장됨 · 그룹 (${row.name} → ${groupName})` });
    });
  };

  const openGroupEditor = (groupId?: string) => {
    const credit = creditRef.current;
    if (!credit || !inScope || !workspaceId || creditBusy) return;
    const draft = draftFromSettings(credit);
    const group = groupId ? draft.groups.find((item) => item.id === groupId) : newDraftGroup();
    if (!group) return;
    setCreditError("");
    setGroupEditor({ source: credit, draft, group });
  };

  const saveGroupEdit = (edited: DraftGroup, memberEmails: string[]) => {
    if (!groupEditor || !inScope || !workspaceId || creditBusy) return;
    // 창을 연 시점의 revision 과 멤버 배정을 기준으로 보낸다. 최신 조회값과 오래된 창 값을
    // 섞으면 다른 관리자의 변경을 409 없이 되돌릴 수 있다.
    const source = groupEditor.source;
    setCreditBusy(true);
    setCreditError("");
    save(async () => {
      try {
        await saveCredit(source, groupEditBody(source, edited, memberEmails));
        setGroupEditor(null);
        setNotice({ tone: "ok", text: `저장됨 · 그룹 (${edited.name.trim()})` });
      } catch (reason) {
        setCreditError(isHttpStatus(reason, 409)
          ? "다른 곳에서 먼저 바꿨습니다. 입력은 유지했습니다. 다시 저장해 주세요."
          : `그룹을 저장하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
        throw reason;
      } finally {
        setCreditBusy(false);
      }
    });
  };

  const saveGroupColor = (groupId: string, color: string) => {
    if (!data || !inScope || !workspaceId || creditBusy || groupEditor) return false;
    const source = data.credit;
    if (!source) return false;
    const nextColor = groupColor(color);
    setData((current) => current ? {
      ...current,
      groups: current.groups.map((group) => group.id === groupId ? { ...group, color: nextColor } : group),
      credit: current.credit ? {
        ...current.credit,
        groups: current.credit.groups.map((group) => group.id === groupId ? { ...group, color: nextColor } : group),
      } : null,
    } : current);
    setCreditBusy(true);
    setCreditError("");
    saveInline(`color:${groupId}`, `그룹 색상: ${nextColor}`, async () => {
      try {
        await saveCredit(source, groupColorBody(source, groupId, nextColor));
        setNotice({ tone: "ok", text: "저장됨 · 그룹 색상" });
      } catch (reason) {
        setCreditError(isHttpStatus(reason, 409)
          ? "다른 곳에서 먼저 바꿨습니다. 최신 값을 읽었으니 다시 저장해 주세요."
          : `그룹 색상을 저장하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
        throw reason;
      } finally {
        setCreditBusy(false);
      }
    });
    return true;
  };

  /** 정기 크레딧 한 칸 저장(방식·주기·충전일·금액 — 서브스페이스 CreditDialog 와 같은 `recurringPlanBody`, §16).
   *  날짜는 만진 칸일 때만 바꾸고 나머지는 지금 값을 되보낸다. 서브스페이스 서브가 아니면 금액을 비울 때 프로젝트 월 예산 합(파생)으로 돌아간다. */
  const saveRecurring = (
    patch: { value?: number | null; auto?: boolean; period?: LimitPeriod; day?: number; date?: string },
    label: string,
    accepted?: (value: number | null) => void,
  ) => {
    if (!data || !inScope || !workspaceId || creditBusy || groupEditor) return false;
    if (patch.value != null && (!Number.isFinite(patch.value) || patch.value < 0)) return false;
    const source = data.credit;
    if (!source) return false;
    const plan = source.plan;
    // 충전일(달 경계)을 옮기면 이번 주기(사용량·그룹 기간) 경계도 바뀐다 — 서브스페이스 크레딧 창과 같은 경고
    if (patch.day !== undefined && patch.day !== (plan.topup_day ?? 1)) {
      const monthEndNote = patch.day > 28 ? " (없는 날짜는 그 달 마지막 날)" : "";
      if (!window.confirm(`충전일을 매월 ${patch.day}일${monthEndNote}로 바꿀까요?\n이 워크스페이스의 이번 주기(사용량·그룹 기간) 경계도 ${patch.day}일 기준으로 바뀝니다.`)) return false;
    }
    const body = recurringEditBody(source, todayLocal(), patch);
    // 고른 칸이 저장 뒤 재조회 전까지 되돌아 보이지 않게(표시는 재조회 결과가 정한다)
    setData({ ...data, credit: { ...source, plan: {
      ...plan,
      ...(body.recurring_auto !== undefined ? { recurring_auto: body.recurring_auto } : {}),
      ...(body.recurring_period ? { recurring_period: body.recurring_period } : {}),
      ...(body.recurring_anchor !== undefined ? { recurring_anchor: body.recurring_anchor } : {}),
      ...(body.topup_day !== undefined ? { topup_day: body.topup_day } : {}),
    } } });
    setCreditBusy(true);
    setCreditError("");
    saveInline("recurring", `정기 크레딧: ${label}`, async () => {
      try {
        const saved = await saveCredit(source, body);
        accepted?.(saved.plan.recurring_topup ?? null);
        setNotice({ tone: "ok", text: patch.value === null && !data.console_limit ? "저장됨 · 정기 크레딧을 프로젝트 예산 한도 합으로" : `저장됨 · 정기 크레딧 (${label})` });
      } catch (reason) {
        setCreditError(isHttpStatus(reason, 409)
          ? "다른 곳에서 먼저 바꿨습니다. 최신 값을 읽었으니 다시 저장해 주세요."
          : `정기 크레딧을 저장하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
        throw reason;
      } finally {
        setCreditBusy(false);
      }
    });
    return true;
  };

  /** 사람별 몫 한 칸 저장 — 비우면(null) 그룹 인당 한도로 돌아간다.
   *  소속은 건드리지 않는다(본문에 group_id 키를 싣지 않는다). */
  const saveMemberQuota = (email: string, quota: number | null, accepted?: (value: number | null) => void) => {
    if (!data || !inScope || !workspaceId || creditBusy || groupEditor) return false;
    if (quota !== null && (!Number.isFinite(quota) || quota < 0)) return false;
    const source = data.credit;
    if (!source) return false;
    setCreditBusy(true);
    setCreditError("");
    saveInline(`quota:${email}`, `${email} 몫: ${quota ?? "자동"}`, async () => {
      try {
        const saved = await saveCredit(source, memberQuotaBody(source, email, quota));
        accepted?.(saved.members.find((member) => member.email === email)?.quota ?? null);
        setNotice({ tone: "ok", text: quota === null ? "저장됨 · 할당 크레딧을 자동으로" : "저장됨 · 할당 크레딧" });
      } catch (reason) {
        setCreditError(isHttpStatus(reason, 409)
          ? "다른 곳에서 먼저 바꿨습니다. 최신 값을 읽었으니 다시 저장해 주세요."
          : `할당 크레딧을 저장하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
        throw reason;
      } finally {
        setCreditBusy(false);
      }
    });
    return true;
  };

  const saveGroupTerms = (groupId: string, monthlyLimit: number | null, limitPeriod: LimitPeriod, accepted?: (value: number | null) => void) => {
    if (!data || !inScope || !workspaceId || creditBusy || groupEditor) return false;
    const current = data.groups.find((group) => group.id === groupId);
    if (!current || monthlyLimit !== null && (!Number.isInteger(monthlyLimit) || monthlyLimit < 0)) return false;
    if (current.monthly_limit === monthlyLimit && (current.limit_period ?? "month") === limitPeriod) return true;
    const source = data.credit;
    if (!source) return false;
    const updateGroup = <T extends { id: string; monthly_limit: number | null; limit_period?: LimitPeriod }>(group: T): T => (
      group.id === groupId ? { ...group, monthly_limit: monthlyLimit, limit_period: limitPeriod } : group
    );
    setData((value) => value ? {
      ...value,
      groups: value.groups.map(updateGroup),
      credit: value.credit ? { ...value.credit, groups: value.credit.groups.map(updateGroup) } : null,
    } : value);
    setCreditBusy(true);
    setCreditError("");
    saveInline(`terms:${groupId}`, `${current.name} 한도: ${monthlyLimit ?? "∞"} (${limitPeriod})`, async () => {
      try {
        const saved = await saveCredit(source, groupTermsBody(source, groupId, monthlyLimit, limitPeriod));
        accepted?.(saved.groups.find((group) => group.id === groupId)?.monthly_limit ?? null);
        setNotice({ tone: "ok", text: "저장됨 · 그룹 한도" });
      } catch (reason) {
        setCreditError(isHttpStatus(reason, 409)
          ? "다른 곳에서 먼저 바꿨습니다. 최신 값을 읽었으니 다시 저장해 주세요."
          : `그룹 한도를 저장하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
        throw reason;
      } finally {
        setCreditBusy(false);
      }
    });
    return true;
  };

  const startTopup = () => {
    if (!data?.credit || !inScope || !workspaceId) return;
    setCreditError("");
    topupSourceRef.current = data.credit;
    setTopup({ id: newGroupId(), day: todayLocal(), creditsInput: "", note: "" });
  };

  const editTopup = (item: CreditTopup) => {
    if (!inScope || !workspaceId || creditBusy || topup) return;
    setCreditError("");
    topupSourceRef.current = data?.credit ?? null;
    setTopup({ id: item.id, day: item.day, creditsInput: String(item.credits), note: item.note || "" });
  };

  const saveTopup = () => {
    if (!topup || !inScope || !workspaceId || creditBusy) return;
    const invalid = validateTopup(topup);
    if (invalid) {
      setCreditError(invalid);
      return;
    }
    const pending = { ...topup };
    const source = topupSourceRef.current;
    if (!source) return;
    setCreditBusy(true);
    setCreditError("");
    save(async () => {
      try {
        const draft = draftFromSettings(source);
        const editing = draft.topups.some((item) => item.id === pending.id);
        const nextTopups = editing
          ? draft.topups.map((item) => item.id === pending.id ? pending : item)
          : [pending, ...draft.topups];
        await saveCredit(
          source,
          topupsOnlyBody(draft, nextTopups),
        );
        setTopup(null);
        setNotice({ tone: "ok", text: editing ? "저장됨 · 추가 크레딧 수정" : `저장됨 · 추가 크레딧 +${formatThousands(pending.creditsInput)}` });
      } catch (reason) {
        setCreditError(isHttpStatus(reason, 409)
          ? "다른 곳에서 먼저 바꿨습니다. 최신 값을 읽었으니 다시 저장해 주세요."
          : `크레딧을 저장하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
        throw reason;
      } finally {
        setCreditBusy(false);
      }
    });
  };

  const deleteTopup = (item: CreditTopup) => {
    if (!inScope || !workspaceId || creditBusy || topup) return;
    if (!window.confirm(`${item.day} 추가 크레딧 ${credits(item.credits)}을 삭제할까요?`)) return;
    const source = data?.credit;
    if (!source) return;
    setCreditBusy(true);
    setCreditError("");
    saveInline(`delete-topup:${item.id}`, `${item.day} 추가 크레딧 삭제`, async () => {
      try {
        const draft = draftFromSettings(source);
        const nextTopups = draft.topups.filter((topupItem) => topupItem.id !== item.id);
        if (nextTopups.length === draft.topups.length) throw new Error("삭제할 추가 크레딧 기록을 찾지 못했습니다");
        await saveCredit(source, topupsOnlyBody(draft, nextTopups));
        setNotice({ tone: "ok", text: "저장됨 · 추가 크레딧 삭제" });
      } catch (reason) {
        setCreditError(isHttpStatus(reason, 409)
          ? "다른 곳에서 먼저 바꿨습니다. 최신 값을 읽었으니 다시 삭제해 주세요."
          : `추가 크레딧을 삭제하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
        throw reason;
      } finally {
        setCreditBusy(false);
      }
    });
  };

  const toggleRole = (row: MemberTableRow, project: { id: string; name: string }, role: string) => {
    const uid = row.uid;
    if (!data || !inScope || !uid) return;
    const current = row.projects[project.id] || [];
    const roles = current.includes(role) ? current.filter((item) => item !== role) : [...current, role];
    // 마지막 역할을 빼면 프로젝트에서 제거 — 제거 기록이 남아 워크스페이스 자동 편입이 되살리지 못한다.
    if (!roles.length && !window.confirm(`${row.name} 님을 '${project.name}' 에서 뺄까요?\n자동 편입으로는 다시 들어오지 않습니다(역할을 다시 주면 돌아옵니다).`)) return;
    setData({ ...data, rows: applyProjectRoles(data.rows, uid, project.id, roles) });
    save(async () => {
      if (roles.length) await api.setProjectRoles(project.id, uid, roles);
      else await api.removeProjectMember(project.id, uid);
      setNotice({ tone: "ok", text: `저장됨 · ${project.name} (${row.name})` });
    });
  };

  const availableMembers = (options: Member[], projectId: string) => options.filter((member) =>
    !data?.rows.some((row) => row.uid === member.uid && Object.prototype.hasOwnProperty.call(row.projects, projectId))
  );

  const startMemberAdd = async () => {
    const projectId = data?.projects.find((project) => !project.archived)?.id; // 보관 프로젝트엔 넣지 않는다
    if (!data || !inScope || !workspaceId || !data.caps.project_roles || !projectId) return;
    setMemberAdd({ options: [], projectId, uid: "", roles: [], loading: true, saving: false, error: "" });
    try {
      const byUid = new Map<string, Member>();
      for (const member of await api.members()) {
        if (member.status === "approved" && member.email && member.uid && !member.uid.startsWith("acct:")) {
          byUid.set(member.uid, member);
        }
      }
      const options = [...byUid.values()];
      const first = availableMembers(options, projectId)[0];
      setMemberAdd({
        options,
        projectId,
        uid: first?.uid ?? "",
        roles: first ? (defaultProjectRoles(first.global_roles).length ? defaultProjectRoles(first.global_roles) : ["creator"]) : [],
        loading: false,
        saving: false,
        error: "",
      });
    } catch (reason) {
      setMemberAdd({ options: [], projectId, uid: "", roles: [], loading: false, saving: false, error: `계정 목록을 불러오지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}` });
    }
  };

  const pickMemberProject = (projectId: string) => setMemberAdd((current) => {
    if (!current) return current;
    const first = availableMembers(current.options, projectId)[0];
    return {
      ...current,
      projectId,
      uid: first?.uid ?? "",
      roles: first ? (defaultProjectRoles(first.global_roles).length ? defaultProjectRoles(first.global_roles) : ["creator"]) : [],
      error: "",
    };
  });

  const pickMember = (uid: string) => setMemberAdd((current) => {
    if (!current) return current;
    const member = current.options.find((item) => item.uid === uid);
    const roles = defaultProjectRoles(member?.global_roles);
    return { ...current, uid, roles: roles.length ? roles : ["creator"], error: "" };
  });

  const saveMemberAdd = () => {
    if (!memberAdd || !memberAdd.uid || !memberAdd.projectId || !memberAdd.roles.length || memberAdd.saving || !inScope) return;
    const pending = memberAdd;
    const member = pending.options.find((item) => item.uid === pending.uid);
    const project = data?.projects.find((item) => item.id === pending.projectId);
    setMemberAdd({ ...pending, saving: true, error: "" });
    save(async () => {
      try {
        await api.setProjectRoles(pending.projectId, pending.uid, pending.roles);
        setMemberAdd(null);
        setNotice({ tone: "ok", text: `저장됨 · ${project?.name ?? "프로젝트"} (${member?.name || member?.email || pending.uid})` });
      } catch (reason) {
        setMemberAdd((current) => current ? { ...current, saving: false, error: `멤버를 추가하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}` } : current);
        throw reason;
      }
    });
  };

  const setEdits = (update: (edits: Record<string, PlanningDraft>) => Record<string, PlanningDraft>) => {
    planningEditsRef.current = update(planningEditsRef.current);
    setPlanningEdits(planningEditsRef.current);
  };

  const planningDraft = (project: MemberTableData["projects"][number]): PlanningDraft => {
    const saved = planningEditsRef.current[project.id];
    if (saved) return saved;
    const form: Planning = {
      status: project.planning?.status || "active",
      start_date: project.planning?.start_date || null,
      due_date: project.planning?.due_date || null,
      budget_credits: project.planning?.budget_credits ?? null,
      budget_period: planningBudgetPeriod(project.planning),
      archive_after_days: project.planning?.archive_after_days ?? 30,
      note: project.planning?.note || null,
    };
    return { baseline: project.planning ?? {}, form, budgetInput: planningBudgetInput(form), touched: {} };
  };

  const editPlanning = (project: MemberTableData["projects"][number], patch: Partial<Planning>, budgetInput?: string) => {
    const current = planningDraft(project);
    const touched = { ...current.touched };
    for (const key of Object.keys(patch) as Exclude<keyof Planning, "project_id">[]) touched[key] = true;
    if (budgetInput !== undefined) touched.budgetInput = true;
    setEdits((edits) => ({
      ...edits,
      [project.id]: { ...current, form: { ...current.form, ...patch }, budgetInput: budgetInput ?? current.budgetInput, touched },
    }));
  };

  /** 프로젝트 설정 칸 저장(적용 단추 없이 — Jay 2026-09-30). 날짜·선택은 고르는 순간, 글자·숫자 칸은 칸을 나가거나 Enter 에서 부른다.
   *  큐가 **실행될 때** 그 줄의 최신 초안을 읽어 저장한다(읽은 기준 + 바뀐 칸, 409 는 병합 창 — 종전 '적용'과 같은 경로).
   *  저장 도중 또 고쳤으면 그 초안은 남기고 기준만 새 revision 으로 옮겨 다음 저장이 이어 간다. 검사에 걸리면 줄을 빨갛게 두고 저장하지 않는다. */
  const queuePlanningSave = (projectId: string) => {
    if (!data || !inScope || !canPlan) return;
    save(async () => {
      const draft = planningEditsRef.current[projectId];
      const project = dataRef.current?.projects.find((item) => item.id === projectId);
      if (!draft || !project) return; // 앞선 저장이 이미 가져갔다
      const result = validateProjectPlanning(draft.form, draft.budgetInput);
      if (!result.planning) {
        setPlanningInvalid((current) => new Set(current).add(projectId));
        setNotice({ tone: "bad", text: `${project.name} — ${result.error} 고치면 바로 저장됩니다.` });
        return;
      }
      setPlanningInvalid((current) => { if (!current.has(projectId)) return current; const next = new Set(current); next.delete(projectId); return next; });
      setPlanningBusy((busy) => new Set(busy).add(projectId));
      try {
        const planning = await conflict.savePlanning(projectId, draft.baseline, result.planning);
        setData((current) => current ? { ...current, projects: current.projects.map((item) => item.id === projectId ? { ...item, planning } : item) } : current);
        setEdits((edits) => {
          const latest = edits[projectId];
          const next = { ...edits };
          if (latest === draft) delete next[projectId];
          else if (latest) next[projectId] = { ...latest, baseline: planning };
          return next;
        });
        setNotice({ tone: "ok", text: `저장됨 · 프로젝트 설정 (${project.name})` });
      } finally {
        setPlanningBusy((busy) => { const next = new Set(busy); next.delete(projectId); return next; });
      }
    });
  };
  const commitPlanning = (project: MemberTableData["projects"][number], patch: Partial<Planning>) => {
    editPlanning(project, patch);
    queuePlanningSave(project.id);
  };
  /** 글자·숫자 칸의 Enter = 칸 나가기(나갈 때 저장한다) */
  const blurOnEnter = (event: { key: string; currentTarget: HTMLInputElement }) => {
    if (event.key === "Enter") event.currentTarget.blur();
  };

  /** 서브스페이스 서브 상태(활성·비활성·완료) — '적용' 초안이 아니라 바로 실행한다(§16 합의 2). 서브 전체에 적용되고,
   *  서브스페이스와 같은 공용 `syncConsoleStatus` 를 부른다. 끝나면 그 서브 프로젝트들의 초안을 버리고 표를 다시 읽는다. */
  const changeConsoleStatus = (target: MemberTableData["projects"][number], status: ConsoleStatus) => {
    if (!data || !inScope || !workspaceId || statusBusy) return;
    // 메인을 고르면 여러 서브가 섞인다 — 그 줄의 서브에만 적용(구서버는 workspace_id 가 없어 고른 워크스페이스)
    const subId = target.workspace_id ?? workspaceId;
    const projects = data.projects.filter((project) => project.console_managed && (project.workspace_id ?? workspaceId) === subId);
    const name = target.workspace_name ?? projects.find((project) => project.console_limit)?.console_limit?.workspace_name ?? data.console_limit?.workspace_name ?? "이 워크스페이스";
    if (!window.confirm(`'${name}' 서브 전체(프로젝트 ${projects.length}개)의 상태를 '${CONSOLE_STATUS_LABEL[status]}'(으)로 바꿀까요?\n서브스페이스와 같게 바로 적용됩니다${status === "done" ? " — 완료하면 프로젝트를 보관합니다" : ""}.`)) return;
    setStatusBusy(true);
    save(async () => {
      try {
        await syncConsoleStatus(subId, projects.map((project) => ({ id: project.id, archived: Boolean(project.archived) })), status, {
          consoleSetStatus: manageApi.consoleSetStatus, updateProject: api.updateProject, getPlanning: manageApi.getPlanning, savePlanning: conflict.savePlanning,
        });
        setNotice({ tone: "ok", text: `저장됨 · 상태 ${CONSOLE_STATUS_LABEL[status]} (${name})` });
        // 성공했을 때만 그 서브 프로젝트들의 초안을 버린다 — 실패면 적어 둔 기간·메모 초안을 지키고 다시 시도하게(Codex 코드 리뷰)
        setPlanningEdits((edits) => {
          const next = { ...edits };
          for (const project of projects) delete next[project.id];
          return next;
        });
      } catch (reason) {
        // 부분 실패여도 각 단계가 멱등이라 같은 상태를 다시 고르면 수렴한다. 이름 충돌(409) 등 서버 문구는 그대로 보인다.
        if (!(reason instanceof ManageEditCancelled)) {
          setNotice({ tone: "bad", text: `${name} 상태 반영이 끝나지 않았습니다 — 같은 상태를 다시 골라 주세요. ${errorText(reason)}` });
        }
      } finally {
        setStatusBusy(false);
      }
    });
  };

  /** 렌더 폴더 저장(이 PC) — 서브스페이스 폴더 창과 같은 규칙: 루트가 그대로면 고른 하위 폴더 유지, 바뀌면 비움, 비우면 연결 해제. */
  const saveFolder = async (projectId: string) => {
    const cell = folders[projectId];
    if (!cell || cell.state === "saving" || !canPlan || cell.root.trim() === cell.initial) return;
    const root = cell.root.trim();
    setFolders((current) => ({ ...current, [projectId]: { ...cell, state: "saving", error: "" } }));
    try {
      const state = await api.setProjectFolder(projectId, { root_path: root, selected_path: root && root === cell.initial ? cell.selected : "" });
      setFolders((current) => ({ ...current, [projectId]: { root: state.root_path || "", initial: state.root_path || "", selected: state.selected_path || "", state: "saved" } }));
    } catch (reason) {
      setFolders((current) => ({ ...current, [projectId]: { ...cell, state: "error", error: errorText(reason) } }));
    }
  };

  /** 프로젝트 줄 끌기 — 전체 활성 목록을 새로 읽고, 이 워크스페이스 활성 프로젝트가 있던 자리에만 새 순서를 채운다(§16 합의 4).
   *  다른 워크스페이스·보관 프로젝트는 건드리지 않고 보관 ID 는 본문에 넣지 않는다. */
  const moveProject = (fromId: string, toId: string) => {
    if (!data || !inScope || !workspaceId || fromId === toId) return;
    const order = data.projects.filter((project) => !project.archived).map((project) => project.id).filter((id) => id !== fromId);
    const at = order.indexOf(toId);
    if (at < 0) return;
    order.splice(at, 0, fromId);
    save(async () => {
      const all = await api.projects("team", true);
      const next = fillReorder(all.projects.filter((project) => !project.archived).map((project) => project.id), order);
      if (!next) throw new Error("프로젝트 목록이 그 사이 바뀌었습니다. 다시 읽은 뒤 옮겨 주세요.");
      await api.reorderProjects(next);
      setNotice({ tone: "ok", text: "저장됨 · 프로젝트 순서" });
    });
  };

  /** 참가시키기 — 서브스페이스와 같은 창·같은 본문(`groupAssignBody`). 창이 결과를 기다려 오류를 보인다. */
  const addParticipant = (email: string, groupId: string) => new Promise<void>((resolve, reject) => {
    const source = data?.credit;
    if (!source || !inScope || !workspaceId) { reject(new Error("크레딧 설정을 다시 읽은 뒤 해 주세요.")); return; }
    save(async () => {
      try {
        await saveCredit(source, groupAssignBody(source, email, groupId));
        setNotice({ tone: "ok", text: `저장됨 · 참가자 (${email})` });
        resolve();
      } catch (reason) {
        reject(reason);
        throw reason;
      }
    });
  });

  if (error) return <div className="usage-error">{error}</div>;
  if (!data) return <div className="usage-loading">관리 표를 불러오는 중…</div>;

  const groupById = new Map(data.groups.map((group) => [group.id, group]));
  // 그룹 배정 칸 — 그룹 시트·크레딧 시트가 같은 칸(같은 `groupAssignBody` 저장, §16)
  const groupCell = (row: MemberTableRow) => {
    const group = row.group_id ? groupById.get(row.group_id) : undefined;
    return canGroup ? (
      <span className="mtable-group-select">
        <select
          className={group ? "mtable-chip mtable-group-chip" : undefined}
          style={group ? groupColorStyle(group.color) : undefined}
          aria-label={`${row.name} 크레딧 그룹`}
          value={row.group_id ?? ""}
          onChange={(event) => setGroup(row, event.target.value || null)}
        >
          <option value="">그룹 없음</option>
          {data.groups.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
      </span>
    ) : (
      <GroupChip group={group} />
    );
  };
  // 보관 프로젝트는 프로젝트 시트에만(흐리게) — 멤버 시트 역할 칸·필터·멤버 추가·합계에서는 뺀다(§16 합의 3)
  const activeProjects = data.projects.filter((project) => !project.archived);
  const archivedCount = data.projects.length - activeProjects.length;
  const canReorder = data.caps.credit && inScope && !statusBusy; // 서브스페이스 순서 바꾸기와 같은 권한(프로젝트 생성)
  // 몫·사용 읽기 — 메인 합본(서브 표마다)과 같은 계산(lib `creditAccessors`, 구서버면 칸을 잠근다)
  const { quotaSupported, quotaOf, unlimitedOf, usageOf } = creditAccessors(data);
  const quotaLock = quotaSupported ? "" : "공유 서버를 업데이트하면 사람별 할당 크레딧을 정할 수 있습니다";
  // 그룹·사용 상태 필터 — 그룹·크레딧 시트와 메인 합본(서브 표마다 그 표의 사용 계산)이 같이 쓴다
  const groupPass = (row: MemberTableRow, groupFilter: string) =>
    !(groupFilter === UNASSIGNED ? row.group_id : groupFilter && row.group_id !== groupFilter);
  const usagePass = (used: MemberTableRow["usage"]) => {
    const usage = filters.credits.usage;
    if (usage === "used") return Boolean(used && used.credits > 0);
    if (usage === "unused") return Boolean(used && used.credits === 0);
    return usage !== "unknown" || Boolean(used && used.unknown > 0);
  };
  const rows = data.rows.filter((row) => {
    if (sheet === "projects") return true;
    if (!matchesMemberQuery(row, query)) return false;
    if (sheet === "members") {
      const filter = filters.members;
      if (filter.status && (row.status ?? "none") !== filter.status) return false;
      if (filter.role && !row.global_roles.includes(filter.role)) return false;
      if (filter.project && !(row.projects[filter.project]?.length)) return false;
    } else {
      if (!groupPass(row, sheet === "groups" ? filters.groups.group : filters.credits.group)) return false;
      if (sheet === "credits" && !usagePass(usageOf(row))) return false;
    }
    return true;
  });
  // 메인 크레딧·그룹 시트 = 서브 관리 표 합본(Jay 2026-09-30) — 서버가 서브 목록을 줄 때만(구서버는 종전 메인 표).
  // 줄 = 계정 하나. 그 사람이 속한 서브만 '서브 / 그룹' 칩으로, 숫자는 서브 값을 더한다(lib `mainPeople`) — 서브마다 기간이 달라 칸 툴팁에 서브별 값.
  const mainGroups = sheet === "groups" && Boolean(data.console_subs);
  const mainCredit = sheet === "credits" && Boolean(data.console_subs) && Boolean(data.credit);
  const mainBlocked = sheet === "credits" && Boolean(data.console_subs) && !data.credit;
  const mainView = mainGroups || mainCredit;
  const mainFilter = sheet === "groups" ? filters.groups : filters.credits;
  const subName = (sub: SubCreditTable) => sub.table?.console_limit?.workspace_name
    ?? data.projects.find((project) => project.workspace_id === sub.id)?.workspace_name ?? sub.id;
  // 지금 메인 목록에 있는 서브만(다시 읽는 사이 내린 서브의 옛 합본은 빼고), 고른 서브가 목록에서 빠졌으면 전체로
  const liveSubs = (subTables ?? []).filter((sub) => data.console_subs?.includes(sub.id));
  const subFilter = liveSubs.some((sub) => sub.id === mainFilter.sub) ? mainFilter.sub : "";
  const shownSubs = liveSubs.filter((sub) => !subFilter || sub.id === subFilter);
  const mainGroupFilter = mainFilter.group === UNASSIGNED || shownSubs.some((sub) => sub.table?.groups.some((group) => group.id === mainFilter.group))
    ? mainFilter.group : "";
  // 크레딧 시트는 크레딧을 읽은 서브만 더한다(못 읽은 서브는 따로 줄) · 그룹 시트는 배정만 보므로 크레딧 없이도
  const mainPersons = mainView ? mainPeople(mainCredit ? shownSubs.filter((sub) => sub.table?.credit) : shownSubs).filter((person) =>
    person.entries.some((entry) => matchesMemberQuery(entry.row, query))
    && (mainGroupFilter === UNASSIGNED ? !person.grouped : !mainGroupFilter || person.entries.some((entry) => entry.row.group_id === mainGroupFilter))
    && (!mainCredit || usagePass(person.used))) : [];
  const failedSubs = shownSubs.filter((sub) => (mainCredit ? !sub.table?.credit : !sub.table));
  const subGroupChips = (person: MainPerson) => (
    <span className="mtable-sub-groups">
      {person.entries.map((entry) => (
        <span key={entry.sub.id} className="mtable-sub-group">
          <span className="admin-badge proj-workspace-badge">{subName(entry.sub)}</span><span className="mtable-muted">/</span><GroupChip group={entry.group} />
        </span>
      ))}
    </span>
  );
  // 합친 칸의 툴팁 — 서브마다의 값(기간이 서로 다를 수 있다)
  const perSub = (person: MainPerson, value: (entry: MainPersonEntry) => string) => person.entries.map((entry) => `${subName(entry.sub)} ${value(entry)}`).join(" · ");
  const mainTopups = shownSubs
    .flatMap((sub) => (sub.table?.credit?.topups ?? []).map((item) => ({ sub, item })))
    .sort((a, b) => b.item.day.localeCompare(a.item.day));
  const mainRecurring = new Map<LimitPeriod, number>(); // 서브 정기 크레딧 합계 — 주기가 다르면 주기별로
  for (const sub of shownSubs) {
    const limit = sub.table?.console_limit;
    if (limit?.credits) mainRecurring.set(limit.period, (mainRecurring.get(limit.period) ?? 0) + limit.credits);
  }
  const filteredProjects = data.projects.filter((project) => {
    if (query.trim() && !project.name.toLowerCase().includes(query.trim().toLowerCase())) return false;
    return !filters.projects.status || (project.planning?.status || "active") === filters.projects.status;
  });
  // 보이는 프로젝트가 모두 서브스페이스 서브면 칸 이름도 서브스페이스 서브 표와 같게(다음 할당일 · 남은/할당 크레딧)
  const consoleColumns = filteredProjects.length > 0 && filteredProjects.every((project) => project.console_managed);
  const memberCandidates = memberAdd ? availableMembers(memberAdd.options, memberAdd.projectId) : [];
  const canGroup = data.caps.credit && Boolean(data.credit);
  const lock = (can: boolean, why: string) => (can ? undefined : why);
  const topups = data.credit?.topups ?? [];
  const topupTotal = topups.reduce((sum, topup) => sum + topup.credits, 0);
  const todayDay = Number(todayLocal().slice(8, 10));
  // 정기 크레딧 편집 칸의 지금 값 — 구서버의 빈 방식·주기는 자동·월(§16 합의 1)
  const recurring = (() => {
    const plan = data.credit?.plan;
    const auto = plan?.recurring_auto ?? true;
    const period: LimitPeriod = plan?.recurring_period ?? "month";
    const schedule = { recurring_auto: auto, recurring_period: period, recurring_anchor: plan?.recurring_anchor ?? null, topup_day: plan?.topup_day ?? 1 };
    return {
      auto,
      period,
      monthly: !auto || period === "month",
      day: plan?.topup_day ?? 1,
      next: data.console_limit?.next_topup_day !== undefined ? data.console_limit.next_topup_day : plan ? nextRecurringDay(plan, todayLocal()) : null,
      label: scheduleLabel(schedule),
      lock: !canGroup || creditBusy || Boolean(groupEditor),
    };
  })();
  const recurringTopup = data.credit?.plan.monthly_topup ?? null;
  // 정기 충전은 손 입력이 우선이고, 비면 프로젝트 '매월 예산' 합에서 파생한다(Jay 2026-09-23).
  const derivedTopup = data.credit?.plan.derived_topup ?? null;
  const manualTopup = data.credit?.plan.monthly_topup_source === "manual";
  // 고른 워크스페이스가 서브스페이스 서브면 정기 크레딧·충전 기간은 서브스페이스 값(읽기 전용, 설계 §14)
  const consoleCredit = data.console_limit ?? null;
  const cycleRange = consoleCredit ? `${consoleCredit.cycle_start} ~ ${consoleCredit.cycle_end}`
    : data.cycle_start && data.cycle_end ? `${data.cycle_start} ~ ${data.cycle_end}` : "—";
  const topupEditorRow = (draft: DraftTopup, label: string) => (
    <tr key={`editor-${draft.id}`} className="mtable-topup-row" aria-label={label}>
      <td><input type="date" aria-label="추가 크레딧 날짜" disabled={creditBusy} value={draft.day} onChange={(event) => setTopup({ ...draft, day: event.target.value })} /></td>
      <td><span className="mtable-chip mtable-charge-kind emergency">추가 크레딧</span></td>
      <td>—</td>
      <td>
        <input
          type="text"
          inputMode="numeric"
          aria-label="추가 크레딧"
          disabled={creditBusy}
          value={formatThousands(draft.creditsInput)}
          placeholder="크레딧"
          onChange={(event) => setTopup({ ...draft, creditsInput: stripThousands(event.target.value) })}
        />
      </td>
      <td><input aria-label="추가 크레딧 메모" disabled={creditBusy} value={draft.note} placeholder="메모 (선택)" onChange={(event) => setTopup({ ...draft, note: event.target.value })} /></td>
      <td>
        <div className="mtable-topup-actions">
          <button type="button" className="mtable-add" disabled={creditBusy} onClick={saveTopup}>{creditBusy ? "저장 중…" : "저장"}</button>
          <button type="button" className="mtable-cancel" disabled={creditBusy} onClick={() => { setTopup(null); setCreditError(""); }}>취소</button>
        </div>
      </td>
    </tr>
  );
  const groupMemberTotal = data.groups.reduce((sum, group) => sum + group.member_count, 0);
  // 그룹의 이번 기간 사용 — 서브스페이스 그룹 탭과 같은 값(used_period, 구서버는 크레딧 설정의 used_month)
  const groupUsed = (group: MemberTableGroup) => group.used_period
    ?? data.credit?.groups.find((item) => item.id === group.id)?.used_period ?? data.credit?.groups.find((item) => item.id === group.id)?.used_month ?? null;
  // 그룹 몫 합계(∞ 그룹 제외) — 구서버(quota_total 없음)면 null(—)
  const quotaTotal = data.groups.reduce<number | null>((sum, group) => (group.quota_total == null ? sum : (sum ?? 0) + group.quota_total), null);
  const groupUsedTotal = data.rows.reduce((sum, row) => sum + (row.usage?.credits ?? 0), 0);
  // 남음 합계는 기간이 같은 그룹끼리만 뜻이 있다 — 월·주·일이 섞이면 합치지 않는다(§15 리뷰)
  const limitedGroups = data.groups.filter((group) => group.remaining != null);
  const remainingPeriods = new Set(limitedGroups.map((group) => group.limit_period ?? "month"));
  const groupRemainingTotal = remainingPeriods.size > 1 ? null : limitedGroups.reduce((sum, group) => sum + (group.remaining ?? 0), 0);
  // 월 예산 합 = 서브스페이스 서브가 아닌 프로젝트의 월 예산 + 서로 다른 서브스페이스 서브의 월 정기 크레딧(서브마다 한 번, 설계 §13)
  const listedMonthlyBudgets = activeProjects.filter((project) => !project.console_limit && planningBudgetPeriod(project.planning) === "month");
  const consoleMonthly = [...new Map(activeProjects.filter((project) => project.console_limit?.period === "month" && project.console_limit.credits != null)
    .map((project) => [project.console_limit!.workspace_id, project.console_limit!.credits ?? 0])).values()];
  const listedMonthlyBudgetTotal = listedMonthlyBudgets.reduce((sum, project) => sum + (project.planning?.budget_credits ?? 0), 0)
    + consoleMonthly.reduce((sum, value) => sum + value, 0);
  const projectBudgetSet = consoleMonthly.length > 0 || listedMonthlyBudgets.some((project) => project.planning?.budget_credits != null);
  const scheduledProjects = activeProjects.filter((project) => project.planning?.start_date || project.planning?.due_date).length;
  const statuses = [...new Set(data.rows.map((row) => row.status ?? "none"))];
  const roleSet = new Set(data.rows.flatMap((row) => row.global_roles));
  const roles = [...GLOBAL_ROLE_ORDER.filter((role) => roleSet.has(role)), ...[...roleSet].filter((role) => !GLOBAL_ROLE_SET.has(role))];
  const filtersActive = sheet === "members"
    ? Object.values(filters.members).some(Boolean)
    : sheet === "projects"
      ? Boolean(filters.projects.status)
    : sheet === "groups"
      ? Object.values(filters.groups).some(Boolean)
      : Object.values(filters.credits).some(Boolean);

  const clearSheetFilters = () => setFilters((current) => {
    if (sheet === "members") return { ...current, members: { status: "", role: "", project: "" } };
    if (sheet === "projects") return { ...current, projects: { status: "" } };
    if (sheet === "groups") return { ...current, groups: { group: "", sub: "" } };
    return { ...current, credits: { group: "", usage: "", sub: "" } };
  });

  return (
    <div className="mtable">
      {conflict.dialog}
      {retries.map((retry) => <div className="mtable-notice bad" role="status" key={retry.key}>
        미저장 입력: {retry.label}
        <button type="button" disabled={creditBusy || conflict.active} onClick={() => {
          setCreditBusy(true);
          save(async () => { try { await retry.operation(); } finally { setCreditBusy(false); } }, retry);
        }}>입력 유지 · 다시 저장</button>
      </div>)}
      <div className="mtable-bar">
        <b>{sheet === "members" ? "멤버 관리" : sheet === "projects" ? "프로젝트 관리" : sheet === "groups" ? "그룹 관리" : "크레딧 관리"}</b>
        <span className="mtable-hint">
          {sheet === "members" ? "사람·계정·프로젝트 참여" : sheet === "projects" ? "기간·예산·보관 설정" : sheet === "groups" ? "그룹별 한도와 참가자 배정" : "정기·추가 크레딧과 개인별 사용량"}
        </span>
        <span className="mtable-gap" />
        {notice ? <span className={"mtable-notice " + notice.tone} role="status">{notice.tone === "ok" ? "✓ " : "⚠ "}{notice.text}</span> : null}
        <div className="work-search">
          <span className="work-search-ic">🔍</span>
          <input value={query} placeholder="이름·이메일·프로젝트 검색" onChange={(event) => setQuery(event.target.value)} />
        </div>
      </div>
      <div className="mtable-filterbar" aria-label="표 필터">
        <span>필터</span>
        {sheet === "members" ? (
          <>
            <select aria-label="가입 상태 필터" value={filters.members.status} onChange={(event) => setFilters((current) => ({ ...current, members: { ...current.members, status: event.target.value } }))}>
              <option value="">가입 전체</option>
              {statuses.map((status) => <option key={status} value={status}>{status === "none" ? "계정 없음" : STATUS_LABEL[status] || status}</option>)}
            </select>
            <select aria-label="전역 역할 필터" value={filters.members.role} onChange={(event) => setFilters((current) => ({ ...current, members: { ...current.members, role: event.target.value } }))}>
              <option value="">전역 역할 전체</option>
              {roles.map((role) => <option key={role} value={role}>{short(GLOBAL_ROLE_LABEL[role], role)}</option>)}
            </select>
            <select aria-label="프로젝트 참여 필터" value={filters.members.project} onChange={(event) => setFilters((current) => ({ ...current, members: { ...current.members, project: event.target.value } }))}>
              <option value="">프로젝트 전체</option>
              {activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </>
        ) : sheet === "projects" ? (
          <select aria-label="프로젝트 상태 필터" value={filters.projects.status} onChange={(event) => setFilters((current) => ({ ...current, projects: { status: event.target.value } }))}>
            <option value="">상태 전체</option>
            {PROJECT_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        ) : (
          <>
          {mainView ? (
            <select aria-label="서브 필터" value={subFilter} onChange={(event) => setFilters((current) => sheet === "groups"
              ? { ...current, groups: { sub: event.target.value, group: "" } }
              : { ...current, credits: { ...current.credits, sub: event.target.value, group: "" } })}>
              <option value="">서브 전체</option>
              {liveSubs.map((sub) => <option key={sub.id} value={sub.id}>{subName(sub)}</option>)}
            </select>
          ) : null}
          <select
            aria-label="그룹 필터"
            value={mainView ? mainGroupFilter : sheet === "groups" ? filters.groups.group : filters.credits.group}
            onChange={(event) => setFilters((current) => sheet === "groups"
              ? { ...current, groups: { ...current.groups, group: event.target.value } }
              : { ...current, credits: { ...current.credits, group: event.target.value } })}
          >
            <option value="">그룹 전체</option>
            <option value={UNASSIGNED}>그룹 없음</option>
            {mainView
              ? shownSubs.flatMap((sub) => (sub.table?.groups ?? []).map((group) => <option key={group.id} value={group.id}>{subName(sub)} / {group.name}</option>))
              : data.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          </>
        )}
        {sheet === "credits" ? (
          <select aria-label="크레딧 사용 상태 필터" value={filters.credits.usage} onChange={(event) => setFilters((current) => ({ ...current, credits: { ...current.credits, usage: event.target.value } }))}>
            <option value="">사용 상태 전체</option>
            <option value="used">사용 있음</option>
            <option value="unused">사용 0</option>
            <option value="unknown">금액 미상 있음</option>
          </select>
        ) : null}
        {filtersActive ? <button type="button" onClick={clearSheetFilters}>필터 해제</button> : null}
        <span className="mtable-filter-count">{sheet === "projects" ? `${filteredProjects.length}개` : mainView ? `${mainPersons.length}명` : `${rows.length}명`}</span>
      </div>
      {sheet === "members" ? (
        <>
          {!data.workspace_id ? (
            <div className="mtable-note">워크스페이스를 고르면 프로젝트 참여가 함께 보입니다.</div>
          ) : null}
          <div className="mtable-scroll">
            <table>
          <thead>
            <tr className="mtable-groups">
              <th colSpan={2}>사람</th>
              <th colSpan={2} title="서버 보호(마지막 관리자)를 넣은 뒤 편집을 엽니다 — 지금은 보기만">계정 · 보기만</th>
              {activeProjects.length ? <th colSpan={activeProjects.length}>프로젝트 참여</th> : null}
            </tr>
            <tr>
              <th className="mtable-sticky">이름</th>
              <th>이메일</th>
              <th className="ro">가입</th>
              <th className="ro mtable-global-role-head">전역 역할</th>
              {activeProjects.map((project) => (
                <th key={project.id} className={(data.caps.project_roles ? "ed" : "ro") + " mtable-project-role-head"} title={lock(data.caps.project_roles, "PM(멤버 역할 부여 권한)만 바꿀 수 있습니다")}>
                  {project.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
                <tr key={row.email}>
                  <td className="mtable-sticky mtable-name">{row.name}</td>
                  <td>{row.email}</td>
                  <td className={"ro status-" + (row.status || "none")}>{row.status ? STATUS_LABEL[row.status] || row.status : "계정 없음"}</td>
                  <td className="ro mtable-global-role-cell">
                    <div className="mtable-role-grid mtable-role-grid-global">
                      {GLOBAL_ROLE_ORDER.map((role) => (
                        <span key={role} className="mtable-role-slot">
                          {row.global_roles.includes(role)
                            ? <span className={"mtable-chip role-" + role}>{short(GLOBAL_ROLE_LABEL[role], role)}</span>
                            : <span className="mtable-role-placeholder" aria-hidden="true" />}
                        </span>
                      ))}
                    </div>
                    {row.global_roles.filter((role) => !GLOBAL_ROLE_SET.has(role)).map((role) => (
                      <span key={role} className={"mtable-chip role-" + role}>{short(GLOBAL_ROLE_LABEL[role], role)}</span>
                    ))}
                  </td>
                  {!row.project_editable && activeProjects.length ? (
                    <td className="mtable-off" colSpan={activeProjects.length}>
                      {row.project_lock === "uid_conflict"
                        ? "계정과 워크스페이스 보고의 작성자 정보가 서로 달라 여기서는 바꿀 수 없습니다"
                        : "에이전트가 아직 연결되지 않아 프로젝트에 넣을 수 없습니다"}
                    </td>
                  ) : (
                    activeProjects.map((project) => {
                      const roles = row.projects[project.id] || [];
                      const joined = Object.prototype.hasOwnProperty.call(row.projects, project.id);
                      return (
                        <td key={project.id} className={(data.caps.project_roles ? "" : "ro") + " mtable-project-role-cell" + (joined ? "" : " mtable-not-joined")}>
                          {/* 역할을 안 고른 것과 헷갈리지 않게 — 들어가 있지 않으면 '참여 안 함', 올리면 역할 단추(누르면 참여) */}
                          {joined ? null : <span className="mtable-not-joined-label">참여 안 함</span>}
                          <div className="mtable-role-grid mtable-role-grid-project">
                            {PROJECT_ROLES.map((role) => {
                              const on = roles.includes(role);
                              return (
                                <span key={role} className="mtable-role-slot">
                                  {!data.caps.project_roles ? (
                                    on
                                      ? <span className={"mtable-chip role-" + role}>{short(PROJECT_ROLE_LABEL[role], role)}</span>
                                      : <span className="mtable-role-placeholder" aria-hidden="true" />
                                  ) : (
                                    <button
                                      type="button"
                                      className={"mtable-chip role-" + role + (on ? "" : " off")}
                                      aria-pressed={on}
                                      title={PROJECT_ROLE_LABEL[role] + (row.linked_accounts > 1 ? ` — 같은 사람의 계정 ${row.linked_accounts}개에 함께 적용됩니다` : "")}
                                      onClick={() => toggleRole(row, project, role)}
                                    >
                                      {short(PROJECT_ROLE_LABEL[role], role)}
                                    </button>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        </td>
                      );
                    })
                  )}
                </tr>
            ))}
            {!rows.length ? (
              <tr><td className="mtable-empty" colSpan={99}>{query ? "검색 결과가 없습니다." : "표시할 멤버가 없습니다."}</td></tr>
            ) : null}
            {memberAdd ? (
              <tr className="mtable-member-add-row" aria-label="프로젝트 멤버 추가">
                <td colSpan={2} className="mtable-member-add-cell">
                  <select aria-label="추가할 가입 계정" value={memberAdd.uid} disabled={memberAdd.loading || memberAdd.saving} onChange={(event) => pickMember(event.target.value)}>
                    <option value="">{memberAdd.loading ? "계정 불러오는 중…" : memberCandidates.length ? "계정 선택" : "추가할 계정 없음"}</option>
                    {memberCandidates.map((member) => <option key={member.uid} value={member.uid}>{member.name || member.email} · {member.email}</option>)}
                  </select>
                </td>
                <td colSpan={2} className="mtable-member-add-cell">
                  <select aria-label="추가할 프로젝트" value={memberAdd.projectId} disabled={memberAdd.saving} onChange={(event) => pickMemberProject(event.target.value)}>
                    {activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </td>
                <td colSpan={activeProjects.length} className="mtable-member-add-cell">
                  <div className="mtable-member-add-project">
                    <div className="mtable-member-role-list mtable-role-grid mtable-role-grid-project" aria-label="프로젝트 역할">
                      {PROJECT_ROLES.map((role) => {
                        const on = memberAdd.roles.includes(role);
                        return <span key={role} className="mtable-role-slot"><button type="button" className={"mtable-chip role-" + role + (on ? "" : " off")} aria-pressed={on} disabled={memberAdd.saving} onClick={() => setMemberAdd((current) => current ? { ...current, roles: on ? current.roles.filter((item) => item !== role) : [...current.roles, role] } : current)}>{short(PROJECT_ROLE_LABEL[role], role)}</button></span>;
                      })}
                    </div>
                    <div className="mtable-member-add-actions">
                      <button type="button" className="mtable-add mtable-member-add-action" disabled={!memberAdd.uid || !memberAdd.roles.length || memberAdd.loading || memberAdd.saving} onClick={saveMemberAdd}>{memberAdd.saving ? "추가 중…" : "추가"}</button>
                      <button type="button" className="mtable-cancel mtable-member-add-action" disabled={memberAdd.saving} onClick={() => setMemberAdd(null)}>취소</button>
                    </div>
                    {memberAdd.error ? <span className="mtable-inline-error" role="alert">{memberAdd.error}</span> : null}
                  </div>
                </td>
              </tr>
            ) : data.workspace_id && data.caps.project_roles && activeProjects.length ? (
              <tr className="mtable-new-row">
                <td colSpan={4 + activeProjects.length}><button type="button" onClick={() => void startMemberAdd()}>+ 멤버 추가</button></td>
              </tr>
            ) : null}
          </tbody>
            </table>
          </div>
        </>
      ) : sheet === "projects" ? (
        !data.workspace_id ? (
          <div className="mtable-note">워크스페이스를 먼저 골라 주세요.</div>
        ) : (
          <>
            {!planningDataReady && data.projects.length ? (
              <div className="mtable-note">서버가 일정·예산 원문을 보내지 않아 안전하게 잠갔습니다. 서버 업데이트 또는 재시작 뒤 편집할 수 있습니다.</div>
            ) : null}
            <div className="mtable-scroll">
              <table className="mtable-project-table" aria-label="프로젝트 일정 예산 관리">
                <thead>
                  <tr>
                    <th>프로젝트</th>
                    <th>상태</th>
                    <th>시작일</th>
                    <th>종료일</th>
                    {/* 서브스페이스 서브 워크스페이스를 고르면 서브스페이스 서브 표와 같은 칸 이름(다음 할당일 · 남은/할당 크레딧) */}
                    {consoleColumns ? <><th>다음 할당일</th><th className="num">남은 크레딧 / 할당 크레딧</th></> : <><th>주기</th><th className="num">예산</th></>}
                    <th className="num">작업 자동 보관(일)</th>
                    <th>메모</th>
                    <th title="이 PC 에 저장되는 설정입니다(다른 PC 는 각자 지정). 비우고 저장하면 연결을 해제합니다">렌더 폴더 (이 PC)</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProjects.map((project) => {
                    const draft = planningDraft(project);
                    const busy = planningBusy.has(project.id);
                    // 서브스페이스 서브 프로젝트 — 예산은 서브스페이스(크레딧 시트)에서 정한다(서버도 거절, 설계 §13). 저장은 기준값을 그대로 보낸다.
                    // 상태는 서브스페이스와 같은 경로로 바로 실행한다(§16 — 서브 전체에 적용).
                    const cl = project.console_limit ?? null;
                    const managed = Boolean(project.console_managed || cl); // 금액을 못 봐도 서브스페이스가 정하는 칸은 잠근다(§14)
                    const byConsole = managed ? "서브스페이스에서 정합니다" : undefined;
                    const folder = folders[project.id];
                    const movable = canReorder && !project.archived;
                    return (
                      <tr
                        key={project.id}
                        className={(project.archived ? "mtable-archived" : "") + (planningInvalid.has(project.id) ? " mtable-invalid" : "") + (dragProject && dragProject !== project.id && !project.archived ? " mtable-drop-ok" : "")}
                        onDragOver={(event) => { if (dragProject && dragProject !== project.id && !project.archived) event.preventDefault(); }}
                        onDrop={(event) => { event.preventDefault(); const from = dragProject; setDragProject(null); if (from && !project.archived) moveProject(from, project.id); }}
                      >
                        {/* 이름 칸이 손잡이 — 줄 전체를 끌게 하면 입력 칸의 글자 선택이 끌기로 바뀐다 */}
                        <td
                          className="mtable-name"
                          title={movable ? "끌어서 순서 변경" : undefined}
                          draggable={movable}
                          onDragStart={(event) => { if (!movable) return; event.dataTransfer?.setData("text/plain", project.id); setDragProject(project.id); }}
                          onDragEnd={() => setDragProject(null)}
                        >
                          {project.name}
                          {/* 서브스페이스 서브 표·프로젝트 관리 창과 같은 워크스페이스 배지 */}
                          <span className="admin-badge proj-workspace-badge">{project.workspace_name ?? "워크스페이스 미지정"}</span>
                          {project.archived ? <span className="mtable-chip mtable-archived-chip" title="보관된 프로젝트 — 상태를 활성으로 바꾸면 다시 나옵니다">보관</span> : null}
                        </td>
                        <td>{managed ? (
                          <select
                            className={`mtable-chip mtable-project-status mtable-status-${project.planning?.status || "active"}`}
                            aria-label={`${project.name} 상태`}
                            value={consoleStatusOf(project.planning?.status)}
                            disabled={!canPlan || !data.caps.credit || statusBusy}
                            title="서브스페이스와 같게 서브 전체에 바로 적용됩니다"
                            onChange={(event) => changeConsoleStatus(project, event.target.value as ConsoleStatus)}
                          >
                            {(Object.keys(CONSOLE_STATUS_LABEL) as ConsoleStatus[]).map((status) => <option key={status} value={status} className={`mtable-status-${PLAN_STATUS[status]}`}>{CONSOLE_STATUS_LABEL[status]}</option>)}
                          </select>
                        ) : (
                          <select className={`mtable-chip mtable-project-status mtable-status-${draft.form.status || "active"}`} aria-label={`${project.name} 상태`} value={draft.form.status || "active"} disabled={!canPlan || busy} onChange={(event) => commitPlanning(project, { status: event.target.value })}>{PROJECT_STATUS_OPTIONS.map((option) => <option className={`mtable-status-${option.value}`} key={option.value} value={option.value}>{option.label}</option>)}</select>
                        )}</td>
                        <td><input type="date" aria-label={`${project.name} 시작일`} value={draft.form.start_date || ""} disabled={!canPlan || busy} onChange={(event) => commitPlanning(project, { start_date: event.target.value || null })} /></td>
                        <td><input type="date" aria-label={`${project.name} 종료일`} value={draft.form.due_date || ""} disabled={!canPlan || busy} onChange={(event) => commitPlanning(project, { due_date: event.target.value || null })} /></td>
                        {managed ? <>
                          {/* 서브스페이스 서브 표와 같은 값(§16 후속): 다음 할당일 = 수동 칩 / Next 날짜 · 남은 크레딧(보고 잔액) / 할당 크레딧(정기) */}
                          <td title={byConsole}>{!cl ? "—" : !cl.auto ? <span className="wc-chip">수동</span>
                            : cl.credits && cl.next_topup_day ? <><span className="wc-next">Next</span>{cl.next_topup_day}</> : "—"}</td>
                          <td className="num" title={cl ? `남은 크레딧(힉스필드 보고 잔액) / 할당 크레딧(정기) — ${byConsole}` : byConsole}>{!cl ? "—" : <>
                            <b className={cl.balance != null && cl.balance < 0 ? "mtable-over" : ""}>{credits(cl.balance ?? null)}</b>
                            <span className="wc-alloc"> / {cl.credits ? credits(cl.credits) : "없음"}</span>
                          </>}</td>
                        </> : <>
                        <td><select aria-label={`${project.name} 예산 주기`} value={planningBudgetPeriod(draft.form)} disabled={!canPlan || busy} onChange={(event) => commitPlanning(project, { budget_period: event.target.value as Planning["budget_period"] })}>{BUDGET_PERIOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></td>
                        <td><div className="mtable-project-budget"><input className="num" type="text" inputMode="numeric" aria-label={`${project.name} 예산 크레딧`} placeholder="제한 없음" value={formatThousands(draft.budgetInput)} disabled={!canPlan || busy} onChange={(event) => editPlanning(project, {}, stripThousands(event.target.value))} onBlur={() => queuePlanningSave(project.id)} onKeyDown={blurOnEnter} /></div></td>
                        </>}
                        <td><input className="num" type="number" min={1} max={3650} aria-label={`${project.name} 작업 자동 보관 일수`} value={draft.form.archive_after_days ?? ""} disabled={!canPlan || busy} onChange={(event) => editPlanning(project, { archive_after_days: event.target.value ? Number(event.target.value) : null })} onBlur={() => queuePlanningSave(project.id)} onKeyDown={blurOnEnter} /></td>
                        <td><input type="text" aria-label={`${project.name} 메모`} value={draft.form.note || ""} disabled={!canPlan || busy} onChange={(event) => editPlanning(project, { note: event.target.value })} onBlur={() => queuePlanningSave(project.id)} onKeyDown={blurOnEnter} /></td>
                        <td className="mtable-folder-cell">
                          {project.archived ? <span className="mtable-muted">—</span> : (
                            <div className="mtable-folder">
                              <input
                                type="text"
                                aria-label={`${project.name} 렌더 폴더`}
                                value={folder?.root ?? ""}
                                placeholder={!folder || folder.state === "loading" ? "불러오는 중…" : "예: Z:\\Project\\render"}
                                disabled={!canPlan || !folder || folder.state === "loading" || folder.state === "saving"}
                                onChange={(event) => { const root = event.target.value; setFolders((current) => current[project.id] ? { ...current, [project.id]: { ...current[project.id], root, state: "ready" } } : current); }}
                                onKeyDown={blurOnEnter}
                                onBlur={() => void saveFolder(project.id)}
                              />
                              {folder?.state === "saving" ? <span className="mtable-muted">저장 중…</span> : folder?.state === "saved" ? <span className="mtable-muted">저장됨</span> : null}
                              {folder?.state === "error" ? <span className="mtable-inline-error" role="alert">{folder.error}</span> : null}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {!filteredProjects.length ? <tr><td className="mtable-empty" colSpan={9}>{query ? "검색 결과가 없습니다." : "표시할 프로젝트가 없습니다."}</td></tr> : null}
                </tbody>
              </table>
            </div>
            <div className="mtable-table-summary" aria-label="프로젝트 요약">
              <div><span>프로젝트</span><strong>{activeProjects.length}개{archivedCount ? ` · 보관 ${archivedCount}` : ""}</strong></div>
              <div><span>기간 설정</span><strong>{scheduledProjects}개</strong></div>
              {consoleCredit
                ? <div><span>정기 크레딧</span><strong>{consoleCredit.credits ? `${credits(consoleCredit.credits)} /${PERIOD_UNIT[consoleCredit.period]}` : "없음"}</strong></div>
                : <div><span>표시 프로젝트 월 예산</span><strong>{projectBudgetSet ? `${credits(listedMonthlyBudgetTotal)} 크레딧` : "미설정"}</strong></div>}
              <div><span>완료</span><strong>{data.projects.filter((project) => project.planning?.status === "done").length}개</strong></div>
            </div>
          </>
        )
      ) : sheet === "groups" ? (
        !data.workspace_id ? (
          <div className="mtable-note">워크스페이스를 먼저 골라 주세요.</div>
        ) : mainGroups ? (
          <>
            <div className="mtable-section-head"><b>그룹 현황</b><span>서브마다의 그룹 · 서브 값 그대로 · 고치기는 서브를 골라서</span></div>
            <div className="mtable-scroll">
              <table aria-label="크레딧 그룹 현황">
                <thead>
                  <tr>
                    <th>서브 / 그룹</th>
                    <th className="num">인원</th>
                    <th className="num mtable-period-col">기간</th>
                    <th className="num">그룹 크레딧</th>
                    <th className="num">이번 기간 사용</th>
                    <th className="num" title="할당 크레딧 합계 − 이번 기간 사용(이월 없음)">남음</th>
                  </tr>
                </thead>
                <tbody>
                  {shownSubs.flatMap((sub) => (sub.table?.groups ?? []).map((group) => (
                    <tr key={group.id}>
                      <td><span className="mtable-sub-group"><span className="admin-badge proj-workspace-badge">{subName(sub)}</span><span className="mtable-muted">/</span><GroupChip group={group} /></span></td>
                      <td className="num">{group.member_count}</td>
                      <td className="num mtable-period-col">{PERIOD_UNIT[group.limit_period ?? "month"]}</td>
                      <td className="num">{group.monthly_limit == null ? <span className="mtable-muted">제한 없음</span> : credits(group.monthly_limit)}</td>
                      <td className="num">{group.used_period == null ? "—" : credits(group.used_period)}</td>
                      <td className="num">{group.remaining === null ? (group.monthly_limit == null ? <span className="mtable-muted">제한 없음</span> : "—") : <span className={`credit-pct tone-${remainingTone(group.remaining, group.quota_total ?? null)}`}>{credits(group.remaining)}</span>}</td>
                    </tr>
                  )))}
                  {failedSubs.map((sub) => (
                    <tr key={`error:${sub.id}`}><td className="mtable-off" colSpan={6}>{subName(sub)} — 불러오지 못했습니다{sub.error ? ` (${sub.error})` : ""}</td></tr>
                  ))}
                  {!subTables ? <tr><td className="mtable-empty" colSpan={6}>서브 그룹을 불러오는 중…</td></tr>
                    : !shownSubs.some((sub) => sub.table?.groups.length) ? <tr><td className="mtable-empty" colSpan={6}>설정된 크레딧 그룹이 없습니다.</td></tr> : null}
                </tbody>
              </table>
            </div>
            <div className="mtable-table-summary" aria-label="그룹 요약">
              <div><span>서브</span><strong>{shownSubs.length}곳</strong></div>
              <div><span>그룹</span><strong>{shownSubs.reduce((sum, sub) => sum + (sub.table?.groups.length ?? 0), 0)}개</strong></div>
              <div><span>그룹에 든 사람</span><strong>{mainPersons.filter((person) => person.grouped).length}명</strong></div>
            </div>
            <div className="mtable-section-head"><b>참가자 배정</b><span>계정 한 줄 · 속한 서브마다 '서브 / 그룹'</span></div>
            <div className="mtable-scroll">
              <table aria-label="참가자 그룹 배정">
                <thead>
                  <tr>
                    <th className="mtable-sticky">이름</th>
                    <th>이메일</th>
                    <th className="ro">서브 / 그룹</th>
                    <th className="ro num">그룹 크레딧</th>
                  </tr>
                </thead>
                <tbody>
                  {mainPersons.map((person) => {
                    const grouped = person.entries.filter((entry) => entry.group);
                    const total = grouped.reduce((sum, entry) => sum + (entry.group!.monthly_limit ?? 0), 0);
                    return (
                      <tr key={person.email}>
                        <td className="mtable-sticky mtable-name">{person.name}</td>
                        <td>{person.email}</td>
                        <td className="ro">{subGroupChips(person)}</td>
                        <td className="ro num" title={perSub(person, (entry) => (!entry.group ? "그룹 없음" : entry.group.monthly_limit == null ? "제한 없음" : `${credits(entry.group.monthly_limit)} ${periodSuffix(entry.group.limit_period)}`))}>
                          {!grouped.length ? "—" : grouped.some((entry) => entry.group!.monthly_limit == null) ? <span className="mtable-muted">제한 없음</span> : credits(total)}
                        </td>
                      </tr>
                    );
                  })}
                  {!subTables ? <tr><td className="mtable-empty" colSpan={4}>서브 그룹을 불러오는 중…</td></tr>
                    : !mainPersons.length ? <tr><td className="mtable-empty" colSpan={4}>{query || filtersActive ? "검색 결과가 없습니다." : "표시할 참가자가 없습니다."}</td></tr> : null}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <>
            <div className="mtable-section-head">
              <b>그룹 현황</b><span>한도와 남은 크레딧</span>
            </div>
            {creditError && !groupEditor ? <div className="usage-error" role="alert">{creditError}</div> : null}
            <div className="mtable-scroll">
              <table aria-label="크레딧 그룹 현황">
                <thead>
                  <tr>
                    <th>그룹</th>
                    <th className="num">인원</th>
                    <th className="num mtable-period-col">기간</th>
                    <th className="num">그룹 크레딧</th>
                    <th className="num">이번 기간 사용</th>
                    <th className="num" title="할당 크레딧 합계 − 이번 기간 사용(이월 없음)">남음</th>
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((group) => (
                    <tr key={group.id}>
                      <td className="mtable-name mtable-group-main-cell">
                        <span className="mtable-group-main">
                          <GroupColorPicker
                            label={group.name}
                            color={groupColor(group.color)}
                            disabled={!canGroup || creditBusy || Boolean(groupEditor)}
                            onCommit={(color) => saveGroupColor(group.id, color)}
                            onEditingChange={(editing) => { if (editing) inlineDirtyRef.current.add(`color:${group.id}`); else inlineDirtyRef.current.delete(`color:${group.id}`); }}
                          />
                          {canGroup ? (
                            <button type="button" className="mtable-chip mtable-group-chip" style={groupColorStyle(group.color)} disabled={creditBusy} onClick={() => openGroupEditor(group.id)} title="그룹 편집">{group.name}</button>
                          ) : (
                            <GroupChip group={group} />
                          )}
                        </span>
                      </td>
                      <td className="num">{group.member_count.toLocaleString()}명</td>
                      <td className="mtable-period-col">
                        <select
                          className="mtable-group-period"
                          aria-label={`${group.name} 기간`}
                          value={group.limit_period ?? "month"}
                          disabled={!canGroup || creditBusy || Boolean(groupEditor)}
                          onChange={(event) => saveGroupTerms(group.id, group.monthly_limit, event.target.value as LimitPeriod)}
                        >
                          {BUDGET_PERIOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.shortLabel}</option>)}
                        </select>
                      </td>
                      <td className="num">
                        <GroupLimitInput
                          label={group.name}
                          value={group.monthly_limit}
                          disabled={!canGroup || creditBusy || Boolean(groupEditor)}
                          onCommit={(value, accepted) => saveGroupTerms(group.id, value, group.limit_period ?? "month", accepted)}
                          onDirtyChange={(dirty) => { if (dirty) inlineDirtyRef.current.add(group.id); else inlineDirtyRef.current.delete(group.id); }}
                        />
                      </td>
                      <td className="num">{credits(groupUsed(group))}</td>
                      <td className="num">{group.remaining === null ? (group.monthly_limit == null ? <span className="mtable-muted">제한 없음</span> : "—") : <span className={`credit-pct tone-${remainingTone(group.remaining, group.quota_total ?? null)}`}>{credits(group.remaining)}</span>}</td>
                    </tr>
                  ))}
                  {!data.groups.length ? (
                    <tr><td className="mtable-empty" colSpan={6}>설정된 크레딧 그룹이 없습니다.</td></tr>
                  ) : null}
                  {canGroup ? (
                    <tr className="mtable-new-row">
                      <td colSpan={6}><button type="button" disabled={creditBusy} onClick={() => openGroupEditor()}>+ 새 그룹</button></td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div className="mtable-table-summary" aria-label="그룹 요약">
              <div><span>그룹</span><strong>{data.groups.length}개</strong></div>
              <div><span>참가자</span><strong>{groupMemberTotal.toLocaleString()}명</strong></div>
              <div title="충전일 기준 이번 달 — 그룹마다 기간이 달라도 같은 달로 센다"><span>이번 달 사용(충전일 기준)</span><strong>{credits(groupUsedTotal)}</strong></div>
              <div title={groupRemainingTotal == null ? "그룹마다 기간(월·주·일)이 달라 합치지 않습니다 — 각 행을 보세요" : undefined}><span>남음 (∞ 그룹 제외)</span><strong>{groupRemainingTotal == null ? "기간 섞임" : credits(groupRemainingTotal)}</strong></div>
              <div title="그룹마다 그룹 크레딧 × 인원(사람별 할당 크레딧 반영)의 합"><span>그룹 할당 크레딧 합계{data.groups.some((group) => group.quota_total === null) ? " (∞ 그룹 제외)" : ""}</span><strong>{credits(quotaTotal)}</strong></div>
            </div>
            <div className="mtable-section-head"><b>참가자 배정</b><span>그룹 칸을 바꾸면 바로 적용됩니다</span></div>
            <div className="mtable-scroll">
              <table aria-label="참가자 그룹 배정">
                <thead>
                  <tr className="mtable-groups">
                    <th colSpan={2}>사람</th>
                    <th colSpan={2}>그룹</th>
                  </tr>
                  <tr>
                    <th className="mtable-sticky">이름</th>
                    <th>이메일</th>
                    <th className={canGroup ? "ed" : "ro"} title={lock(canGroup, "PM(프로젝트 생성 권한)만 바꿀 수 있습니다")}>배정</th>
                    <th className="ro num">그룹 크레딧</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const group = row.group_id ? groupById.get(row.group_id) : undefined;
                    return (
                      <tr
                        key={row.email}
                      >
                        <td className="mtable-sticky mtable-name">{row.name}</td>
                        <td>{row.email}</td>
                        <td className={canGroup ? "" : "ro"}>{groupCell(row)}</td>
                        <td className="ro num">
                          {/* 그룹의 인당 한도만 보인다 — 사람별 몫·남은 몫은 PM 권한인 '크레딧' 시트에만 있다. */}
                          {!group ? "—" : group.monthly_limit === null ? "∞" : `${credits(group.monthly_limit)} ${periodSuffix(group.limit_period)}`}
                        </td>
                      </tr>
                    );
                  })}
                  {!rows.length ? (
                    <tr><td className="mtable-empty" colSpan={4}>{query ? "검색 결과가 없습니다." : "표시할 참가자가 없습니다."}</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </>
        )
      ) : !data.workspace_id ? (
        <div className="mtable-note">워크스페이스를 먼저 골라 주세요.</div>
      ) : mainBlocked ? (
        <div className="mtable-note">크레딧 상세를 볼 권한이 없습니다.</div>
      ) : mainCredit ? (
        <>
          <div className="mtable-section-head"><b>개인별 사용량</b><span>계정 한 줄 · 속한 서브의 값을 더함(칸에 올리면 서브별 값) · 그룹 기간 기준, 그룹 없음은 이번 달(충전일 기준) · 고치기는 서브를 골라서</span></div>
          <div className="mtable-scroll">
            <table aria-label="서브별 개인 크레딧 사용량">
              <thead>
                <tr>
                  <th className="mtable-sticky">이름</th>
                  <th>이메일</th>
                  <th className="ro">서브 / 그룹</th>
                  <th className="ro">힉스필드</th>
                  <th className="ro num">할당 크레딧</th>
                  <th className="num">이번 기간 사용</th>
                  <th className="num">잔여 크레딧</th>
                  <th className="num">금액 미상</th>
                </tr>
              </thead>
              <tbody>
                {mainPersons.map((person) => (
                  <tr key={person.email}>
                    <td className="mtable-sticky mtable-name">{person.name}</td>
                    <td>{person.email}</td>
                    <td className="ro">{subGroupChips(person)}</td>
                    <td className="ro" title={perSub(person, (entry) => (entry.row.is_available ? "확인" : "확인 전"))}>
                      {person.available == null ? "—" : <span className={`wc-chip${person.available ? " ok" : " pend"}`}>{person.available ? "확인" : "확인 전"}</span>}
                    </td>
                    <td className="num" title={perSub(person, (entry) => (!entry.row.group_id ? "그룹 없음" : entry.unlimited ? "제한 없음" : entry.quota == null ? "—" : credits(entry.quota)))}>
                      {!person.grouped ? <span className="mtable-muted">그룹 없음</span> : person.unlimited ? <span className="mtable-muted">제한 없음</span> : person.quota == null ? "—" : credits(person.quota)}
                    </td>
                    <td className="num" title={perSub(person, (entry) => (entry.used ? credits(entry.used.credits) : "—"))}>{person.used ? credits(person.used.credits) : "—"}</td>
                    <td className={`num${!person.unlimited && (person.remaining ?? 0) < 0 ? " mtable-over" : ""}`} title={perSub(person, (entry) => (entry.unlimited ? "제한 없음" : entry.remaining == null ? "—" : credits(entry.remaining)))}>
                      {person.unlimited ? <span className="mtable-muted">제한 없음</span> : person.remaining == null ? "—" : credits(person.remaining)}
                    </td>
                    <td className="num">{person.used ? (person.used.unknown ? `${person.used.unknown.toLocaleString()}건` : "없음") : "—"}</td>
                  </tr>
                ))}
                {failedSubs.map((sub) => (
                  <tr key={`error:${sub.id}`}><td className="mtable-off" colSpan={8}>{subName(sub)} — 크레딧을 불러오지 못했습니다{sub.error ? ` (${sub.error})` : ""}</td></tr>
                ))}
                {!subTables ? <tr><td className="mtable-empty" colSpan={8}>서브 크레딧을 불러오는 중…</td></tr>
                  : !mainPersons.length ? <tr><td className="mtable-empty" colSpan={8}>{query || filtersActive ? "검색 결과가 없습니다." : "표시할 크레딧 사용량이 없습니다."}</td></tr> : null}
              </tbody>
            </table>
          </div>
          <div className="mtable-section-head"><b>크레딧 기록</b><span>메인 → 서브 · 정기 크레딧은 서브 설정값(이체 기록 아님) · 추가 크레딧은 전 기간 기록</span></div>
          <div className="mtable-scroll">
            <table className="mtable-topup-table" aria-label="크레딧 기록">
              <thead>
                <tr><th>날짜</th><th>구분</th><th>서브</th><th>충전일</th><th className="num">크레딧</th><th>메모</th></tr>
              </thead>
              <tbody>
                {shownSubs.map((sub) => {
                  const limit = sub.table?.console_limit;
                  return limit ? (
                    <tr key={`recurring:${sub.id}`} aria-label={`${subName(sub)} 정기 크레딧`}>
                      <td>{limit.auto && limit.next_topup_day ? <><span className="wc-next">Next</span>{limit.next_topup_day}</> : "—"}</td>
                      <td><span className="mtable-chip mtable-charge-kind regular">정기 크레딧</span></td>
                      <td><span className="admin-badge proj-workspace-badge">{subName(sub)}</span></td>
                      <td>{consoleSchedule(limit)}</td>
                      <td className="num">{limit.credits ? credits(limit.credits) : "없음"}</td>
                      <td className="mtable-muted">설정값(이체 기록 아님)</td>
                    </tr>
                  ) : null;
                })}
                {mainTopups.map(({ sub, item }) => (
                  <tr key={`${sub.id}:${item.id}`}>
                    <td>{item.day}</td>
                    <td><span className="mtable-chip mtable-charge-kind emergency">추가 크레딧</span></td>
                    <td><span className="admin-badge proj-workspace-badge">{subName(sub)}</span></td>
                    <td>—</td>
                    <td className="num mtable-credit-plus">+{credits(item.credits)}</td>
                    <td>{item.note || "—"}</td>
                  </tr>
                ))}
                {subTables && !shownSubs.some((sub) => sub.table?.console_limit) && !mainTopups.length ? (
                  <tr><td className="mtable-empty" colSpan={6}>표시할 크레딧 기록이 없습니다.</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="mtable-table-summary mtable-credit-summary" aria-label="메인 크레딧 요약">
            <div title={data.main_balance?.seen_at ? `${data.main_balance.seen_at.slice(5, 16)} 보고값` : "보고 없음"}>
              <span>크레딧 풀(메인 잔액) · {data.main_balance?.seen_at?.slice(5, 16) ?? "보고 없음"}</span>
              <strong>{data.main_balance?.credits == null ? "—" : credits(data.main_balance.credits)}</strong>
            </div>
            <div><span>서브 정기 크레딧 합계</span><strong>{mainRecurring.size ? [...mainRecurring].map(([period, value]) => `${credits(value)} /${PERIOD_UNIT[period]}`).join(" · ") : "없음"}</strong></div>
            <div><span>추가 크레딧 합계(전 기간)</span><strong>{mainTopups.length ? `+${credits(mainTopups.reduce((sum, { item }) => sum + item.credits, 0))}` : "없음"}</strong></div>
            <div><span>서브</span><strong>{shownSubs.length}곳</strong></div>
          </div>
        </>
      ) : (
        <>
          {!data.credit ? (
            <div className="mtable-note">크레딧 상세를 볼 권한이 없습니다.</div>
          ) : null}
          <div className="mtable-section-head">
            <b>개인별 사용량</b><span>그룹 기간 기준 · 그룹 없음은 이번 달(충전일 기준)</span>
            {canGroup ? <button type="button" className="mtable-add" disabled={creditBusy || Boolean(groupEditor)} onClick={() => setAddOpen(true)}>＋ 참가시키기</button> : null}
          </div>
          <div className="mtable-scroll">
            <table aria-label="개인별 크레딧 사용량">
              <thead>
                <tr>
                  <th className="mtable-sticky">이름</th>
                  <th>이메일</th>
                  <th className={canGroup ? "ed" : "ro"} title={lock(canGroup, "PM(프로젝트 생성 권한)만 바꿀 수 있습니다")}>그룹</th>
                  <th className="ro" title="'확인 전' = 그룹에는 넣었지만 그 사람의 앱이 아직 이 워크스페이스를 보고하지 않음">힉스필드</th>
                  <th className={canGroup && quotaSupported ? "ed num" : "ro num"} title={quotaLock || lock(canGroup, "PM(프로젝트 생성 권한)만 바꿀 수 있습니다")}>할당 크레딧</th>
                  <th className="num">이번 기간 사용</th>
                  <th className="num">잔여 크레딧</th>
                  <th className="num">금액 미상</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.email}>
                    <td className="mtable-sticky mtable-name">{row.name}</td>
                    <td>{row.email}</td>
                    <td className={canGroup ? "" : "ro"}>{groupCell(row)}</td>
                    <td className="ro">{row.is_available == null ? "—" : <span className={`wc-chip${row.is_available ? " ok" : " pend"}`}>{row.is_available ? "확인" : "확인 전"}</span>}</td>
                    <td className="num mtable-quota-cell">
                      {!row.group_id ? <span className="mtable-muted">그룹 없음</span> : (
                        <GroupLimitInput
                          label={row.name}
                          field="할당 크레딧"
                          decimals
                          placeholder={quotaOf(row.email)?.quota_effective != null ? `그룹 ${autoShareLabel(quotaOf(row.email)!.quota_effective)}` : unlimitedOf(row) ? "제한 없음" : "그룹"}
                          value={quotaOf(row.email)?.quota ?? null}
                          disabled={!canGroup || !quotaSupported || creditBusy || Boolean(groupEditor)}
                          onCommit={(value, accepted) => saveMemberQuota(row.email, value, accepted)}
                          onDirtyChange={(dirty) => { if (dirty) inlineDirtyRef.current.add(row.email); else inlineDirtyRef.current.delete(row.email); }}
                        />
                      )}
                    </td>
                    <td className="num">{usageOf(row) ? credits(usageOf(row)!.credits) : "—"}</td>
                    <td className={`num${(quotaOf(row.email)?.remaining ?? 0) < 0 ? " mtable-over" : ""}`}>
                      {quotaOf(row.email)?.remaining == null ? (unlimitedOf(row) ? <span className="mtable-muted">제한 없음</span> : "—") : credits(quotaOf(row.email)!.remaining!)}
                    </td>
                    <td className="num">{usageOf(row) ? (usageOf(row)!.unknown ? `${usageOf(row)!.unknown.toLocaleString()}건` : "없음") : "—"}</td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr><td className="mtable-empty" colSpan={8}>{query ? "검색 결과가 없습니다." : "표시할 크레딧 사용량이 없습니다."}</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="mtable-section-head"><b>크레딧 기록</b><span>{consoleCredit ? "정기 크레딧(서브스페이스) · 전 기간 추가 크레딧" : "정기 크레딧 · 전 기간 추가 크레딧"}</span></div>
          {creditError && !groupEditor ? <div className="usage-error" role="alert">{creditError}</div> : null}
          <div className="mtable-scroll">
            <table className="mtable-topup-table" aria-label="크레딧 기록">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>구분</th>
                  <th>충전일</th>
                  <th className="num">크레딧</th>
                  <th>메모</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {data.credit ? (
                  // 정기 크레딧 — 서브스페이스 크레딧 창과 같은 칸(방식·주기·충전일·금액)을 칸마다 바로 저장한다(§16). 모든 워크스페이스.
                  <tr aria-label="정기 크레딧">
                    <td>{recurring.auto && recurring.next ? <><span className="wc-next">Next</span>{recurring.next}</> : "—"}</td>
                    <td><span className="mtable-chip mtable-charge-kind regular">정기 크레딧</span></td>
                    <td>
                      <div className="mtable-recurring">
                        <select aria-label="정기 크레딧 방식" value={recurring.auto ? "auto" : "manual"} disabled={recurring.lock}
                          onChange={(event) => saveRecurring({ auto: event.target.value === "auto" }, event.target.value === "auto" ? "자동" : "수동")}>
                          <option value="auto">자동</option>
                          <option value="manual">수동</option>
                        </select>
                        {recurring.auto ? (
                          <select aria-label="정기 크레딧 주기" value={recurring.period} disabled={recurring.lock}
                            onChange={(event) => saveRecurring({ period: event.target.value as LimitPeriod }, `주기 ${PERIOD_UNIT[event.target.value as LimitPeriod]}`)}>
                            {(["month", "week", "day"] as LimitPeriod[]).map((period) => <option key={period} value={period}>{PERIOD_UNIT[period]}</option>)}
                          </select>
                        ) : null}
                        {recurring.monthly ? (
                          <select
                            className="mtable-topup-day"
                            aria-label="충전일"
                            value={recurring.day === todayDay ? "today" : recurring.day}
                            disabled={recurring.lock}
                            onChange={(event) => { const day = event.target.value === "today" ? todayDay : Number(event.target.value); if (day !== recurring.day) saveRecurring({ day }, `충전일 매월 ${day}일`); }}
                          >
                            <option value="today">오늘</option>
                            {TOPUP_DAY_OPTIONS.map((day) => <option key={day} value={day}>매월 {day}일</option>)}
                          </select>
                        ) : (
                          <input type="date" aria-label="충전일" title={recurring.period === "week" ? "매주 이 요일" : "이날부터 매일"} value={data.credit.plan.recurring_anchor ?? ""} disabled={recurring.lock}
                            onChange={(event) => { if (event.target.value) saveRecurring({ date: event.target.value }, `충전일 ${event.target.value}`); }} />
                        )}
                      </div>
                    </td>
                    <td className="num mtable-quota-cell">
                      <GroupLimitInput
                        label="정기 크레딧"
                        field="금액"
                        decimals
                        placeholder={consoleCredit ? "없음" : derivedTopup === null ? "예산 합계" : `예산 합계 ${credits(derivedTopup)}`}
                        value={data.credit.plan.recurring_topup ?? null}
                        disabled={recurring.lock || !quotaSupported}
                        onCommit={(value, accepted) => saveRecurring({ value }, value === null ? "비움" : credits(value), accepted)}
                        onDirtyChange={(dirty) => { if (dirty) inlineDirtyRef.current.add("recurring"); else inlineDirtyRef.current.delete("recurring"); }}
                      />
                    </td>
                    <td>
                      {consoleCredit
                        ? `서브스페이스와 같은 설정 · ${recurring.label} · 비우면 없음`
                        : manualTopup
                          ? "손으로 적은 값 — 비우면 프로젝트 월 예산 합계로 돌아갑니다"
                          : "프로젝트 월 예산 합계와 자동 동기화"}
                    </td>
                    <td>—</td>
                  </tr>
                ) : null}
                {topups.map((item) => topup?.id === item.id ? topupEditorRow(topup, "추가 크레딧 수정") : (
                  <tr key={item.id}>
                    <td>{item.day}</td>
                    <td><span className="mtable-chip mtable-charge-kind emergency">추가 크레딧</span></td>
                    <td>—</td>
                    <td className="num mtable-credit-plus">+{credits(item.credits)}</td>
                    <td>{item.note || "—"}</td>
                    <td>
                      <div className="mtable-topup-actions">
                        <button type="button" className="mtable-cancel" aria-label={`${item.day} 추가 크레딧 수정`} disabled={creditBusy || Boolean(topup)} onClick={() => editTopup(item)}>수정</button>
                        <button type="button" className="mtable-cancel mtable-delete" aria-label={`${item.day} 추가 크레딧 삭제`} disabled={creditBusy || Boolean(topup)} onClick={() => deleteTopup(item)}>삭제</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!data.credit ? (
                  <tr><td className="mtable-empty" colSpan={6}>표시할 크레딧 기록이 없습니다.</td></tr>
                ) : null}
                {topup && !topups.some((item) => item.id === topup.id) ? topupEditorRow(topup, "새 추가 크레딧") : !topup && canGroup ? (
                  <tr className="mtable-new-row">
                    <td colSpan={6}><button type="button" onClick={startTopup}>+ 추가 크레딧</button></td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {data.credit ? (
            <div className="mtable-table-summary mtable-credit-summary" aria-label="충전 요약">
              <div><span>이번 주기</span><strong>{cycleRange}</strong></div>
              <div title={manualTopup ? "손으로 적은 정기 크레딧입니다" : data.credit?.plan.monthly_topup_source === "none" ? "서브스페이스에서 정기 크레딧을 정하지 않았습니다" : "월 주기로 설정된 프로젝트 예산의 합계입니다"}>
                <span>{consoleCredit ? `정기 크레딧 · ${consoleSchedule(consoleCredit)}` : `정기 크레딧${manualTopup ? " (손 입력)" : ""}`}</span>
                <strong>{consoleCredit ? (consoleCredit.credits ? credits(consoleCredit.credits) : "없음")
                  : recurringTopup === null ? "없음" : credits(recurringTopup)}</strong>
              </div>
              {consoleCredit
                ? <div><span>추가 크레딧(이번 주기)</span><strong>{consoleCredit.topups_cycle ? `+${credits(consoleCredit.topups_cycle)}` : "없음"}</strong></div>
                : <div><span>추가 크레딧 합계</span><strong>{topups.length ? `+${credits(topupTotal)}` : "없음"}</strong></div>}
              {/* 서브스페이스 서브 요약(§16) — 서브스페이스 서브 화면 머리 카드와 같은 값(서버 console_limit 상세) */}
              {consoleCredit?.topups_count !== undefined ? <div><span>추가 크레딧 건수</span><strong>{consoleCredit.topups_count}건</strong></div> : null}
              {consoleCredit && consoleCredit.balance !== undefined ? (
                <div title={consoleCredit.balance_seen_at ? `${consoleCredit.balance_seen_at.slice(5, 16)} 보고값` : "보고 없음"}>
                  <span>잔액(보고) · {consoleCredit.balance_seen_at?.slice(5, 16) ?? "보고 없음"}</span><strong>{credits(consoleCredit.balance)}</strong>
                </div>
              ) : null}
              {consoleCredit?.used_cycle !== undefined ? (
                <div><span>이번 주기 사용{consoleCredit.unknown_cycle ? ` · 미상 ${consoleCredit.unknown_cycle}건` : ""}</span><strong>{credits(consoleCredit.used_cycle)}</strong></div>
              ) : null}
              {consoleCredit && consoleCredit.next_topup_day !== undefined ? (
                <div><span>Next</span><strong>{consoleCredit.auto && consoleCredit.next_topup_day ? consoleCredit.next_topup_day : "—"}</strong></div>
              ) : null}
            </div>
          ) : null}
        </>
      )}
      <div className="mtable-sheets" role="tablist" aria-label="관리 표 보기">
          <button type="button" role="tab" aria-selected={sheet === "members"} className={sheet === "members" ? "on" : ""} onClick={() => { setCreditError(""); setSheet("members"); }}>멤버 {data.rows.length}</button>
        <button type="button" role="tab" aria-selected={sheet === "projects"} className={sheet === "projects" ? "on" : ""} onClick={() => { setCreditError(""); setSheet("projects"); }}>프로젝트 {activeProjects.length}</button>
        <button type="button" role="tab" aria-selected={sheet === "groups"} className={sheet === "groups" ? "on" : ""} onClick={() => { setCreditError(""); setSheet("groups"); }}>그룹 {data.groups.length}</button>
        <button type="button" role="tab" aria-selected={sheet === "credits"} className={sheet === "credits" ? "on" : ""} onClick={() => { setCreditError(""); setSheet("credits"); }}>크레딧 관리</button>
      </div>
      {groupEditor ? (
        <GroupEditor
          draft={groupEditor.draft}
          group={groupEditor.group}
          busy={creditBusy}
          externalError={creditError}
          onClose={() => { if (!creditBusy) { setGroupEditor(null); setCreditError(""); } }}
          onApply={saveGroupEdit}
        />
      ) : null}
      {addOpen && data.credit ? (
        <AddMemberDialog groups={data.credit.groups} onClose={() => setAddOpen(false)} onSave={addParticipant} />
      ) : null}
    </div>
  );
}
