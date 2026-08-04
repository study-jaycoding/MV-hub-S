"""백엔드 계층의 명백한 역방향 의존성을 막는 최소 아키텍처 테스트."""

from __future__ import annotations

import ast
import unittest
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[1] / "app"

# 아직 남아 있는 기술 부채를 한꺼번에 실패시키지 않는다. 현재 코드가 이미
# 지키는 최소 경계부터 고정하고, 리팩토링 단계마다 규칙을 강화한다.
FORBIDDEN_IMPORTS: dict[str, tuple[str, ...]] = {
    "repo": ("app.routers", "app.usecases"),
    "usecases": ("app.routers", "fastapi", "starlette"),
    "services": ("app.routers",),
}

# 제거 대상이지만 아직 동작 코드에 남아 있는 역방향 의존성이다. 정확한 파일과
# import만 허용하므로 같은 계층의 새 위반은 통과하지 못한다.
KNOWN_DEBT: set[tuple[str, str]] = {
    ("app/services/asset_watcher.py", "app.routers.assets"),
}


def _module_name(path: Path) -> str:
    relative = path.relative_to(APP_ROOT).with_suffix("")
    return ".".join(("app", *relative.parts))


def _imported_modules(path: Path) -> list[tuple[int, str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    package = _module_name(path).split(".")[:-1]
    imported: list[tuple[int, str]] = []

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.extend((node.lineno, alias.name) for alias in node.names)
            continue

        if not isinstance(node, ast.ImportFrom):
            continue

        if node.level:
            parent_hops = node.level - 1
            base = package[: max(0, len(package) - parent_hops)]
            if node.module:
                imported.extend(
                    (node.lineno, ".".join((*base, node.module, alias.name)))
                    for alias in node.names
                )
            else:
                imported.extend(
                    (node.lineno, ".".join((*base, alias.name)))
                    for alias in node.names
                )
        elif node.module:
            imported.extend(
                (node.lineno, ".".join((node.module, alias.name)))
                for alias in node.names
            )

    return imported


def _matches_prefix(module: str, prefix: str) -> bool:
    return module == prefix or module.startswith(f"{prefix}.")


class ArchitectureBoundaryTests(unittest.TestCase):
    def test_backend_layers_do_not_import_forbidden_dependencies(self) -> None:
        violations: list[str] = []
        observed_debt: set[tuple[str, str]] = set()

        for layer, forbidden_prefixes in FORBIDDEN_IMPORTS.items():
            layer_root = APP_ROOT / layer
            for path in sorted(layer_root.rglob("*.py")):
                for line, module in _imported_modules(path):
                    if not any(
                        _matches_prefix(module, prefix)
                        for prefix in forbidden_prefixes
                    ):
                        continue

                    relative = path.relative_to(APP_ROOT.parent).as_posix()
                    debt_key = (relative, module)
                    if debt_key in KNOWN_DEBT:
                        observed_debt.add(debt_key)
                    else:
                        violations.append(f"{relative}:{line} imports {module}")

        self.assertEqual(
            [],
            violations,
            "계층 역방향 import가 발견되었습니다:\n" + "\n".join(violations),
        )
        self.assertEqual(
            KNOWN_DEBT,
            observed_debt,
            "KNOWN_DEBT가 실제 코드와 다릅니다. 해결된 항목은 예외 목록에서도 제거하세요.",
        )


if __name__ == "__main__":
    unittest.main()
