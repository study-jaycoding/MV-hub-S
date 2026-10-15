"""Scratch homes only; no installed client's configuration is changed."""
import json
import os
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch
from uuid import uuid4

from local_setup import configure_client, read_profile, update_codex, update_claude, _atomic


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
        codex.write_text('model = "keep"\n', encoding="utf-8")
        claude = home / ".claude.json"
        claude.write_text('{"theme":"keep"}', encoding="utf-8")
        for client in ("codex", "claude", "other"):
            credential = {**self.credential, "client_id": str(uuid4())}
            result = configure_client(client, self.setup, credential, home=home, local_appdata=local)
            self.assertEqual(result["status"], "manual" if client == "other" else "configured")
            self.assertNotIn(credential["secret"], json.dumps(result))
            profile = local / "MVHub-MCP" / "connections" / credential["hub_id"] / (credential["client_id"] + ".bin")
            self.assertNotIn(credential["secret"].encode(), profile.read_bytes())
            self.assertEqual(read_profile(profile), credential)
        self.assertEqual(len(list(local.rglob("*.bin"))), 3)
        self.assertEqual(len(list(home.rglob("*.mvhub-backup-*"))), 2)
        self.assertEqual(tomllib.loads(codex.read_text())["model"], "keep")
        self.assertNotIn(self.credential["secret"], codex.read_text() + claude.read_text())

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
