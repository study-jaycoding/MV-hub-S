import { GLOBAL_ROLE_LABEL, type Account, type Member, type ProjectMember } from "../types";

export type ProviderIdentity = { uid: string | null; name: string | null; email: string | null };

export function accountRoleText(account?: Account | null): string {
  const roles = account?.global_roles || [];
  return roles.map((r) => (GLOBAL_ROLE_LABEL[r] || r).split(" · ")[0]).join("/");
}

export function accountDisplayName(
  account?: Account | null,
  provider?: ProviderIdentity | null,
): string {
  return account?.name || account?.email || provider?.name || "사용자";
}

export function accountEmail(account?: Account | null, provider?: ProviderIdentity | null): string {
  return account?.email || provider?.email || "—";
}

export function accountUid(account?: Account | null, provider?: ProviderIdentity | null): string {
  return account?.creator_uid || provider?.uid || "—";
}

export function roleLabelList(roles?: string[]): string {
  return (roles || []).map((r) => (GLOBAL_ROLE_LABEL[r] || r).split(" · ")[0]).join(", ");
}

const SYSTEM_EMAILS = new Set(["admin@millionvolt.com"]);

export function isSystemAccountEmail(email?: string | null): boolean {
  return !!email && SYSTEM_EMAILS.has(email.toLowerCase());
}

export function findCurrentMember(account: Account | null | undefined, members: Member[]): Member | undefined {
  return (
    (account &&
      members.find(
        (member) =>
          (!!account.creator_uid && member.uid === account.creator_uid) ||
          (!!account.email &&
            !!member.email &&
            member.email.toLowerCase() === account.email.toLowerCase()),
      )) ||
    members.find((member) => member.is_mine)
  );
}

export function viewerGlobalRoles(account: Account | null | undefined, members: Member[]): string[] {
  const current = findCurrentMember(account, members);
  if (current?.global_roles?.length) return current.global_roles;
  if (account?.global_roles?.length) return account.global_roles;
  if (account) return ["member"];
  return ["admin"];
}

export function systemMemberUids(members: Member[]): Set<string> {
  return new Set(members.filter((member) => isSystemAccountEmail(member.email)).map((member) => member.uid));
}

export function isSystemMember(
  member: { uid: string; email?: string | null },
  systemUids: Set<string>,
): boolean {
  return isSystemAccountEmail(member.email) || systemUids.has(member.uid);
}

export function visibleAdminMembers(members: Member[], systemUids: Set<string>): Member[] {
  return members.filter((member) => !isSystemMember(member, systemUids));
}

export function visibleAdminAccounts(accounts: Account[]): Account[] {
  return accounts.filter((account) => !isSystemAccountEmail(account.email));
}

export function adminMemberDisplayName(members: Member[], uid: string): string {
  const member = members.find((item) => item.uid === uid);
  return member ? (member.is_mine ? "나" : member.name || "팀원") : "팀원";
}

export function projectRoleCounts(
  members: ProjectMember[],
  systemUids: Set<string>,
): { project_manager: number; supervisor: number; creator: number } {
  const counts = { project_manager: 0, supervisor: 0, creator: 0 };
  members
    .filter((member) => !systemUids.has(member.uid))
    .forEach((member) =>
      (member.roles || []).forEach((role) => {
        if (role in counts) counts[role as keyof typeof counts] += 1;
      }),
    );
  return counts;
}
