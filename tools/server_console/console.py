"""관리 창 앱 진입점(루트·관리 창 stage 공통): python -I -B <code_root>\\tools\\server_console\\console.py
--install-root <서버 루트> [--check] [--note <문구>]

부트스트랩(main.py)만 이 파일을 띄운다. code_root(이 파일이 든 트리)에서 관리 창 모듈을 가져오고,
기록·잠금·Python·데이터는 모두 install_root 에서 찾는다(2단계 설계 3판 — 경로 분리).
"""
from __future__ import annotations

import sys
from pathlib import Path

CODE_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(CODE_ROOT / "tools"))  # -I 라 스크립트 폴더가 경로에 없다 — 이 판의 도구만

from server_console import main as boot  # noqa: E402 — 같은 판의 격리 함수(표준 라이브러리만)

# 관리 창이 가져오는 모듈 — 모두 code_root 판이어야 한다(경로에 묶인 루트 도구는 도우미 자식으로).
APP_MODULES = ("server_console.names", "server_console.install", "server_console.status", "server_console.logs",
               "server_console.actions", "server_console.jobs", "server_console.console_stage",
               "server_console.server_api", "server_console.backup", "server_console.backup_helper",
               "server_console.job_main", "server_console.ui", "log_viewer", "deploy_fence_check")


def parse(argv: list[str]) -> tuple[Path, bool, str]:
    install_root, check, note = None, False, ""
    items = iter(argv)
    for item in items:
        if item == "--install-root":
            install_root = Path(next(items, ""))
        elif item == "--check":
            check = True
        elif item == "--note":
            note = next(items, "")
        else:
            raise SystemExit(f"[error] 알 수 없는 인자: {item}")
    if install_root is None or not install_root.is_absolute():
        raise SystemExit("[error] --install-root 가 필요합니다(부트스트랩 main.py 로 여세요)")
    return install_root.resolve(), check, note


def stray_modules(modules: dict) -> list[str]:
    """code_root 밖에서 로드된 관리 창 모듈 — 하나라도 있으면 열지 않는다."""
    tools = (CODE_ROOT / "tools").resolve()
    stray = []
    for name in APP_MODULES:
        module = modules.get(name)
        file = getattr(module, "__file__", None)
        if module is None or not file or tools not in Path(file).resolve().parents:
            stray.append(name)
    return stray


def main(argv: list[str]) -> int:
    install_root, check, note = parse(argv)
    boot.isolate_environment(install_root)
    import importlib
    from server_console import install
    install.configure(install_root)
    for name in APP_MODULES:
        importlib.import_module(name)  # --check 는 모든 모듈을 실제로 가져와 본다
    stray = stray_modules(sys.modules)
    if stray:
        print("[error] 관리 창 모듈이 다른 위치에서 로드됐습니다: " + ", ".join(stray), file=sys.stderr)
        return 3
    from server_console import ui
    if check:
        print(f"code_root={CODE_ROOT}")  # 부트스트랩이 어느 판을 띄웠는지(점검·시험용)
        return ui.check_tk()
    return ui.run(note)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
