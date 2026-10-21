"""Check staged guidance or a fixed Git tree; consistency is not approval."""

import argparse
import json
import os
import re
import subprocess
import sys


PROTECTED_FILES = {
    "AGENTS.md", "CLAUDE.md",
    "docs/AGENT_WORKFLOW.md", "docs/WORKROOMS.md", "docs/TESTING.md",
    "docs/RISK_REDUCTION_PLAN_2026-08-15.md",
    "docs/PR_GATE.md", ".github/pull_request_template.md",
    "tools/check_agent_guidance.py", "tools/tests/test_agent_guidance.py",
}
CONFLICT = re.compile(r"^(?:<{7}|={7}|>{7}|\|{7})(?:\s|$)", re.MULTILINE)


def relevant(path):
    if path in PROTECTED_FILES or path.startswith(".githooks/"):
        return True
    if path.startswith(".github/workflows/") and path.endswith((".yml", ".yaml")):
        return True
    return path.startswith((".claude/", ".codex/")) and (
        path.endswith((".json", ".toml"))
        or (path.startswith((".claude/agents/", ".codex/agents/")) and path.endswith(".md"))
    )


def git(*args):
    return subprocess.run(
        ["git", "--no-optional-locks", *args], check=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE
    ).stdout


def pair_body(text):
    return re.sub(r"^> 이 파일\([^\n]*\n?", "", text, count=1, flags=re.MULTILINE)


def check(tree=None):
    os.chdir(git("rev-parse", "--show-toplevel").decode("utf-8").rstrip("\r\n"))
    entries = {}
    if tree is not None:
        tree = git("rev-parse", "--verify", "--end-of-options", tree + "^{tree}").decode("ascii").strip()
        for row in git("ls-tree", "-r", "-z", tree).split(b"\0"):
            if row:
                metadata, name = row.split(b"\t", 1)
                mode, _, oid = metadata.split()
                entries[name.decode("utf-8", "surrogateescape")] = (mode, oid.decode("ascii"))
        targets = {path for path in entries if relevant(path)} | {"AGENTS.md", "CLAUDE.md"}
    else:
        for row in git("ls-files", "--stage", "-z").split(b"\0"):
            if not row:
                continue
            metadata, name = row.split(b"\t", 1)
            mode, oid, stage = metadata.split()
            if stage != b"0":
                raise ValueError("병합 충돌이 남아 있습니다. index의 stage 1~3을 먼저 해결하세요.")
            entries[name.decode("utf-8", "surrogateescape")] = (mode, oid.decode("ascii"))
        changed = {
            name.decode("utf-8", "surrogateescape")
            for name in git("diff", "--cached", "--name-only", "--no-renames", "-z").split(b"\0")
            if name
        }
        targets = {path for path in changed if relevant(path)}
    if not targets:
        return
    if sys.version_info < (3, 11):
        raise ValueError("운영 지침 검사에는 Python 3.11 이상이 필요합니다.")
    import tomllib

    print("[주의] 로컬 일관성 점검이며 사용자 승인 증명이 아닙니다. "
          "훅·검사기 변경이나 --no-verify로 우회할 수 있습니다.")
    if tree is not None:
        print("[검사 tree] " + tree)
    print(("[검사 대상] " if tree is not None else "[보호 파일 변경] ")
          + json.dumps(sorted(targets), ensure_ascii=False))
    texts = {}

    def read(path):
        if path not in texts:
            mode, oid = entries[path]
            if mode not in (b"100644", b"100755"):
                raise ValueError("{}: 일반 파일만 검사할 수 있습니다.".format(path))
            try:
                texts[path] = git("cat-file", "blob", oid).decode("utf-8-sig").replace("\r\n", "\n")
            except UnicodeError:
                raise ValueError("{}: 올바른 UTF-8 파일이 아닙니다.".format(path)) from None
        return texts[path]

    if targets & {"AGENTS.md", "CLAUDE.md"}:
        present = [path for path in ("AGENTS.md", "CLAUDE.md") if path in entries]
        if len(present) == 1:
            raise ValueError("AGENTS.md와 CLAUDE.md 중 한쪽이 삭제·이동되었거나 없습니다.")
        if not present:
            if tree is not None:
                raise ValueError("검사 tree에 지침 두 파일이 모두 없습니다.")
            print("[주의] 지침 두 파일이 모두 없습니다. 삭제 승인 여부는 별도로 확인하세요.")
        else:
            targets.update(present)
            if pair_body(read("AGENTS.md")) != pair_body(read("CLAUDE.md")):
                raise ValueError("AGENTS.md와 CLAUDE.md의 검사 대상 본문이 다릅니다.")
    for path in sorted(targets):
        if path not in entries:
            continue
        text = read(path)
        if CONFLICT.search(text):
            raise ValueError("{}: 병합 충돌 표시가 있습니다.".format(path))
        try:
            if path.endswith(".json"):
                json.loads(text)
            elif path.endswith(".toml"):
                tomllib.loads(text)
        except ValueError as exc:
            # Do not print parser snippets: settings can contain secrets.
            raise ValueError("{}: {} 형식 오류입니다.".format(path, type(exc).__name__)) from None
    print("[통과] " + ("tree의" if tree is not None else "stage된") + " 운영 지침·설정 일관성 검사")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tree", metavar="REF", help="검사할 Git 커밋 또는 tree (기본: staged 변경)")
    args = parser.parse_args()
    try:
        check(args.tree)
    except (ValueError, subprocess.CalledProcessError, OSError) as exc:
        message = str(exc) if isinstance(exc, ValueError) else "Git 또는 검사기 실행 실패"
        print("[실패] " + message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
