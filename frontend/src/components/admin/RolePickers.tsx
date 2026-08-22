import {
  GLOBAL_ROLE_LABEL,
  GLOBAL_ROLES,
  PROJECT_ROLE_LABEL,
  PROJECT_ROLES,
} from "../../types";

export function memberRoleRank(roles: string[] | undefined): number {
  const ranks = (roles || []).map((r) => GLOBAL_ROLES.indexOf(r as never));
  const valid = ranks.filter((i) => i >= 0);
  return valid.length ? Math.min(...valid) : GLOBAL_ROLES.length;
}

export function GlobalRolePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string[];
  onChange: (roles: string[]) => void;
  // 저장 중 잠금 — 응답 전 다음 칩을 누르면 낡은 value 로 계산해 앞의 변경이 지워진다.
  disabled?: boolean;
}) {
  const has = (role: string) => value.includes(role);
  const toggle = (role: string) =>
    onChange(has(role) ? value.filter((x) => x !== role) : [...value, role]);
  return (
    <div className="role-chips">
      {GLOBAL_ROLES.map((role) => (
        <button
          key={role}
          type="button"
          className={"role-chip role-" + role + (has(role) ? " on" : "")}
          title={GLOBAL_ROLE_LABEL[role]}
          disabled={disabled}
          onClick={() => toggle(role)}
        >
          {GLOBAL_ROLE_LABEL[role].split(" · ")[0]}
        </button>
      ))}
    </div>
  );
}

export function ProjectRolePicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (roles: string[]) => void;
}) {
  const has = (role: string) => value.includes(role);
  const toggle = (role: string) =>
    onChange(has(role) ? value.filter((x) => x !== role) : [...value, role]);
  return (
    <div className="role-chips">
      {PROJECT_ROLES.map((role) => (
        <button
          key={role}
          type="button"
          className={"role-chip role-" + role + (has(role) ? " on" : "")}
          title={PROJECT_ROLE_LABEL[role]}
          onClick={() => toggle(role)}
        >
          {PROJECT_ROLE_LABEL[role].split(" · ")[0]}
        </button>
      ))}
    </div>
  );
}
