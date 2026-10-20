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

# 해결되지 않은 역방향 의존성만 정확한 파일·import 쌍으로 기록한다.
# 현재는 예외 없이 계층 경계를 지킨다.
KNOWN_DEBT: set[tuple[str, str]] = set()

# P4로 실제 전환한 업무만 강화한다. repo는 SQL/receipt, usecase는 전달받은 권한 port를 사용한다.
STRICT_BUSINESS_IMPORTS = {
    "usecases/share.py": ("app.deps", "app.main", "__dynamic_import__"),
    "repo/share_commands.py": ("app.deps", "app.main", "fastapi", "starlette", "__dynamic_import__"),
}


def _module_name(path: Path) -> str:
    relative = path.relative_to(APP_ROOT).with_suffix("")
    return ".".join(("app", *relative.parts))


def _imported_modules(path: Path, source: str | None = None) -> list[tuple[int, str]]:
    tree = ast.parse(path.read_text(encoding="utf-8") if source is None else source, filename=str(path))
    package = _module_name(path).split(".")[:-1]
    imported: list[tuple[int, str]] = []
    importlib_aliases = {"importlib"}
    importer_aliases = {"__import__"}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            importlib_aliases.update(alias.asname or alias.name for alias in node.names if alias.name == "importlib")
        elif isinstance(node, ast.ImportFrom) and node.module == "importlib" and not node.level:
            importer_aliases.update(alias.asname or alias.name for alias in node.names if alias.name == "import_module")

    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and node.args:
            dynamic_import = (
                isinstance(node.func, ast.Name) and node.func.id in importer_aliases
            ) or (
                isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id in importlib_aliases
                and node.func.attr == "import_module"
            )
            if dynamic_import:
                target = node.args[0].value if isinstance(node.args[0], ast.Constant) else None
                if isinstance(target, str):
                    level = len(target) - len(target.lstrip("."))
                    if level:
                        target = ".".join((*package[:max(0, len(package) - level + 1)], target.lstrip(".")))
                    imported.append((node.lineno, target))
                else:
                    imported.append((node.lineno, "__dynamic_import__"))
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


def _boundary_violations(path: Path, source: str | None = None) -> list[tuple[int, str]]:
    relative = path.relative_to(APP_ROOT)
    forbidden = FORBIDDEN_IMPORTS.get(relative.parts[0], ()) + STRICT_BUSINESS_IMPORTS.get(relative.as_posix(), ())
    return [(line, module) for line, module in _imported_modules(path, source)
            if any(_matches_prefix(module, prefix) for prefix in forbidden)]


def _matches_prefix(module: str, prefix: str) -> bool:
    return module == prefix or module.startswith(f"{prefix}.")


def _graph_module_name(path: Path) -> str:
    module = _module_name(path)
    return module.removesuffix(".__init__")


def _resolve_app_module(imported: str, known: set[str]) -> str | None:
    matches = [
        module
        for module in known
        if imported == module or imported.startswith(f"{module}.")
    ]
    return max(matches, key=len) if matches else None


class ArchitectureBoundaryTests(unittest.TestCase):
    def test_backend_layers_do_not_import_forbidden_dependencies(self) -> None:
        violations: list[str] = []
        observed_debt: set[tuple[str, str]] = set()

        for layer in FORBIDDEN_IMPORTS:
            layer_root = APP_ROOT / layer
            for path in sorted(layer_root.rglob("*.py")):
                for line, module in _boundary_violations(path):

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

    def test_forbidden_synthetic_imports_are_rejected(self) -> None:
        probes = [
            ("repo/probe.py", "from app.usecases import share"),
            ("repo/probe.py", "from ..routers import library"),
            ("usecases/probe.py", "from fastapi import HTTPException"),
            ("usecases/probe.py", "import app.routers.library"),
            ("services/probe.py", "importlib.import_module('app.routers.library')"),
            ("usecases/share.py", "from .. import deps"),
            ("repo/share_commands.py", "__import__('fastapi')"),
            ("usecases/share.py", "from importlib import import_module as load\nload('app.routers.library')"),
            ("usecases/share.py", "import importlib as loader\nloader.import_module('..routers.library', __package__)"),
            ("usecases/share.py", "__import__(variable_module)"),
        ]
        for relative, source in probes:
            with self.subTest(relative=relative, source=source):
                self.assertTrue(_boundary_violations(APP_ROOT / relative, source))

    def test_forward_synthetic_imports_are_allowed(self) -> None:
        probes = [
            ("routers/probe.py", "from ..usecases import share"),
            ("usecases/share.py", "from ..repo import share_commands"),
            ("repo/share_commands.py", "from . import share"),
        ]
        for relative, source in probes:
            with self.subTest(relative=relative, source=source):
                self.assertEqual([], _boundary_violations(APP_ROOT / relative, source))

    def test_backend_internal_import_graph_has_no_cycles(self) -> None:
        paths = sorted(APP_ROOT.rglob("*.py"))
        source_modules = {path: _graph_module_name(path) for path in paths}
        known = set(source_modules.values())
        graph: dict[str, set[str]] = {module: set() for module in known}

        for path, source in source_modules.items():
            for _, imported in _imported_modules(path):
                target = _resolve_app_module(imported, known)
                if target and target != source:
                    graph[source].add(target)

        visiting: list[str] = []
        visited: set[str] = set()
        cycles: set[tuple[str, ...]] = set()

        def walk(module: str) -> None:
            if module in visiting:
                members = visiting[visiting.index(module):]
                rotations = [
                    tuple(members[index:] + members[:index])
                    for index in range(len(members))
                ]
                cycles.add(min(rotations))
                return
            if module in visited:
                return
            visiting.append(module)
            for dependency in graph[module]:
                walk(dependency)
            visiting.pop()
            visited.add(module)

        for module in sorted(graph):
            walk(module)

        self.assertEqual(
            set(),
            cycles,
            "백엔드 내부 import 순환이 발견되었습니다:\n"
            + "\n".join(" -> ".join(cycle) for cycle in sorted(cycles)),
        )


if __name__ == "__main__":
    unittest.main()
