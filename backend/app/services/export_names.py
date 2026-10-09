"""저장 파일의 번호 이름과 그 장부 — 설계 docs/EXPORT_SYNC_DESIGN.md §6.

이름  ``<폴더 마디를 '_' 로>_<토큰>_<번호 3자리 이상><확장자>``      예) ``e020_c0010_share_001.mp4``
토큰  share(공유 저장) · fin(최종 저장) · davinci(다빈치 내보내기). 토큰이 다르면 이름이 겹치지 않아 저장본과
      다빈치 파일은 서로를 건드리지 않는다(Jay 2026-10-08).

번호의 권위는 **렌더 폴더 안의 장부**다(서버·DB 가 아니다 — 파일 곁에 있어야 PC·모드·DB 복원에 따라 어긋나지 않는다)::

    <Render>/_mvhub_sync/names/<컷 폴더 키의 해시>/
        n.<토큰>.<번호>       이 번호의 주인(생성물)            — 번호는 한 생성물만 갖는다
        g.<토큰>.<gen 해시>   이 생성물의 번호                  — 생성물은 번호를 하나만 갖는다
        d.<토큰>.<번호>       그 이름의 파일을 우리가 확정했다   — 이름만 같은 남의 파일을 우리 것으로 보지 않게

항목은 '임시 파일에 다 쓴 뒤 덮어쓰지 않는 이름 바꾸기'로만 만들고 고치지 않는다. 그래서 보이면 언제나 완성본이고,
두 PC 가 같은 번호·같은 생성물을 다퉈도 먼저 만든 쪽 하나만 남는다(진 쪽의 번호는 결번). 읽지 못했거나 서로
어긋난 장부는 '없음'으로 넘기지 않고 RegistryError 로 멈춘다 — 어긋난 채로 번호를 다시 주면 한 이름에 두 생성물이
놓인다(Codex 설계 검토 2026-10-08). 한 번 쓴 번호는 다시 쓰지 않는다(파일을 지워도 장부는 남는다).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import uuid
from pathlib import Path
from typing import Optional

from .path_safety import safe_join

SYNC_DIR = "_mvhub_sync"  # routers/manage.py 의 미러 잠금과 같은 허브 전용 폴더 — 비교·미러는 여기를 훑지 않는다
NAMES_DIR = "names"
TOKENS = {"final": "fin", "shared": "share"}  # 저장 종류(final_export.KINDS) → 이름의 토큰
DAVINCI = "davinci"
_ALL_TOKENS = (*TOKENS.values(), DAVINCI)
_NUMBERED = re.compile(r"(?P<base>.+)_(?P<token>" + "|".join(_ALL_TOKENS) + r")_(?P<seq>\d{3,})")
_EXT = re.compile(r"\.[A-Za-z0-9]{1,5}$")
_MAX_PROBES = 200


class RegistryError(Exception):
    """장부를 읽지 못했거나 서로 어긋난다 — 번호를 주지도, '없다'고 답하지도 않는다."""


def _segments(folder_path: str) -> list[str]:
    return [s for s in (folder_path or "").replace("\\", "/").split("/") if s]


def name_base(folder_path: str) -> str:
    """이름의 앞부분 — 폴더 경로 전체를 '_' 로 잇는다('e020/c0010' → 'e020_c0010')."""
    segs = _segments(folder_path)
    return "_".join(segs) if segs else "cut"


def folder_key(folder_path: str) -> str:
    """장부를 가르는 키 — 목적지 계산과 같은 마디 분해, 대소문자 무시(NAS 의 폴더는 대소문자를 가리지 않는다)."""
    return "/".join(_segments(folder_path)).casefold()


def numbered_name(base: str, token: str, seq: int, ext: str) -> str:
    return f"{base}_{token}_{seq:03d}{ext}"


def parse_numbered(name: str) -> Optional[tuple[str, str, int]]:
    """``e020_c0010_fin_001.mp4`` → ("e020_c0010", "fin", 1). 꼴이 다르면 None(확장자는 떼고 본다)."""
    match = _NUMBERED.fullmatch(_EXT.sub("", name))
    return (match["base"], match["token"], int(match["seq"])) if match else None


def commit_new(tmp: Path, dest: Path) -> None:
    """tmp 를 dest 라는 이름으로 확정한다 — dest 가 이미 있으면 FileExistsError(덮어쓰지 않는다).

    Windows 의 os.rename 은 대상이 있으면 실패한다(NTFS·SMB). POSIX 의 rename 은 덮어쓰므로 하드링크로 같은 뜻을
    낸다 — 하드링크가 안 되는 파일 시스템이면 그대로 실패한다(os.replace 로 물러서지 않는다)."""
    if os.name == "nt":
        os.rename(tmp, dest)
    else:
        os.link(tmp, dest)
        os.unlink(tmp)


def disk_numbers(folder: Path, base: str, token: str) -> list[int]:
    """폴더에 실제로 있는 ``<base>_<토큰>_NNN`` 파일의 번호들. 없는 폴더는 빈 목록, 읽지 못하면 RegistryError.
    장부에 없는 파일의 번호도 건너뛰게 한다 — 장부를 잃어도 이미 있는 파일의 이름을 다른 생성물에 주지 않는다."""
    try:
        names = [entry.name for entry in folder.iterdir()]
    except FileNotFoundError:
        return []
    except OSError as exc:
        raise RegistryError(f"대상 폴더를 읽지 못했습니다: {exc}") from exc
    found: list[int] = []
    for name in names:
        parsed = parse_numbered(name)
        if parsed and parsed[1] == token and parsed[0].casefold() == base.casefold():
            found.append(parsed[2])
    return found


def _gen_file(gen: str) -> str:
    return hashlib.sha1(gen.encode("utf-8")).hexdigest()[:24]


class NameBook:
    """한 컷 폴더·한 토큰의 장부. 저장(비교) 한 번 동안 들고 쓴다 — 내가 만든 항목은 다시 읽어 반영한다."""

    def __init__(self, render_root: Path, folder_path: str, token: str) -> None:
        if token not in _ALL_TOKENS:
            raise ValueError(f"알 수 없는 이름 토큰: {token}")
        self.token = token
        self.base = name_base(folder_path)
        self.key = folder_key(folder_path)
        folder = safe_join(render_root / SYNC_DIR / NAMES_DIR, hashlib.sha1(self.key.encode("utf-8")).hexdigest()[:16])
        if folder is None:
            raise RegistryError("이름 장부 경로가 렌더 폴더 밖을 가리킵니다")
        self.dir = folder
        self._owners: dict[int, dict] = {}
        self._mine: dict[str, dict] = {}
        self._done: set[int] = set()
        self.reload()

    # ── 읽기 ──────────────────────────────────────────────────────────────
    def _read(self, entry: str, seq: Optional[int]) -> dict:
        try:
            data = json.loads((self.dir / entry).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RegistryError(f"이름 장부 항목을 읽지 못했습니다({entry}): {exc}") from exc
        gen, name = (data.get("gen"), data.get("name")) if isinstance(data, dict) else (None, None)
        parsed = parse_numbered(name) if isinstance(name, str) and "/" not in name and "\\" not in name else None
        if seq is None and parsed:
            seq = data.get("seq")
        if (
            not isinstance(gen, str) or not gen or parsed is None or data.get("folder") != self.key
            or parsed[0].casefold() != self.base.casefold() or parsed[1] != self.token or parsed[2] != seq
        ):
            raise RegistryError(f"이름 장부 항목이 맞지 않습니다({entry})")
        return {"gen": gen, "name": name, "seq": seq}

    def reload(self) -> None:
        try:
            entries = [entry.name for entry in self.dir.iterdir()]
        except FileNotFoundError:
            entries = []
        except OSError as exc:
            raise RegistryError(f"이름 장부를 읽지 못했습니다: {exc}") from exc
        owners: dict[int, dict] = {}
        mine: dict[str, dict] = {}
        done: dict[int, dict] = {}
        for entry in entries:
            head, token, tail = (entry.split(".", 2) + ["", ""])[:3]
            if head not in ("n", "g", "d") or token != self.token or not tail:
                continue  # 다른 토큰의 항목·쓰는 중인 임시 파일
            if head == "g":
                item = self._read(entry, None)
                if tail != _gen_file(item["gen"]):
                    raise RegistryError(f"이름 장부 항목이 맞지 않습니다({entry})")
                mine[item["gen"]] = item
            elif tail.isdigit():
                (owners if head == "n" else done)[int(tail)] = self._read(entry, int(tail))
            else:
                raise RegistryError(f"이름 장부 항목이 맞지 않습니다({entry})")
        # 서로 맞는지 — g·d 는 같은 번호의 n 과 생성물·이름이 같아야 한다. 짝 없는 n 은 결번일 뿐이다.
        for item in [*mine.values(), *done.values()]:
            owner = owners.get(item["seq"])
            if owner is None or owner["gen"] != item["gen"] or owner["name"] != item["name"]:
                raise RegistryError(f"이름 장부가 서로 어긋납니다({self.token} {item['seq']:03d}) — 번호를 새로 주지 않습니다")
        self._owners, self._mine, self._done = owners, mine, set(done)

    def name_of(self, gen: str) -> Optional[str]:
        """이 생성물에 배정된 파일 이름(없으면 None). 읽기만 한다 — 번호를 만들지 않는다."""
        item = self._mine.get(gen)
        return item["name"] if item else None

    def is_done(self, gen: str) -> bool:
        """그 이름의 파일을 우리가 확정한 적이 있나 — 파일이 지금 있는지는 부르는 쪽이 본다."""
        item = self._mine.get(gen)
        return bool(item) and item["seq"] in self._done

    # ── 쓰기 ──────────────────────────────────────────────────────────────
    def _publish(self, entry: str, payload: dict) -> bool:
        """항목을 만든다. 만들었으면 True, 이미 있었으면 False."""
        target = self.dir / entry
        tmp = self.dir / f".{uuid.uuid4().hex}.tmp"
        try:
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            commit_new(tmp, target)
            return True
        except FileExistsError:
            return False
        except OSError as exc:
            # 응답이 끊겼어도 실제로는 만들어졌을 수 있다 — 다시 읽어 같으면 성공. 확인할 수 없으면 멈춘다(다음 번호로 넘어가지 않는다).
            try:
                if json.loads(target.read_text(encoding="utf-8")) == payload:
                    return True
            except (OSError, ValueError):
                pass
            raise RegistryError(f"이름 장부에 적지 못했습니다: {exc}") from exc
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

    def allocate(self, gen: str, ext: str, dest_dir: Path) -> str:
        """이 생성물의 파일 이름 — 이미 있으면 그것, 없으면 다음 번호를 확보한다. **쓰기 직전에만** 부른다
        (조회는 name_of — 탭을 여는 것만으로 번호가 생기지 않게). dest_dir = 그 파일이 놓일 실제 폴더."""
        if not gen:
            raise RegistryError("생성물 id 가 없습니다")
        found = self.name_of(gen)
        if found:
            return found
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise RegistryError(f"이름 장부 폴더를 만들지 못했습니다: {exc}") from exc
        seq = max([*self._owners, *disk_numbers(dest_dir, self.base, self.token)], default=0)
        for _probe in range(_MAX_PROBES):
            seq += 1
            name = numbered_name(self.base, self.token, seq, ext)
            if not self._publish(f"n.{self.token}.{seq:03d}", {"gen": gen, "name": name, "folder": self.key}):
                self.reload()
                found = self.name_of(gen)
                if found:
                    return found  # 다른 PC 가 같은 생성물을 먼저 배정했다
                held = self._owners.get(seq)
                if held is None or held["gen"] != gen:
                    # 다른 생성물이 가져간 번호 — 방금 다시 읽은 장부의 마지막 번호 다음으로 건너뛴다(낡은 장부로 하나씩 더듬지 않는다)
                    seq = max([seq, *self._owners])
                    continue
                name = held["name"]  # 같은 생성물이 쥔 번호(응답이 끊겼던 내 재시도 등) — 이어서 쓴다
            item = {"gen": gen, "seq": seq, "name": name}
            self._owners[seq] = item  # 내가 쥔 번호 — 장부를 다시 읽지 않고 반영한다(저장마다 전체를 다시 읽으면 건수의 제곱, Codex 검토 10-09)
            if self._publish(f"g.{self.token}.{_gen_file(gen)}", {"gen": gen, "seq": seq, "name": name, "folder": self.key}):
                self._mine[gen] = item
                return name
            self.reload()  # 졌다(다른 PC 가 같은 생성물을 먼저 배정) — 이긴 쪽 값이 읽힌다, 내 번호는 결번
            found = self.name_of(gen)
            if not found:
                raise RegistryError("파일 이름을 배정하지 못했습니다")
            return found
        raise RegistryError("빈 번호를 찾지 못했습니다")

    def mark_done(self, gen: str) -> None:
        """그 이름의 파일을 방금 우리가 확정했다고 적는다(목적지 이름 바꾸기가 성공한 뒤에만)."""
        item = self._mine.get(gen)
        if item is None:
            raise RegistryError("배정되지 않은 생성물입니다")
        self._publish(f"d.{self.token}.{item['seq']:03d}", {"gen": gen, "name": item["name"], "folder": self.key})
        self._done.add(item["seq"])  # 이미 있었어도 같은 뜻 — 다시 읽지 않는다


class Books:
    """저장·비교 한 번 동안 폴더별 장부를 한 번씩만 읽는다(대상마다 NAS 를 다시 열거하지 않게)."""

    def __init__(self, render_root: Path) -> None:
        self.root = render_root
        self._books: dict[tuple[str, str], NameBook] = {}

    def get(self, folder_path: str, token: str) -> NameBook:
        key = (folder_key(folder_path), token)
        if key not in self._books:
            self._books[key] = NameBook(self.root, folder_path, token)
        return self._books[key]
