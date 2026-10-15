"""Isolated Git fixtures; never stage or change files in the user's repository."""

import os
from pathlib import Path
import runpy
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


SOURCE = Path(__file__).resolve().parents[2]
PAIR = {"AGENTS.md": "코덱스", "CLAUDE.md": "클로드"}


class GuidanceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mvhub 지침 ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
        self.env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, PYTHONUTF8="1")
        self.git("-c", "init.templateDir=", "init", "-q")
        self.git("config", "user.name", "Guidance Test")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "core.autocrlf", "false")
        for name in ("tools/check_agent_guidance.py", ".githooks/pre-commit"):
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(SOURCE / name, destination)
        for name in PAIR:
            self.write(name, self.body(name))
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")

    def run_command(self, command, **kwargs):
        return subprocess.run(command, cwd=kwargs.pop("cwd", self.root), env=self.env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)

    def git(self, *args, **kwargs):
        return self.run_command(["git", *args], check=True, **kwargs)

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))

    def body(self, name, suffix=""):
        return "# 지침\n\n> 이 파일({}용)과 짝 지침은 같아야 한다.\n\n공통 본문{}\n".format(PAIR[name], suffix)

    def check(self, expected=0, cwd=None, hook=False):
        if hook:
            command = ["git", "-c", "core.hooksPath=.githooks", "hook", "run", "pre-commit"]
        else:
            command = [sys.executable, str(self.root / "tools/check_agent_guidance.py")]
        start = time.perf_counter()
        result = self.run_command(command, cwd=cwd or self.root)
        self.last_duration = time.perf_counter() - start
        output = (result.stdout + result.stderr).decode("utf-8", "replace")
        self.assertEqual(result.returncode, expected, output)
        return output

    def test_unrelated_change_ignores_unstaged_guidance(self):
        self.write("AGENTS.md", "broken unstaged instruction")
        self.write("normal.py", "x = 1\n")
        self.git("add", "normal.py")
        self.assertEqual(self.check(), "")
        self.assertEqual(self.check(hook=True), "")

    def test_pair_mismatch_does_not_use_worktree_fix(self):
        self.write("AGENTS.md", self.body("AGENTS.md", " changed"))
        self.git("add", "AGENTS.md")
        self.write("CLAUDE.md", self.body("CLAUDE.md", " changed"))
        self.assertIn("본문이 다릅니다", self.check(1))
        self.assertIn("본문이 다릅니다", self.check(1, hook=True))

    def test_staged_pair_ignores_later_worktree_edits(self):
        for name in PAIR:
            self.write(name, self.body(name, " changed"))
        self.git("add", "AGENTS.md", "CLAUDE.md")
        self.write("CLAUDE.md", "someone else's unfinished edit")
        self.assertIn("[통과]", self.check())

    def test_one_deleted(self):
        self.git("rm", "-q", "CLAUDE.md")
        self.assertIn("삭제·이동", self.check(1))

    def test_one_renamed(self):
        self.git("mv", "CLAUDE.md", "이동한 지침.md")
        self.assertIn("삭제·이동", self.check(1))

    def test_both_deleted_warns_without_claiming_approval(self):
        self.git("rm", "-q", *PAIR)
        self.assertIn("삭제 승인 여부는 별도로", self.check())

    def test_unmerged_even_if_not_guidance(self):
        oid = self.git("hash-object", "-w", "--stdin", input=b"conflict").stdout.strip()
        rows = b"".join(b"100644 " + oid + b" " + str(stage).encode() + b"\tordinary.txt\0"
                        for stage in (1, 2, 3))
        self.git("update-index", "-z", "--index-info", input=rows)
        self.assertIn("stage 1~3", self.check(1))
        self.assertIn("unmerged", self.check(1, hook=True))

    def test_bom_crlf_and_subdirectory(self):
        self.write("AGENTS.md", "\ufeff" + self.body("AGENTS.md", " changed").replace("\n", "\r\n"))
        self.write("CLAUDE.md", self.body("CLAUDE.md", " changed"))
        self.git("add", *PAIR)
        self.assertIn("[통과]", self.check(cwd=self.root / "tools"))

    def test_korean_spaces_valid_json_toml(self):
        self.write(".claude/설정 파일.json", '{"name": "한글"}\n')
        self.write(".codex/설정 파일.toml", 'name = "한글"\n')
        self.git("add", ".claude", ".codex")
        self.assertIn("[통과]", self.check())
        self.assertIn("[통과]", self.check(hook=True))

    def test_invalid_json(self):
        self.write(".claude/settings.json", '{"secret": "do-not-print-this",}')
        self.git("add", ".claude/settings.json")
        output = self.check(1)
        self.assertIn("JSONDecodeError", output)
        self.assertNotIn("do-not-print-this", output)

    def test_invalid_toml(self):
        self.write(".codex/config.toml", 'secret = "do-not-print-this')
        self.git("add", ".codex/config.toml")
        output = self.check(1)
        self.assertIn("TOMLDecodeError", output)
        self.assertNotIn("do-not-print-this", output)

    def test_invalid_utf8(self):
        self.write(".codex/config.toml", "")
        (self.root / ".codex/config.toml").write_bytes(b"\xff")
        self.git("add", ".codex/config.toml")
        self.assertIn("UTF-8", self.check(1))

    def test_conflict_marker_in_role(self):
        self.write(".claude/agents/역할 이름.md", "<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n")
        self.git("add", ".claude/agents/역할 이름.md")
        self.assertIn("충돌 표시", self.check(1))

    def test_old_python_version_only_blocks_relevant_changes(self):
        command = [sys.executable, "-c",
                   "import json, os, re, subprocess, runpy, sys; "
                   "sys.version_info = (3, 10, 0); "
                   "runpy.run_path(sys.argv[1], run_name='__main__')",
                   str(self.root / "tools/check_agent_guidance.py")]
        self.write("normal.py", "x = 1\n")
        self.git("add", "normal.py")
        result = self.run_command(command)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.write(".codex/config.toml", "enabled = true\n")
        self.git("add", ".codex/config.toml")
        result = self.run_command(command)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("Python 3.11", result.stderr.decode("utf-8"))

    def test_hook_covers_checker_paths(self):
        checker = runpy.run_path(str(SOURCE / "tools/check_agent_guidance.py"))
        tokens = shlex.split((SOURCE / ".githooks/pre-commit").read_text(encoding="utf-8"))
        for path in checker["PROTECTED_FILES"]:
            self.assertIn(path, tokens)
        start = tokens.index("--no-renames") + 2
        patterns = tokens[start:tokens.index("status=$?")]
        for path in (".githooks/new-hook", ".claude/settings.json", ".codex/config.toml",
                     ".claude/nested/settings.toml", ".codex/nested/settings.json",
                     ".claude/agents/nested/reviewer.md", ".codex/agents/implement.md"):
            with self.subTest(path=path):
                self.assertTrue(checker["relevant"](path))
                self.write(path, "")
                self.git("add", path)
                result = self.run_command(["git", "diff", "--cached", "--quiet", "--no-renames", "--", *patterns])
                self.assertEqual(result.returncode, 1)
                self.git("update-index", "--force-remove", "--", path)

    def test_partial_commit_checks_its_temporary_index(self):
        before = self.git("rev-parse", "HEAD").stdout
        for name in PAIR:
            self.write(name, self.body(name, " changed"))
        self.git("add", *PAIR)
        result = self.run_command(["git", "-c", "core.hooksPath=.githooks", "commit",
                                   "-m", "partial fixture", "--", "AGENTS.md"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("본문이 다릅니다", (result.stdout + result.stderr).decode("utf-8"))
        self.assertEqual(self.git("rev-parse", "HEAD").stdout, before)

    def test_deleted_hook_is_named_in_warning(self):
        self.git("rm", "-q", ".githooks/pre-commit")
        self.assertIn('[보호 파일 변경] [".githooks/pre-commit"]', self.check())


if __name__ == "__main__":
    unittest.main()
