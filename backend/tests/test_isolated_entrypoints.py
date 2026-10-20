"""Only pure interpreter children, never an application server or database."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

PREP = Path(__file__).resolve().parents[2]
REPO = next(root for root in (PREP, *PREP.parents) if (root / "AGENTS.md").is_file())


def child_env(root):
    spec = importlib.util.spec_from_file_location("prepared_env", PREP / "backend/app/services/isolated_env.py")
    helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
    return helper.build_smoke_env({"SYSTEMROOT": r"C:\Windows"}, root,
                                 frontend_dist=root / "no-frontend", python_exe=Path(sys.executable), port=18991)


def test_interpreter_flags_ignore_injection_and_force_utf8_unbuffered(tmp_path):
    env = child_env(tmp_path)
    injected = tmp_path / "injected"; injected.mkdir()
    (injected / "sitecustomize.py").write_text("raise RuntimeError('injected startup executed')", encoding="utf-8")
    env.update(PYTHONPATH=str(injected), PYTHONHOME=str(injected), PYTHONIOENCODING="cp949")
    code = '''import json,sys
assert sys.flags.ignore_environment and sys.flags.no_user_site and sys.dont_write_bytecode
assert sys.flags.utf8_mode == 1 and sys.stdout.write_through
assert sys.argv[1] not in sys.path
print(json.dumps({"encoding":sys.stdout.encoding,"utf8_mode":sys.flags.utf8_mode}))
print("한글 — ✓")
'''
    result = subprocess.run([sys.executable, "-E", "-s", "-B", "-X", "utf8", "-u", "-c", code, str(injected)],
                            env=env, capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    assert "한글 — ✓" in result.stdout.decode("utf-8")
    assert json.loads(result.stdout.decode("utf-8").splitlines()[0])["encoding"].lower() == "utf-8"


def test_tools_wrapper_never_imports_app(tmp_path):
    code = '''import importlib.util,sys
spec=importlib.util.spec_from_file_location("smoke_env_probe",sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
assert callable(module.build_smoke_env) and callable(module.validate_smoke_paths) and callable(module._local_path)
assert not any(name=="app" or name.startswith("app.") for name in sys.modules)
print("pure-wrapper-ok")
'''
    result = subprocess.run([sys.executable, "-E", "-s", "-B", "-X", "utf8", "-c", code,
                             str(PREP / "tools/smoke_env.py")], env=child_env(tmp_path), capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    assert result.stdout.strip() == b"pure-wrapper-ok"


def test_explicit_cli_paths_do_not_import_config_and_default_keeps_current_db(tmp_path):
    code = '''import importlib.abc,importlib.util,sys,types
from pathlib import Path
class RejectConfig(importlib.abc.MetaPathFinder):
 def find_spec(self,fullname,path=None,target=None):
  if fullname in {"app.config","app.db"}: raise AssertionError("unexpected config/DB import: "+fullname)
sys.meta_path.insert(0,RejectConfig())
sys.path.insert(0,sys.argv[1])
spec=importlib.util.spec_from_file_location("prepared_cli",sys.argv[2])
cli=importlib.util.module_from_spec(spec);spec.loader.exec_module(cli)
assert "app.config" not in sys.modules and "app.db" not in sys.modules
snapshot=[]
cli.create_sqlite_snapshot=lambda source,*a,**k:snapshot.append(source)
cli.verify_restore_drill=lambda *a,**k:{"ok":True}
cli.verify_restore_set=lambda *a,**k:{"ok":True}
cli.verify_restored_set_runtime=lambda *a,**k:{"ok":True,"process_stopped":True}
for option in ("--source","--backup","--backup-set"):
 sys.argv=["verify_backup_restore.py",option,str(Path.cwd()/"synthetic.db")]
 assert cli.main()==0
 assert "app.config" not in sys.modules and "app.db" not in sys.modules
current=[]
db=types.ModuleType("app.db")
def get_db_path(): current.append(True);return Path.cwd()/"default-current.db"
db.get_db_path=get_db_path;sys.modules["app.db"]=db
sys.argv=["verify_backup_restore.py"]
assert cli.main()==0 and current==[True]
assert snapshot[-1]==Path.cwd()/"default-current.db"
print("explicit-and-default-ok")
'''
    result = subprocess.run([sys.executable, "-E", "-s", "-B", "-X", "utf8", "-c", code,
                             str(REPO / "backend"), str(PREP / "tools/verify_backup_restore.py")],
                            env=child_env(tmp_path), cwd=tmp_path, capture_output=True, timeout=15)
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
    assert b"explicit-and-default-ok" in result.stdout
