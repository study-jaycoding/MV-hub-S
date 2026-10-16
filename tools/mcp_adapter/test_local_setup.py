"""Scratch homes only; no installed client's configuration is changed."""
import json
import os
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch
from uuid import uuid4

from local_setup import configure_client, read_profile, remove_profiles, update_codex, update_claude, _atomic


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.python = self.root / "한글 Python" / "python.exe"
        self.adapter = self.root / "앱 폴더" / "server.py"
        for path in (self.python, self.adapter):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture")
        self.setup = {"python": str(self.python), "adapter": str(self.adapter), "url": "http://127.0.0.1:8016", "python_args": ["-I", "-S"]}
        self.credential = {"secret": "s" * 43, "hub_id": "a" * 64, "client_id": str(uuid4()), "url": self.setup["url"]}
        self.entry = {"command": str(self.python), "args": ["-I", "-S", str(self.adapter), "--url", self.setup["url"]]}

    def tearDown(self):
        self.temp.cleanup()

    def test_codex_preserves_comments_other_settings_and_nested_servers(self):
        text = '# important\nmodel = "unchanged"\n[mcp_servers.other]\ncommand = "keep"\n[mcp_servers.mvhub]\ncommand = ' + json.dumps(str(self.python)) + '\nargs = ' + json.dumps(self.entry["args"]) + '\n[mcp_servers.mvhub.env]\nOLD = "removed"\n[projects."D:/my project"]\ntrust_level = "trusted"\n'
        updated = update_codex(text, self.entry, self.setup)
        parsed = tomllib.loads(updated)
        self.assertIn("# important", updated)
        self.assertEqual(parsed["model"], "unchanged")
        self.assertEqual(parsed["mcp_servers"]["other"], {"command": "keep"})
        self.assertEqual(parsed["projects"], {"D:/my project": {"trust_level": "trusted"}})
        self.assertEqual(parsed["mcp_servers"]["mvhub"], {**self.entry, "tool_timeout_sec": 150})

    def test_conflicting_or_ambiguous_settings_are_not_replaced(self):
        for text in ('[mcp_servers.mvhub]\ncommand = "unrelated"\nargs=[]', 'mcp_servers = {mvhub = {command="other"}}', 'bad [ syntax'):
            with self.subTest(text=text), self.assertRaises(ValueError):
                update_codex(text, self.entry, self.setup)
        with self.assertRaises(ValueError):
            update_claude('{"mcpServers":{"mvhub":{"command":"other","args":[]}}}', self.entry, self.setup)

    def test_claude_preserves_other_fields(self):
        original = {"userTheme": "dark", "projects": {"d:/x": {"trust": True}}, "mcpServers": {"other": {"command": "keep"}}}
        updated = json.loads(update_claude(json.dumps(original), self.entry, self.setup))
        self.assertEqual(updated["userTheme"], original["userTheme"])
        self.assertEqual(updated["projects"], original["projects"])
        self.assertEqual(updated["mcpServers"]["other"], original["mcpServers"]["other"])
        self.assertEqual(updated["mcpServers"]["mvhub"], {"type": "stdio", **self.entry})

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI")
    def test_registration_dpapi_backup_and_independent_profiles(self):
        home, local = self.root / "home", self.root / "local"
        codex = home / ".codex" / "config.toml"
        codex.parent.mkdir(parents=True)
        codex.write_text('model = "keep"\n[mcp_servers.mvhub]\ncommand = ' + json.dumps(str(self.python))
                         + '\nargs = ' + json.dumps(self.entry["args"]) + '\n', encoding="utf-8")
        claude = home / ".claude.json"
        claude.write_text('{"theme":"keep"}', encoding="utf-8")
        for client in ("codex", "claude", "other"):
            credential = {**self.credential, "client_id": str(uuid4())}
            result = configure_client(client, self.setup, credential, home=home, local_appdata=local)
            self.assertEqual(result["status"], "manual" if client == "other" else "configured")
            if client == "codex":
                args = tomllib.loads(codex.read_text(encoding="utf-8"))["mcp_servers"]["mvhub"]["args"]
                self.assertEqual(args[args.index("--display-mode") + 1], "conversation")
            else:
                args = json.loads(claude.read_text(encoding="utf-8") if client == "claude" else result["config"])["mcpServers"]["mvhub"]["args"]
                self.assertNotIn("--display-mode", args)
            self.assertNotIn(credential["secret"], json.dumps(result))
            profile = local / "MVHub-MCP" / "connections" / credential["hub_id"] / (credential["client_id"] + ".bin")
            self.assertNotIn(credential["secret"].encode(), profile.read_bytes())
            self.assertEqual(read_profile(profile), credential)
        self.assertEqual(len(list(local.rglob("*.bin"))), 3)
        self.assertEqual(len(list(home.rglob("*.mvhub-backup"))), 2)
        self.assertEqual(tomllib.loads(codex.read_text())["model"], "keep")
        self.assertNotIn(self.credential["secret"], codex.read_text() + claude.read_text())

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI")
    def test_config_backup_is_bounded_and_contains_previous_bytes(self):
        # Codex 리뷰 P2 ⑤ — 등록할 때마다 새 이름의 백업이 쌓였다. 설정 파일마다 직전 사본 한 개(바로 앞 내용)만
        home, local = self.root / "home", self.root / "local"
        claude = home / ".claude.json"
        claude.parent.mkdir(parents=True)
        claude.write_text('{"theme":"first"}', encoding="utf-8")
        first = claude.read_bytes()
        previous = None
        for _ in range(3):
            previous = claude.read_bytes()
            result = configure_client("claude", self.setup, {**self.credential, "client_id": str(uuid4())}, home=home, local_appdata=local)
            self.assertEqual(result["status"], "configured")
        # 사본은 두 개로 끝난다 — 처음 등록 전 원본(한 번만, 다시 안 씀)과 바로 앞 내용(재리뷰 P2: 하나만 두면 원래 설정이 사라졌다)
        self.assertEqual(sorted(path.name for path in home.glob(".claude.json.mvhub-*")),
                         [".claude.json.mvhub-backup", ".claude.json.mvhub-original"])
        self.assertEqual((home / ".claude.json.mvhub-original").read_bytes(), first)
        self.assertEqual((home / ".claude.json.mvhub-backup").read_bytes(), previous)

    def test_remove_profiles_deletes_only_the_listed_connections(self):
        local = self.root / "local"
        hub = "a" * 64
        folder = local / "MVHub-MCP" / "connections" / hub
        folder.mkdir(parents=True)
        revoked, active = str(uuid4()), str(uuid4())
        for client_id in (revoked, active):
            (folder / (client_id + ".bin")).write_bytes(b"x")
        other_hub = local / "MVHub-MCP" / "connections" / ("b" * 64)
        other_hub.mkdir(parents=True)
        (other_hub / (revoked + ".bin")).write_bytes(b"x")
        self.assertEqual(remove_profiles(hub, [revoked, "../escape", str(uuid4())], local_appdata=local), 1)
        self.assertEqual(sorted(path.name for path in local.rglob("*.bin")), sorted([active + ".bin", revoked + ".bin"]))
        self.assertTrue((other_hub / (revoked + ".bin")).exists())  # 다른 허브의 같은 이름은 그대로
        self.assertEqual(remove_profiles("../x", [active], local_appdata=local), 0)
        self.assertTrue((folder / (active + ".bin")).exists())

    def test_concurrent_config_edit_is_preserved(self):
        path = self.root / "config.toml"
        path.write_bytes(b"another editor")
        with self.assertRaises(ValueError):
            _atomic(path, b"our edit", b"old content", compare=True)
        self.assertEqual(path.read_bytes(), b"another editor")

    def test_non_desktop_user_cannot_write_configuration_or_profile(self):
        local = self.root / "not-created"
        with patch("local_setup._require_interactive_user", side_effect=ValueError("wrong user")):
            with self.assertRaisesRegex(ValueError, "wrong user"):
                configure_client("other", self.setup, self.credential, home=local, local_appdata=local)
        self.assertFalse(local.exists())

    @unittest.skipUnless(os.name == "nt", "Windows DPAPI")
    def test_invalid_or_corrupted_profile_fails_closed(self):
        path = self.root / "bad.bin"
        path.write_bytes(b"not encrypted")
        with self.assertRaises(ValueError):
            read_profile(path)
        with self.assertRaises(ValueError):
            configure_client("other", self.setup, {**self.credential, "extra": True}, home=self.root, local_appdata=self.root)


if __name__ == "__main__":
    unittest.main()
