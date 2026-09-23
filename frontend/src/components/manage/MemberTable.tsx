// PM 대시보드 '관리 표' — 엑셀 시트처럼 멤버·그룹·크레딧을 나눠 보고, 편집 가능한 칸은 바로 저장한다.
// 설계: docs/MEMBER_TABLE_DESIGN.md. 표에는 자기만의 쓰기 API 가 없다 — 칸마다 기존 API 를 부른다(권한·감사·재기준화 그대로).
// 저장은 직렬 큐 하나로 줄 세우고, 큐가 비면 성공·실패와 관계없이 표를 다시 읽는다(다른 창·다른 사람의 변경은 큐 밖이다).
// 실패해도 칸을 하나씩 되돌리지 않는다 — 서버 값으로 통째로 다시 읽으므로 늦게 온 실패가 최신 값을 덮는 일이 없다.
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api } from "../../api";
import {
  draftFromSettings,
  formatThousands,
  GROUP_COLOR_PALETTE,
  groupColor,
  newDraftGroup,
  newGroupId,
  stripThousands,
  TOPUP_DAY_OPTIONS,
  todayLocal,
  topupsOnlyBody,
  validateTopup,
  type CreditPlanDraft,
  type CreditPlanSettings,
  type CreditTopup,
  type DraftGroup,
  type DraftTopup,
  type LimitPeriod,
} from "../../lib/creditPlan";
import { isHttpStatus, isRouteMissing } from "../../lib/http";
import { manageApi } from "../../lib/manageApi";
import {
  applyProjectRoles,
  groupAssignBody,
  groupColorBody,
  memberQuotaBody,
  groupEditBody,
  groupTermsBody,
  matchesMemberQuery,
  type MemberTableData,
  type MemberTableGroup,
  type MemberTableRow,
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

const STATUS_LABEL: Record<string, string> = { approved: "승인", pending: "대기", rejected: "거절" };
const short = (label: string | undefined, fallback: string) => (label ? label.split(" · ")[0] : fallback);
const credits = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });
type TableSheet = "members" | "projects" | "groups" | "credits";
const UNASSIGNED = "__unassigned__";
const GLOBAL_ROLE_ORDER = ["admin", "production_director", "product_manager", "member"] as const;
const GLOBAL_ROLE_SET = new Set<string>(GLOBAL_ROLE_ORDER);
const GROUP_COLOR_NAMES = ["라임", "초록", "청록", "시안", "파랑", "인디고", "보라", "핑크", "빨강", "주황", "노랑", "회색"];

interface TableFilters {
  members: { status: string; role: string; project: string };
  projects: { status: string };
  groups: { group: string };
  credits: { group: string; usage: string };
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
  form: Planning;
  budgetInput: string;
  touched: Partial<Record<Exclude<keyof Planning, "project_id"> | "budgetInput", true>>;
}

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

function GroupColorPicker({ label, color, disabled, onCommit }: {
  label: string;
  color: string;
  disabled: boolean;
  onCommit: (color: string) => boolean;
}) {
  const [open, setOpen] = useState(false);
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

  const choose = (nextColor: string) => {
    const accepted = onCommit(nextColor);
    if (accepted) setOpen(false);
    return accepted;
  };
  const toggle = () => {
    if (disabled) return;
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
            <GroupColorInput label={`${label} 커스텀 색상`} color={color} disabled={disabled} onCommit={choose} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GroupLimitInput({ label, value, disabled, onCommit, field = "한도", placeholder = "제한 없음" }: {
  label: string;
  value: number | null;
  disabled: boolean;
  onCommit: (value: number | null) => boolean;
  field?: string;       // 읽어 주는 칸 이름 — 그룹 '한도' / 사람 '몫'
  placeholder?: string; // 비었을 때의 뜻 — 그룹은 '제한 없음', 사람은 '자동'
}) {
  const serverValue = value === null ? "" : String(value);
  const [input, setInput] = useState(serverValue);
  const skipCommitRef = useRef(false);
  useEffect(() => setInput(serverValue), [serverValue]);
  const commit = () => {
    if (skipCommitRef.current) return;
    const next = input ? Number(input) : null;
    if (next === value) return;
    if (!onCommit(next)) setInput(serverValue);
  };
  return (
    <div className="mtable-group-limit">
      <input
        type="text"
        inputMode="numeric"
        aria-label={`${label} ${field}`}
        placeholder={placeholder}
        maxLength={11}
        value={formatThousands(input)}
        disabled={disabled}
        onChange={(event) => setInput(stripThousands(event.target.value))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            skipCommitRef.current = true;
            setInput(serverValue);
            event.currentTarget.blur();
            skipCommitRef.current = false;
          }
        }}
      />
      <span>cr</span>
    </div>
  );
}

const emptyFilters = (): TableFilters => ({
  members: { status: "", role: "", project: "" },
  projects: { status: "" },
  groups: { group: "" },
  credits: { group: "", usage: "" },
});

export function MemberTable({ workspaceId = "", reloadSignal = 0 }: { workspaceId?: string; reloadSignal?: number }) {
  const [data, setData] = useState<MemberTableData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<TableSheet>("members");
  const [filters, setFilters] = useState<TableFilters>(emptyFilters);
  const [memberAdd, setMemberAdd] = useState<MemberAddState | null>(null);
  const [planningEdits, setPlanningEdits] = useState<Record<string, PlanningDraft>>({});
  const [planningBusy, setPlanningBusy] = useState<Set<string>>(new Set());
  const [groupEditor, setGroupEditor] = useState<{
    source: CreditPlanSettings;
    draft: CreditPlanDraft;
    group: DraftGroup;
  } | null>(null);
  const [topup, setTopup] = useState<DraftTopup | null>(null);
  const [creditBusy, setCreditBusy] = useState(false);
  const [creditError, setCreditError] = useState("");
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
      creditRef.current = next.credit;
      setData(next);
      setError("");
    } catch (reason) {
      if (stale()) return;
      setData(null);
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
    setCreditError("");
  }, [workspaceId]);

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
  const save = (operation: () => Promise<void>) => {
    epochRef.current += 1;
    void queue.enqueue(async () => {
      try {
        await operation();
      } finally {
        epochRef.current += 1;
      }
    });
  };
  // 표가 지금 고른 워크스페이스의 것일 때만 고친다 — 전환 직후 이전 표로 새 워크스페이스에 저장하는 일을 막는다(코덱스 P0).
  const inScope = (data?.workspace_id ?? "") === workspaceId;
  // planning 은 이 화면보다 늦게 추가됐다. 권한만 구형 응답과 호환하고, 원문이 없으면 기본값으로 덮지 않게 잠근다.
  const planningDataReady = Boolean(data && data.projects.every((project) => Object.prototype.hasOwnProperty.call(project, "planning")));
  const canPlan = Boolean(data && planningDataReady && (data.caps.planning ?? (data.caps.credit || data.caps.project_roles)));

  const setGroup = (row: MemberTableRow, groupId: string | null) => {
    if (!data || !inScope || !workspaceId || groupId === row.group_id) return;
    const groupName = data.groups.find((group) => group.id === groupId)?.name ?? "그룹 없음";
    setData({ ...data, rows: data.rows.map((item) => (item.email === row.email ? { ...item, group_id: groupId } : item)) });
    save(async () => {
      const credit = creditRef.current;
      if (!credit) throw new Error("그룹 설정을 읽지 못했습니다");
      creditRef.current = await manageApi.saveCreditPlan(workspaceId, groupAssignBody(credit, row.email, groupId));
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
        creditRef.current = await manageApi.saveCreditPlan(workspaceId, groupEditBody(source, edited, memberEmails));
        setGroupEditor(null);
        setNotice({ tone: "ok", text: `저장됨 · 그룹 (${edited.name.trim()})` });
      } catch (reason) {
        setCreditError(isHttpStatus(reason, 409)
          ? "다른 곳에서 먼저 바꿨습니다. 창을 닫았다 다시 열어 최신 값에서 수정해 주세요."
          : `그룹을 저장하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
        throw reason;
      } finally {
        setCreditBusy(false);
      }
    });
  };

  const saveGroupColor = (groupId: string, color: string) => {
    if (!data || !inScope || !workspaceId || creditBusy || groupEditor) return false;
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
    save(async () => {
      try {
        const credit = creditRef.current;
        if (!credit) throw new Error("크레딧 설정을 읽지 못했습니다");
        creditRef.current = await manageApi.saveCreditPlan(workspaceId, groupColorBody(credit, groupId, nextColor));
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

  /** 사람별 몫 한 칸 저장 — 비우면(null) 그룹 한도를 인원으로 나눈 자동 몫으로 돌아간다.
   *  소속은 건드리지 않는다(본문에 group_id 키를 싣지 않는다). */
  const saveMemberQuota = (email: string, quota: number | null) => {
    if (!data || !inScope || !workspaceId || creditBusy || groupEditor) return false;
    if (quota !== null && (!Number.isFinite(quota) || quota < 0)) return false;
    setCreditBusy(true);
    setCreditError("");
    save(async () => {
      try {
        const credit = creditRef.current;
        if (!credit) throw new Error("크레딧 설정을 읽지 못했습니다");
        creditRef.current = await manageApi.saveCreditPlan(workspaceId, memberQuotaBody(credit, email, quota));
        setNotice({ tone: "ok", text: quota === null ? "저장됨 · 몫을 자동으로" : "저장됨 · 개인 몫" });
      } catch (reason) {
        setCreditError(isHttpStatus(reason, 409)
          ? "다른 곳에서 먼저 바꿨습니다. 최신 값을 읽었으니 다시 저장해 주세요."
          : `개인 몫을 저장하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
        throw reason;
      } finally {
        setCreditBusy(false);
      }
    });
    return true;
  };

  const saveGroupTerms = (groupId: string, monthlyLimit: number | null, limitPeriod: LimitPeriod) => {
    if (!data || !inScope || !workspaceId || creditBusy || groupEditor) return false;
    const current = data.groups.find((group) => group.id === groupId);
    if (!current || monthlyLimit !== null && (!Number.isInteger(monthlyLimit) || monthlyLimit < 0)) return false;
    if (current.monthly_limit === monthlyLimit && (current.limit_period ?? "month") === limitPeriod) return true;
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
    save(async () => {
      try {
        const credit = creditRef.current;
        if (!credit) throw new Error("크레딧 설정을 읽지 못했습니다");
        creditRef.current = await manageApi.saveCreditPlan(workspaceId, groupTermsBody(credit, groupId, monthlyLimit, limitPeriod));
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
    setTopup({ id: newGroupId(), day: todayLocal(), creditsInput: "", note: "" });
  };

  const editTopup = (item: CreditTopup) => {
    if (!inScope || !workspaceId || creditBusy || topup) return;
    setCreditError("");
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
    setCreditBusy(true);
    setCreditError("");
    save(async () => {
      try {
        const credit = creditRef.current;
        if (!credit) throw new Error("크레딧 설정을 읽지 못했습니다");
        const draft = draftFromSettings(credit);
        const editing = draft.topups.some((item) => item.id === pending.id);
        const nextTopups = editing
          ? draft.topups.map((item) => item.id === pending.id ? pending : item)
          : [pending, ...draft.topups];
        creditRef.current = await manageApi.saveCreditPlan(
          workspaceId,
          topupsOnlyBody(draft, nextTopups),
        );
        setTopup(null);
        setNotice({ tone: "ok", text: editing ? "저장됨 · 긴급 충전 수정" : `저장됨 · 크레딧 +${formatThousands(pending.creditsInput)}` });
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
    if (!window.confirm(`${item.day} 긴급 충전 ${credits(item.credits)} cr을 삭제할까요?`)) return;
    setCreditBusy(true);
    setCreditError("");
    save(async () => {
      try {
        const credit = creditRef.current;
        if (!credit) throw new Error("크레딧 설정을 읽지 못했습니다");
        const draft = draftFromSettings(credit);
        const nextTopups = draft.topups.filter((topupItem) => topupItem.id !== item.id);
        if (nextTopups.length === draft.topups.length) throw new Error("삭제할 긴급 충전 기록을 찾지 못했습니다");
        creditRef.current = await manageApi.saveCreditPlan(workspaceId, topupsOnlyBody(draft, nextTopups));
        setNotice({ tone: "ok", text: "저장됨 · 긴급 충전 삭제" });
      } catch (reason) {
        setCreditError(isHttpStatus(reason, 409)
          ? "다른 곳에서 먼저 바꿨습니다. 최신 값을 읽었으니 다시 삭제해 주세요."
          : `긴급 충전을 삭제하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
        throw reason;
      } finally {
        setCreditBusy(false);
      }
    });
  };

  const saveTopupDay = (topupDay: number) => {
    if (!data?.credit || !creditRef.current || !inScope || !workspaceId || creditBusy || groupEditor) return;
    const previous = data.credit.plan.topup_day ?? 1;
    if (topupDay === previous) return;
    const monthEndNote = topupDay > 28 ? " (없는 날짜는 그 달 마지막 날)" : "";
    if (!window.confirm(`충전 기준일을 매월 ${topupDay}일${monthEndNote}로 바꿀까요?\n월 한도 그룹의 현재 잔액도 새 기준일에 맞춰 다시 계산됩니다.`)) return;
    setData({ ...data, credit: { ...data.credit, plan: { ...data.credit.plan, topup_day: topupDay } } });
    setCreditBusy(true);
    setCreditError("");
    save(async () => {
      try {
        const credit = creditRef.current;
        if (!credit) throw new Error("크레딧 설정을 읽지 못했습니다");
        creditRef.current = await manageApi.saveCreditPlan(workspaceId, {
          revision: credit.plan.revision,
          note: credit.plan.note,
          topup_day: topupDay,
        });
        setNotice({ tone: "ok", text: `저장됨 · 충전 기준일 (매월 ${topupDay}일)` });
      } catch (reason) {
        setCreditError(isHttpStatus(reason, 409)
          ? "다른 곳에서 먼저 바꿨습니다. 최신 값을 읽었으니 다시 저장해 주세요."
          : `충전 기준일을 저장하지 못했습니다. ${String(reason).replace(/^Error:\s*/, "")}`);
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
    if (!data || !inScope || !workspaceId || !data.caps.project_roles || !data.projects.length) return;
    const projectId = data.projects[0].id;
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

  const planningDraft = (project: MemberTableData["projects"][number]): PlanningDraft => {
    const saved = planningEdits[project.id];
    const form: Planning = {
      status: project.planning?.status || "active",
      start_date: project.planning?.start_date || null,
      due_date: project.planning?.due_date || null,
      budget_credits: project.planning?.budget_credits ?? null,
      budget_period: planningBudgetPeriod(project.planning),
      archive_after_days: project.planning?.archive_after_days ?? 30,
      note: project.planning?.note || null,
    };
    if (!saved) return { form, budgetInput: planningBudgetInput(form), touched: {} };
    const touchedForm = Object.fromEntries(
      (Object.keys(saved.touched) as (Exclude<keyof Planning, "project_id"> | "budgetInput")[])
        .filter((key) => key !== "budgetInput")
        .map((key) => [key, saved.form[key]]),
    ) as Partial<Planning>;
    return {
      form: { ...form, ...touchedForm },
      budgetInput: saved.touched.budgetInput ? saved.budgetInput : planningBudgetInput(form),
      touched: saved.touched,
    };
  };

  const editPlanning = (project: MemberTableData["projects"][number], patch: Partial<Planning>, budgetInput?: string) => {
    const current = planningDraft(project);
    const touched = { ...current.touched };
    for (const key of Object.keys(patch) as Exclude<keyof Planning, "project_id">[]) touched[key] = true;
    if (budgetInput !== undefined) touched.budgetInput = true;
    setPlanningEdits((edits) => ({
      ...edits,
      [project.id]: { form: { ...current.form, ...patch }, budgetInput: budgetInput ?? current.budgetInput, touched },
    }));
  };

  const savePlanning = (project: MemberTableData["projects"][number]) => {
    if (!data || !inScope || !canPlan || planningBusy.has(project.id)) return;
    const draft = planningDraft(project);
    const result = validateProjectPlanning(draft.form, draft.budgetInput);
    if (!result.planning) {
      setNotice({ tone: "bad", text: result.error });
      return;
    }
    const planningBody = result.planning;
    setPlanningBusy((busy) => new Set(busy).add(project.id));
    save(async () => {
      try {
        const planning = await manageApi.setPlanning(project.id, planningBody);
        setData((current) => current ? { ...current, projects: current.projects.map((item) => item.id === project.id ? { ...item, planning } : item) } : current);
        setPlanningEdits((edits) => { const next = { ...edits }; delete next[project.id]; return next; });
        setNotice({ tone: "ok", text: `저장됨 · 프로젝트 설정 (${project.name})` });
      } finally {
        setPlanningBusy((busy) => { const next = new Set(busy); next.delete(project.id); return next; });
      }
    });
  };

  if (error) return <div className="usage-error">{error}</div>;
  if (!data) return <div className="usage-loading">관리 표를 불러오는 중…</div>;

  const groupById = new Map(data.groups.map((group) => [group.id, group]));
  // 사람별 몫·남은 몫은 크레딧 설정 원문에 있다(이메일 기준). 구서버 응답엔 없으므로 undefined 를 그대로 다룬다.
  const creditMembers = new Map((data.credit?.members || []).map((member) => [member.email, member]));
  const quotaOf = (email: string) => creditMembers.get(email);
  const rows = data.rows.filter((row) => {
    if (sheet === "projects") return true;
    if (!matchesMemberQuery(row, query)) return false;
    if (sheet === "members") {
      const filter = filters.members;
      if (filter.status && (row.status ?? "none") !== filter.status) return false;
      if (filter.role && !row.global_roles.includes(filter.role)) return false;
      if (filter.project && !(row.projects[filter.project]?.length)) return false;
    } else {
      const groupFilter = sheet === "groups" ? filters.groups.group : filters.credits.group;
      if (groupFilter === UNASSIGNED && row.group_id) return false;
      if (groupFilter && groupFilter !== UNASSIGNED && row.group_id !== groupFilter) return false;
      if (sheet === "credits") {
        const usage = filters.credits.usage;
        if (usage === "used" && !(row.usage && row.usage.credits > 0)) return false;
        if (usage === "unused" && !(row.usage && row.usage.credits === 0)) return false;
        if (usage === "unknown" && !(row.usage && row.usage.unknown > 0)) return false;
      }
    }
    return true;
  });
  const filteredProjects = data.projects.filter((project) => {
    if (query.trim() && !project.name.toLowerCase().includes(query.trim().toLowerCase())) return false;
    return !filters.projects.status || (project.planning?.status || "active") === filters.projects.status;
  });
  const memberCandidates = memberAdd ? availableMembers(memberAdd.options, memberAdd.projectId) : [];
  const canGroup = data.caps.credit && Boolean(data.credit);
  const lock = (can: boolean, why: string) => (can ? undefined : why);
  const topups = data.credit?.topups ?? [];
  const topupTotal = topups.reduce((sum, topup) => sum + topup.credits, 0);
  const todayDay = Number(todayLocal().slice(8, 10));
  const recurringTopup = data.credit?.plan.monthly_topup ?? null;
  const cycleRange = data.cycle_start && data.cycle_end ? `${data.cycle_start} ~ ${data.cycle_end}` : "—";
  const topupEditorRow = (draft: DraftTopup, label: string) => (
    <tr key={`editor-${draft.id}`} className="mtable-topup-row" aria-label={label}>
      <td><input type="date" aria-label="충전 날짜" value={draft.day} onChange={(event) => setTopup({ ...draft, day: event.target.value })} /></td>
      <td><span className="mtable-chip mtable-charge-kind emergency">긴급 충전</span></td>
      <td>—</td>
      <td>
        <input
          type="text"
          inputMode="numeric"
          aria-label="충전 크레딧"
          value={formatThousands(draft.creditsInput)}
          placeholder="크레딧"
          onChange={(event) => setTopup({ ...draft, creditsInput: stripThousands(event.target.value) })}
        />
      </td>
      <td><input aria-label="충전 메모" value={draft.note} placeholder="메모 (선택)" onChange={(event) => setTopup({ ...draft, note: event.target.value })} /></td>
      <td>
        <div className="mtable-topup-actions">
          <button type="button" className="mtable-add" disabled={creditBusy} onClick={saveTopup}>{creditBusy ? "저장 중…" : "저장"}</button>
          <button type="button" className="mtable-cancel" disabled={creditBusy} onClick={() => { setTopup(null); setCreditError(""); }}>취소</button>
        </div>
      </td>
    </tr>
  );
  const groupMemberTotal = data.groups.reduce((sum, group) => sum + group.member_count, 0);
  const groupUsedTotal = data.rows.reduce((sum, row) => sum + (row.usage?.credits ?? 0), 0);
  const groupRemainingTotal = data.groups.reduce((sum, group) => sum + (group.remaining ?? 0), 0);
  const listedMonthlyBudgets = data.projects.filter((project) => planningBudgetPeriod(project.planning) === "month");
  const listedMonthlyBudgetTotal = listedMonthlyBudgets.reduce((sum, project) => sum + (project.planning?.budget_credits ?? 0), 0);
  const projectBudgetSet = listedMonthlyBudgets.some((project) => project.planning?.budget_credits != null);
  const scheduledProjects = data.projects.filter((project) => project.planning?.start_date || project.planning?.due_date).length;
  const statuses = [...new Set(data.rows.map((row) => row.status ?? "none"))];
  const roleSet = new Set(data.rows.flatMap((row) => row.global_roles));
  const roles = [...GLOBAL_ROLE_ORDER.filter((role) => roleSet.has(role)), ...[...roleSet].filter((role) => !GLOBAL_ROLE_SET.has(role))];
  const filtersActive = sheet === "members"
    ? Object.values(filters.members).some(Boolean)
    : sheet === "projects"
      ? Boolean(filters.projects.status)
    : sheet === "groups"
      ? Boolean(filters.groups.group)
      : Object.values(filters.credits).some(Boolean);

  const clearSheetFilters = () => setFilters((current) => {
    if (sheet === "members") return { ...current, members: { status: "", role: "", project: "" } };
    if (sheet === "projects") return { ...current, projects: { status: "" } };
    if (sheet === "groups") return { ...current, groups: { group: "" } };
    return { ...current, credits: { group: "", usage: "" } };
  });

  return (
    <div className="mtable">
      <div className="mtable-bar">
        <b>{sheet === "members" ? "멤버 관리" : sheet === "projects" ? "프로젝트 관리" : sheet === "groups" ? "그룹 관리" : "크레딧 관리"}</b>
        <span className="mtable-hint">
          {sheet === "members" ? "사람·계정·프로젝트 참여" : sheet === "projects" ? "일정·예산·보관 설정" : sheet === "groups" ? "그룹별 한도와 멤버 배정" : "정기·긴급 충전과 개인별 사용량"}
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
              {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </>
        ) : sheet === "projects" ? (
          <select aria-label="프로젝트 상태 필터" value={filters.projects.status} onChange={(event) => setFilters((current) => ({ ...current, projects: { status: event.target.value } }))}>
            <option value="">상태 전체</option>
            {PROJECT_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        ) : (
          <select
            aria-label="그룹 필터"
            value={sheet === "groups" ? filters.groups.group : filters.credits.group}
            onChange={(event) => setFilters((current) => sheet === "groups"
              ? { ...current, groups: { group: event.target.value } }
              : { ...current, credits: { ...current.credits, group: event.target.value } })}
          >
            <option value="">그룹 전체</option>
            <option value={UNASSIGNED}>미배정</option>
            {data.groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
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
        <span className="mtable-filter-count">{sheet === "projects" ? `${filteredProjects.length}개` : `${rows.length}명`}</span>
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
              {data.projects.length ? <th colSpan={data.projects.length}>프로젝트 참여</th> : null}
            </tr>
            <tr>
              <th className="mtable-sticky">이름</th>
              <th>이메일</th>
              <th className="ro">가입</th>
              <th className="ro mtable-global-role-head">전역 역할</th>
              {data.projects.map((project) => (
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
                  {!row.project_editable && data.projects.length ? (
                    <td className="mtable-off" colSpan={data.projects.length}>
                      {row.project_lock === "uid_conflict"
                        ? "계정과 워크스페이스 보고의 작성자 정보가 서로 달라 여기서는 바꿀 수 없습니다"
                        : "에이전트가 아직 연결되지 않아 프로젝트에 넣을 수 없습니다"}
                    </td>
                  ) : (
                    data.projects.map((project) => {
                      const roles = row.projects[project.id] || [];
                      return (
                        <td key={project.id} className={(data.caps.project_roles ? "" : "ro") + " mtable-project-role-cell"}>
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
                    {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                  </select>
                </td>
                <td colSpan={data.projects.length} className="mtable-member-add-cell">
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
            ) : data.workspace_id && data.caps.project_roles && data.projects.length ? (
              <tr className="mtable-new-row">
                <td colSpan={4 + data.projects.length}><button type="button" onClick={() => void startMemberAdd()}>+ 멤버 추가</button></td>
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
                    <th>마감일</th>
                    <th>주기</th>
                    <th className="num">예산</th>
                    <th className="num">보관 전환</th>
                    <th>메모</th>
                    <th className={canPlan ? "ed" : "ro"}>적용</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredProjects.map((project) => {
                    const draft = planningDraft(project);
                    const busy = planningBusy.has(project.id);
                    return (
                      <tr key={project.id}>
                        <td className="mtable-name">{project.name}</td>
                        <td><select className={`mtable-chip mtable-project-status mtable-status-${draft.form.status || "active"}`} aria-label={`${project.name} 상태`} value={draft.form.status || "active"} disabled={!canPlan || busy} onChange={(event) => editPlanning(project, { status: event.target.value })}>{PROJECT_STATUS_OPTIONS.map((option) => <option className={`mtable-status-${option.value}`} key={option.value} value={option.value}>{option.label}</option>)}</select></td>
                        <td><input type="date" aria-label={`${project.name} 시작일`} value={draft.form.start_date || ""} disabled={!canPlan || busy} onChange={(event) => editPlanning(project, { start_date: event.target.value || null })} /></td>
                        <td><input type="date" aria-label={`${project.name} 마감일`} value={draft.form.due_date || ""} disabled={!canPlan || busy} onChange={(event) => editPlanning(project, { due_date: event.target.value || null })} /></td>
                        <td><select aria-label={`${project.name} 예산 주기`} value={planningBudgetPeriod(draft.form)} disabled={!canPlan || busy} onChange={(event) => editPlanning(project, { budget_period: event.target.value as Planning["budget_period"] })}>{BUDGET_PERIOD_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></td>
                        <td><div className="mtable-project-budget"><input className="num" type="text" inputMode="numeric" aria-label={`${project.name} 예산 크레딧`} placeholder="제한 없음" value={formatThousands(draft.budgetInput)} disabled={!canPlan || busy} onChange={(event) => editPlanning(project, {}, stripThousands(event.target.value))} /><span>cr</span></div></td>
                        <td><input className="num" type="number" min={1} max={3650} aria-label={`${project.name} 보관 전환 일수`} value={draft.form.archive_after_days ?? ""} disabled={!canPlan || busy} onChange={(event) => editPlanning(project, { archive_after_days: event.target.value ? Number(event.target.value) : null })} /></td>
                        <td><input type="text" aria-label={`${project.name} 메모`} value={draft.form.note || ""} disabled={!canPlan || busy} onChange={(event) => editPlanning(project, { note: event.target.value })} /></td>
                        <td><button type="button" className="mtable-add" disabled={!canPlan || busy || !planningEdits[project.id]} onClick={() => savePlanning(project)}>{busy ? "저장 중…" : "적용"}</button></td>
                      </tr>
                    );
                  })}
                  {!filteredProjects.length ? <tr><td className="mtable-empty" colSpan={9}>{query ? "검색 결과가 없습니다." : "표시할 프로젝트가 없습니다."}</td></tr> : null}
                </tbody>
              </table>
            </div>
            <div className="mtable-table-summary" aria-label="프로젝트 요약">
              <div><span>프로젝트</span><strong>{data.projects.length}개</strong></div>
              <div><span>일정 설정</span><strong>{scheduledProjects}개</strong></div>
              <div><span>표시 프로젝트 월 예산</span><strong>{projectBudgetSet ? `${credits(listedMonthlyBudgetTotal)} cr` : "미설정"}</strong></div>
              <div><span>완료</span><strong>{data.projects.filter((project) => project.planning?.status === "done").length}개</strong></div>
            </div>
          </>
        )
      ) : sheet === "groups" ? (
        !data.workspace_id ? (
          <div className="mtable-note">워크스페이스를 먼저 골라 주세요.</div>
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
                    <th className="num">멤버</th>
                    <th>한도 주기</th>
                    <th className="num">한도</th>
                    <th className="num">남은 양</th>
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
                          />
                          {canGroup ? (
                            <button type="button" className="mtable-chip mtable-group-chip" style={groupColorStyle(group.color)} disabled={creditBusy} onClick={() => openGroupEditor(group.id)} title="그룹 편집">{group.name}</button>
                          ) : (
                            <GroupChip group={group} />
                          )}
                        </span>
                      </td>
                      <td className="num">{group.member_count.toLocaleString()}명</td>
                      <td>
                        <select
                          className="mtable-group-period"
                          aria-label={`${group.name} 한도 주기`}
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
                          onCommit={(value) => saveGroupTerms(group.id, value, group.limit_period ?? "month")}
                        />
                      </td>
                      <td className="num">{group.remaining === null ? "제한 없음" : `${credits(group.remaining)} cr`}</td>
                    </tr>
                  ))}
                  {!data.groups.length ? (
                    <tr><td className="mtable-empty" colSpan={5}>설정된 크레딧 그룹이 없습니다.</td></tr>
                  ) : null}
                  {canGroup ? (
                    <tr className="mtable-new-row">
                      <td colSpan={5}><button type="button" disabled={creditBusy} onClick={() => openGroupEditor()}>+ 새 그룹</button></td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
            <div className="mtable-table-summary" aria-label="그룹 요약">
              <div><span>그룹</span><strong>{data.groups.length}개</strong></div>
              <div><span>배정</span><strong>{groupMemberTotal.toLocaleString()}명</strong></div>
              <div><span>전체 사용</span><strong>{credits(groupUsedTotal)} cr</strong></div>
              <div><span>제한 그룹 남은 양</span><strong>{credits(groupRemainingTotal)} cr</strong></div>
            </div>
            <div className="mtable-section-head"><b>멤버 배정</b><span>그룹 칸을 바꾸면 바로 적용됩니다</span></div>
            <div className="mtable-scroll">
              <table aria-label="멤버 그룹 배정">
                <thead>
                  <tr className="mtable-groups">
                    <th colSpan={2}>사람</th>
                    <th colSpan={2}>그룹</th>
                  </tr>
                  <tr>
                    <th className="mtable-sticky">이름</th>
                    <th>이메일</th>
                    <th className={canGroup ? "ed" : "ro"} title={lock(canGroup, "PM(프로젝트 생성 권한)만 바꿀 수 있습니다")}>배정</th>
                    <th className="ro num">남은 양 / 한도</th>
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
                        <td className={canGroup ? "" : "ro"}>
                          {canGroup ? (
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
                          )}
                        </td>
                        <td className="ro num">
                          {!group ? "—" : group.monthly_limit === null ? "제한 없음" : `${credits(group.remaining ?? 0)} / ${credits(group.monthly_limit)}`}
                        </td>
                      </tr>
                    );
                  })}
                  {!rows.length ? (
                    <tr><td className="mtable-empty" colSpan={4}>{query ? "검색 결과가 없습니다." : "표시할 멤버가 없습니다."}</td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </>
        )
      ) : !data.workspace_id ? (
        <div className="mtable-note">워크스페이스를 먼저 골라 주세요.</div>
      ) : (
        <>
          {!data.credit ? (
            <div className="mtable-note">크레딧 상세를 볼 권한이 없습니다.</div>
          ) : null}
          <div className="mtable-section-head"><b>개인별 사용량</b><span>현재 충전 달 기준</span></div>
          <div className="mtable-scroll">
            <table aria-label="개인별 크레딧 사용량">
              <thead>
                <tr>
                  <th className="mtable-sticky">이름</th>
                  <th>이메일</th>
                  <th>그룹</th>
                  <th className={canGroup ? "ed num" : "ro num"} title={lock(canGroup, "PM(프로젝트 생성 권한)만 바꿀 수 있습니다")}>몫</th>
                  <th className="num">사용 크레딧</th>
                  <th className="num">남은 몫</th>
                  <th className="num">금액 미상</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.email}>
                    <td className="mtable-sticky mtable-name">{row.name}</td>
                    <td>{row.email}</td>
                    <td><GroupChip group={row.group_id ? groupById.get(row.group_id) : undefined} /></td>
                    <td className="num">
                      {!row.group_id ? <span className="mtable-muted">그룹 없음</span> : (
                        <GroupLimitInput
                          label={row.name}
                          field="몫"
                          placeholder={quotaOf(row.email)?.quota_effective != null ? `자동 ${credits(quotaOf(row.email)!.quota_effective!)}` : "자동"}
                          value={quotaOf(row.email)?.quota ?? null}
                          disabled={!canGroup || creditBusy || Boolean(groupEditor)}
                          onCommit={(value) => saveMemberQuota(row.email, value)}
                        />
                      )}
                    </td>
                    <td className="num">{row.usage ? `${credits(row.usage.credits)} cr` : "—"}</td>
                    <td className={`num${(quotaOf(row.email)?.remaining ?? 0) < 0 ? " mtable-over" : ""}`}>
                      {quotaOf(row.email)?.remaining == null ? "—" : `${credits(quotaOf(row.email)!.remaining!)} cr`}
                    </td>
                    <td className="num">{row.usage ? (row.usage.unknown ? `${row.usage.unknown.toLocaleString()}건` : "없음") : "—"}</td>
                  </tr>
                ))}
                {!rows.length ? (
                  <tr><td className="mtable-empty" colSpan={7}>{query ? "검색 결과가 없습니다." : "표시할 크레딧 사용량이 없습니다."}</td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          <div className="mtable-section-head"><b>충전 기록</b><span>정기 충전 · 전 기간 긴급 충전</span></div>
          {creditError && !groupEditor ? <div className="usage-error" role="alert">{creditError}</div> : null}
          <div className="mtable-scroll">
            <table className="mtable-topup-table" aria-label="충전 기록">
              <thead>
                <tr>
                  <th>충전일</th>
                  <th>구분</th>
                  <th>충전 기준일</th>
                  <th className="num">크레딧</th>
                  <th>메모</th>
                  <th>관리</th>
                </tr>
              </thead>
              <tbody>
                {data.credit ? (
                  <tr>
                    <td>{data.cycle_start ?? "—"}</td>
                    <td><span className="mtable-chip mtable-charge-kind regular">정기 충전</span></td>
                    <td>
                      <select
                        className="mtable-topup-day"
                        aria-label="충전 기준일"
                        value={(data.credit.plan.topup_day ?? 1) === todayDay ? "today" : data.credit.plan.topup_day ?? 1}
                        disabled={!canGroup || creditBusy || Boolean(groupEditor)}
                        onChange={(event) => saveTopupDay(event.target.value === "today" ? todayDay : Number(event.target.value))}
                      >
                        <option value="today">오늘</option>
                        {TOPUP_DAY_OPTIONS.map((day) => <option key={day} value={day}>매월 {day}일</option>)}
                      </select>
                    </td>
                    <td className="num mtable-credit-plus">{recurringTopup === null ? "미설정" : `+${credits(recurringTopup)} cr`}</td>
                    <td>프로젝트 월 예산 합계와 자동 동기화</td>
                    <td>—</td>
                  </tr>
                ) : null}
                {topups.map((item) => topup?.id === item.id ? topupEditorRow(topup, "긴급 충전 수정") : (
                  <tr key={item.id}>
                    <td>{item.day}</td>
                    <td><span className="mtable-chip mtable-charge-kind emergency">긴급 충전</span></td>
                    <td>—</td>
                    <td className="num mtable-credit-plus">+{credits(item.credits)} cr</td>
                    <td>{item.note || "—"}</td>
                    <td>
                      <div className="mtable-topup-actions">
                        <button type="button" className="mtable-cancel" aria-label={`${item.day} 긴급 충전 수정`} disabled={creditBusy || Boolean(topup)} onClick={() => editTopup(item)}>수정</button>
                        <button type="button" className="mtable-cancel mtable-delete" aria-label={`${item.day} 긴급 충전 삭제`} disabled={creditBusy || Boolean(topup)} onClick={() => deleteTopup(item)}>삭제</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!data.credit ? (
                  <tr><td className="mtable-empty" colSpan={6}>표시할 충전 기록이 없습니다.</td></tr>
                ) : null}
                {topup && !topups.some((item) => item.id === topup.id) ? topupEditorRow(topup, "크레딧 추가") : !topup && canGroup ? (
                  <tr className="mtable-new-row">
                    <td colSpan={6}><button type="button" onClick={startTopup}>+ 새 충전 기록</button></td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {data.credit ? (
            <div className="mtable-table-summary mtable-credit-summary" aria-label="충전 요약">
              <div><span>충전 기간</span><strong>{cycleRange}</strong></div>
              <div title="월 주기로 설정된 프로젝트 예산의 합계입니다"><span>정기 충전액</span><strong>{recurringTopup === null ? "미설정" : `${credits(recurringTopup)} cr`}</strong></div>
              <div><span>긴급 충전 합계</span><strong>{topups.length ? `+${credits(topupTotal)} cr` : "없음"}</strong></div>
            </div>
          ) : null}
        </>
      )}
      <div className="mtable-sheets" role="tablist" aria-label="관리 표 보기">
        <button type="button" role="tab" aria-selected={sheet === "members"} className={sheet === "members" ? "on" : ""} onClick={() => { setCreditError(""); setSheet("members"); }}>멤버 {data.rows.length}</button>
        <button type="button" role="tab" aria-selected={sheet === "projects"} className={sheet === "projects" ? "on" : ""} onClick={() => { setCreditError(""); setSheet("projects"); }}>프로젝트 {data.projects.length}</button>
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
    </div>
  );
}
