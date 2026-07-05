// 통합 대시보드 데이터 모델 — list_tasks(작업 배열)를 프로젝트▸에피소드▸시퀀스 계층 트리로.
// 순수 함수(테스트·재사용). 진척도는 작업상태(status) 가중 롤업(계획 §6-3).
import type { Task } from "./types";

// 상태 가중치 — 진척% 롤업용(계획 확정). omit 은 분모 제외.
const STATUS_WEIGHT: Record<string, number> = {
  not_started: 0,
  pending: 0.15,
  in_progress: 0.5,
  publish: 0.8,
  done: 1,
};
// 진척 스택바용 그룹(완료/게시/진행/시작전)
export type StatusDist = { done: number; publish: number; prog: number; idle: number };

export interface DashNode {
  key: string; // 고유 키(트리 펼침 상태용)
  kind: "project" | "episode" | "sequence";
  projectId: string;
  label: string;
  folderPath?: string; // 시퀀스 노드의 folder_path(참여자 조회용)
  episode?: string;
  // 롤업 지표
  taskCount: number;
  credits: number;
  elapsed: number;
  elapsedKnown: number; // elapsed>0 인 작업 수(커버리지)
  progress: number; // 0~1 가중 진척
  dist: StatusDist; // 상태 분포(스택바)
  assigneeLabel: string; // 담당(대표 외 N)
  dueDate: string | null; // 임박 마감(미완료 중 min)
  children?: DashNode[];
  tasks: Task[]; // 이 노드에 속한 원본 작업(참여자·상세용)
}

export interface DashTotals {
  credits: number;
  elapsed: number;
  elapsedKnown: number;
  taskCount: number;
  progress: number;
  dist: StatusDist;
}

function emptyDist(): StatusDist {
  return { done: 0, publish: 0, prog: 0, idle: 0 };
}

function addToDist(d: StatusDist, status?: string | null): void {
  if (status === "done") d.done += 1;
  else if (status === "publish") d.publish += 1;
  else if (status === "in_progress" || status === "pending") d.prog += 1;
  else if (status === "not_started") d.idle += 1;
  // omit 은 어디에도 안 셈(분모 제외)
}

// 작업들의 롤업 지표 계산(진척·크레딧·시간·상태분포 + 담당·임박 마감).
function rollup(tasks: Task[]): {
  credits: number;
  elapsed: number;
  elapsedKnown: number;
  progress: number;
  dist: StatusDist;
  assigneeLabel: string;
  dueDate: string | null;
} {
  let credits = 0, elapsed = 0, elapsedKnown = 0;
  let wSum = 0, wCount = 0;
  const dist = emptyDist();
  const asgn = new Map<string, string>(); // 담당 uid→name(중복 제거, 복수 배정)
  let dueDate: string | null = null; // 미완료 작업 중 가장 임박한 마감(min)
  for (const t of tasks) {
    credits += t.credits || 0;
    if (t.elapsed && t.elapsed > 0) {
      elapsed += t.elapsed;
      elapsedKnown += 1;
    }
    const st = t.status || "not_started";
    if (st !== "omit") {
      wSum += STATUS_WEIGHT[st] ?? 0;
      wCount += 1;
    }
    addToDist(dist, st);
    for (const a of t.assigned_creators || []) asgn.set(a.uid, a.name || a.uid);
    if (st !== "done" && st !== "omit") {
      const d = t.due_date || t.derived_due;
      if (d && (!dueDate || d < dueDate)) dueDate = d;
    }
  }
  const names = [...asgn.values()];
  const assigneeLabel = names.length === 0 ? "—" : names.length === 1 ? names[0] : `${names[0]} 외 ${names.length - 1}`;
  return { credits, elapsed, elapsedKnown, progress: wCount ? wSum / wCount : 0, dist, assigneeLabel, dueDate };
}

// list_tasks 결과(전 프로젝트 병합)를 프로젝트▸에피소드▸시퀀스 트리로.
export function buildHierarchy(tasks: Task[]): { tree: DashNode[]; totals: DashTotals } {
  // 프로젝트 그룹
  const byProject = new Map<string, Task[]>();
  for (const t of tasks) {
    const pid = t.project_id || "(none)";
    (byProject.get(pid) || byProject.set(pid, []).get(pid)!).push(t);
  }
  const tree: DashNode[] = [];
  for (const [pid, ptasks] of byProject) {
    const projName = ptasks[0]?.project_name || pid;
    // 에피소드 그룹 — folder_path segs[0], 없으면 작업명
    const byEp = new Map<string, Task[]>();
    for (const t of ptasks) {
      const segs = (t.folder_path || "").split("/").filter(Boolean);
      const ep = segs[0] || t.name || "(미지정)";
      (byEp.get(ep) || byEp.set(ep, []).get(ep)!).push(t);
    }
    const epNodes: DashNode[] = [];
    for (const [ep, etasks] of byEp) {
      // 시퀀스 그룹 — segs[1], 없으면 sequence 컬럼, 없으면 작업 단위
      const bySeq = new Map<string, Task[]>();
      for (const t of etasks) {
        const segs = (t.folder_path || "").split("/").filter(Boolean);
        const seq = segs[1] || t.sequence || t.name || "(단일)";
        (bySeq.get(seq) || bySeq.set(seq, []).get(seq)!).push(t);
      }
      const seqNodes: DashNode[] = [];
      for (const [seq, stasks] of bySeq) {
        const r = rollup(stasks);
        seqNodes.push({
          key: `${pid}/${ep}/${seq}`,
          kind: "sequence",
          projectId: pid,
          label: seq,
          folderPath: stasks[0]?.folder_path || undefined,
          episode: ep,
          taskCount: stasks.length,
          ...r,
          tasks: stasks,
        });
      }
      const er = rollup(etasks);
      epNodes.push({
        key: `${pid}/${ep}`,
        kind: "episode",
        projectId: pid,
        label: ep,
        episode: ep,
        taskCount: etasks.length,
        ...er,
        children: seqNodes,
        tasks: etasks,
      });
    }
    const pr = rollup(ptasks);
    tree.push({
      key: pid,
      kind: "project",
      projectId: pid,
      label: projName,
      taskCount: ptasks.length,
      ...pr,
      children: epNodes,
      tasks: ptasks,
    });
  }
  // 전체 합계
  const tr = rollup(tasks);
  return {
    tree,
    totals: { credits: tr.credits, elapsed: tr.elapsed, elapsedKnown: tr.elapsedKnown, taskCount: tasks.length, progress: tr.progress, dist: tr.dist },
  };
}

// 키로 트리 노드 찾기(선택 → 참여자 패널 연동).
export function findNode(tree: DashNode[], key: string | null): DashNode | null {
  if (!key) return null;
  for (const n of tree) {
    if (n.key === key) return n;
    if (n.children) {
      const f = findNode(n.children, key);
      if (f) return f;
    }
  }
  return null;
}

// 신원 2축 참여자 — 배정(담당)·생성(cut creator)을 사람별로 합침.
export interface Participant {
  uid: string;
  name: string;
  assign: boolean; // 담당(배정) — 대시보드에서 지정
  create: boolean; // 실제 생성
  roles?: string[]; // 프로젝트 역할(PM/감독/제작) — 프로젝트 노드에서만 채움
}
// 역할 우선순위(PM>감독>제작>없음) — 참여자 정렬용.
function roleRank(roles?: string[]): number {
  if (!roles?.length) return 0;
  if (roles.includes("project_manager")) return 3;
  if (roles.includes("supervisor")) return 2;
  return 1;
}

// 참여자 세부 통계 — 담당(배정) 작업 수·생성 컷 수·크레딧까지. 프로젝트 멤버(역할)도 합친다.
export interface ParticipantStat extends Participant {
  assignCount: number; // 담당(배정)한 작업(시퀀스) 수
  cutCount: number; // 실제 생성한 컷 수
  credits: number; // 생성 컷 크레딧 합
}
export function participantStats(
  node: DashNode,
  members: { uid: string; name: string | null; roles: string[] }[] = [],
): ParticipantStat[] {
  const map = new Map<string, ParticipantStat>();
  const ensure = (uid: string, name?: string | null): ParticipantStat => {
    let p = map.get(uid);
    if (!p) {
      p = { uid, name: name || uid, assign: false, create: false, assignCount: 0, cutCount: 0, credits: 0 };
      map.set(uid, p);
    } else if (name && p.name === p.uid) p.name = name;
    return p;
  };
  // 같은 컷(gen)이 여러 작업에 연결될 수 있어(폴더 자동+수동 링크) 컷은 1회만 센다(이중계산 방지).
  const seenCut = new Set<string>();
  for (const t of node.tasks) {
    for (const a of t.assigned_creators || []) {
      const p = ensure(a.uid, a.name);
      p.assign = true;
      p.assignCount += 1;
    }
    for (const c of t.cuts || []) {
      if (!c.creator_uid || seenCut.has(c.id)) continue;
      seenCut.add(c.id);
      const p = ensure(c.creator_uid, c.creator_name);
      p.create = true;
      p.cutCount += 1;
      p.credits += c.credits || 0;
    }
  }
  for (const m of members) {
    const ex = map.get(m.uid);
    if (ex) {
      ex.roles = m.roles;
      if ((!ex.name || ex.name === ex.uid) && m.name) ex.name = m.name;
    } else {
      map.set(m.uid, {
        uid: m.uid,
        name: m.name || m.uid,
        assign: false,
        create: false,
        roles: m.roles,
        assignCount: 0,
        cutCount: 0,
        credits: 0,
      });
    }
  }
  // 역할 → 담당 → 크레딧 → 이름 순 정렬(마지막 이름 tie-break 로 순서 안정화).
  return [...map.values()].sort(
    (a, b) =>
      roleRank(b.roles) - roleRank(a.roles) ||
      Number(b.assign) - Number(a.assign) ||
      b.credits - a.credits ||
      (a.name || "").localeCompare(b.name || ""),
  );
}

