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
        self._disk: dict[Path, int] = {}  # 대상 폴더에 이미 있는 가장 큰 번호 — 폴더마다 한 번만 훑는다(allocate)
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
        # 대상 폴더는 이 장부를 든 동안(저장·전송 한 번) 한 번만 훑는다 — 파일마다 훑으면 NAS 열거가 '새 파일 수 × 폴더의 파일 수'다
        # (Codex 배포 전 검토 2026-10-13). 내가 준 번호는 _owners 에, 다른 PC 가 준 번호는 장부에 있다(겹치면 아래에서 다시 읽는다).
        # ponytail: 훑은 뒤 누가 장부 없이 다음 번호 이름의 파일을 놓으면 못 보고 그 이름을 준다 — 덮어쓰지는 않는다(부르는 쪽이
        # '같은 이름의 다른 파일'로 그 건만 실패시키고, 확정은 commit_new 다). 다음 저장·전송은 새 장부라 다시 훑는다.
        if dest_dir not in self._disk:
            self._disk[dest_dir] = max(disk_numbers(dest_dir, self.base, self.token), default=0)
        seq = max([*self._owners, self._disk[dest_dir]])
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
        self._books2: dict[str, NameBook2] = {}

    def get(self, folder_path: str, token: str) -> NameBook:
        key = (folder_key(folder_path), token)
        if key not in self._books:
            self._books[key] = NameBook(self.root, folder_path, token)
        return self._books[key]

    def v2(self, folder_path: str) -> "NameBook2":
        key = folder_key(folder_path)
        if key not in self._books2:
            self._books2[key] = NameBook2(self.root, folder_path)
        return self._books2[key]


# ── v2(2026-10-13) — <프로젝트>_<폴더 마디>_<종류>_<작업자>_<번호> · 설계 docs/EXPORT_SYNC_DESIGN.md §7 ──────────
# 번호는 '컷 폴더 × 작업자' 한 줄에서 **이름을 처음 받은 순서**로 한 번만 배정한다(종류와 무관 — 상태가 바뀌어도 번호는 그대로).
# 장부는 위의 v1(`names/`)과 물리적으로 나눈 `names2/` 다. v1 코드는 옛 파일을 알아보는 데 계속 쓴다.
NAMES2_DIR = "names2"
WORK = "work"
KINDS2 = (WORK, *TOKENS.values(), DAVINCI)  # work · fin · share · davinci
SAVED_KINDS2 = tuple(TOKENS.values())  # 렌더 폴더의 저장본 — 비교·미러가 '우리 파일'로 볼 수 있는 종류는 이것뿐
NO_WORKER = "noname"
PROJECT_MAX, WORKER_MAX, NAME_MAX = 24, 16, 150
_PART_BAD = re.compile(r'[\x00-\x1f\\/:*?"<>|\s]+|\.{2,}')  # `..` 도 — 목적지 검증(project_folders._dest_parts)이 거부한다
_KIND_MARK = re.compile(r"(?=_(" + "|".join(KINDS2) + r")_)")  # 겹쳐서도 센다(`_fin_fin_`)
_TAIL_SEQ = re.compile(r"_(\d{3,})$")
_LONGEST_EXT = ".00000"  # _EXT 가 받는 가장 긴 확장자 — 이름 길이는 확장자와 무관하게 맞춘다


def clean_part(text: object, limit: int) -> str:
    """이름의 한 부분 — 금지 문자·공백·`..` 은 '_', '_' 연속은 하나로, 앞뒤의 `._ ` 는 뗀다. limit 글자에서 자른다."""
    cleaned = re.sub(r"_+", "_", _PART_BAD.sub("_", str(text or ""))).strip("._ ")
    return cleaned[:limit].rstrip("._ ")


def name_base2(folder_path: str) -> str:
    """폴더 마디 전부를 '_' 로 — 폴더가 없으면 빈 문자열(v2 는 없는 부분을 뺀다)."""
    return "_".join(_segments(folder_path))


def v2_name(project: str, base: str, kind: str, worker: str, tail: str, ext: str) -> str:
    """tail = 번호('001') 또는 번호를 받지 못했을 때의 임시 꼬리('x1a2b3c4d')."""
    return "_".join(part for part in (project, base, kind, worker, tail) if part) + ext


def _fit(project: str, base: str, worker: str) -> tuple[str, str]:
    """전체 이름이 NAME_MAX 를 넘지 않게 프로젝트·작업자 부분을 줄인다(가장 긴 종류 `davinci` + 번호 6자리 + 가장 긴 확장자 기준 —
    **확장자에 따라 달라지지 않는다**: 줄인 작업자 이름이 번호 줄을 정하므로 mp4 와 jpeg 가 다른 줄로 갈리면 안 된다).
    폴더 마디만으로 넘으면 줄일 것이 없다 — 오류."""
    over = len(v2_name(project, base, DAVINCI, worker, "000000", _LONGEST_EXT)) - NAME_MAX
    if over > 0:
        cut = min(over, max(0, len(project) - 4))
        project = project[: len(project) - cut].rstrip("._ ")
        over -= cut
    if over > 0:
        cut = min(over, max(0, len(worker) - 4))
        worker = worker[: len(worker) - cut].rstrip("._ ")
        over -= cut
    if over > 0:
        raise RegistryError("파일 이름이 너무 깁니다(폴더 경로가 너무 깁니다)")
    return project, worker or NO_WORKER


class Ident:
    """이름을 지을 생성물 하나 — 프로젝트 id · 열쇠 후보(`job_id` 먼저, 그다음 `id`) · 정제한 프로젝트·작업자 이름.
    열쇠가 둘인 까닭: `job_id` 는 나중에 채워지거나 교정될 수 있다 — 어느 쪽으로든 같은 배정을 찾게 한다.
    named=False 는 이름 재료(프로젝트·작업자 이름)를 받지 못한 것(옛 서버) — **이미 있는 배정을 찾는 데만** 쓰고 새 번호는 받지 않는다."""

    __slots__ = ("pid", "keys", "project", "worker", "named")

    def __init__(self, project_id: object, project_name: object, job_id: object, gen_id: object, creator_name: object, named: bool = True) -> None:
        self.pid = str(project_id or "")
        self.keys = tuple(dict.fromkeys(str(value) for value in (job_id, gen_id) if value))
        self.project = clean_part(project_name, PROJECT_MAX)
        self.worker = clean_part(creator_name, WORKER_MAX) or NO_WORKER
        self.named = named


def temp_name(ident: Ident, folder_path: str, kind: str, ext: str) -> str:
    """번호를 받지 못했을 때의 이름 — 같은 꼴에 번호 자리만 `x<열쇠 해시 8자>`. 장부에 적지 않는다(다운로드 전용).
    해시는 **공통 열쇠 하나**(`job_id or id`)로 — PC 마다 다른 로컬 id 를 섞으면 같은 생성물의 임시 이름이 PC 마다 달라진다."""
    base = name_base2(folder_path)
    tail = "x" + hashlib.sha1("\n".join((ident.pid, *ident.keys[:1])).encode("utf-8")).hexdigest()[:8]
    try:
        project, worker = _fit(ident.project, base, ident.worker)
    except RegistryError:
        project, worker, base = "", ident.worker, base[-80:]  # 임시 이름은 실패하지 않는다 — 폴더 이름의 뒤쪽만 남긴다
    return v2_name(project, base, kind, worker, tail, ext)


def _v2_readings(name: str, folder_path: str) -> list[tuple[str, int]]:
    """이 이름을 v2 로 읽는 방법 전부 — 각 (종류, 번호). 종류 표식(`_work_`·`_share_`·`_fin_`·`_davinci_`) 가운데 **바로 앞이 이 컷의
    폴더 마디로 끝나는 것**만 종류 후보다. 확장자는 떼고 본다."""
    stem = _EXT.sub("", name)
    tail = _TAIL_SEQ.search(stem)
    if tail is None:
        return []
    body = "_" + stem[: tail.start()]  # 맨 앞이 종류인 이름(프로젝트·폴더 없음)도 같은 식으로 센다
    base = name_base2(folder_path).casefold()
    found: list[tuple[str, int]] = []
    for mark in _KIND_MARK.finditer(body):
        kind = mark.group(1)
        head = body[1 : mark.start()].casefold() if mark.start() > 0 else ""
        worker = body[mark.start() + len(kind) + 2 :]
        if worker and (not base or head == base or head.endswith("_" + base)):
            found.append((kind, int(tail.group(1))))
    return found


def parse_v2(name: str, folder_path: str) -> Optional[tuple[str, int]]:
    """v2 이름이면 (종류, 번호) — `…<폴더 마디>_<종류>_<작업자>_<번호>`.

    폴더·작업자·프로젝트 이름에 종류와 같은 글자가 있어도(폴더 `ep/work/c1`, 작업자 `fin`) 폴더 마디가 종류의 자리를 정해 준다.
    읽는 방법이 꼭 하나일 때만 읽는다. 둘 이상이면 가릴 수 없는 이름이다(None — 그런 파일은 미러의 정리 대상이 될 수 없다,
    Codex 설계 검토)."""
    found = _v2_readings(name, folder_path)
    return found[0] if len(found) == 1 else None


def parse_v2_saved(name: str, folder_path: str) -> Optional[tuple[str, int]]:
    """v2 **저장본**(`share`·`fin`) 이름이면 (종류, 번호). 다빈치 파일·작업물은 저장본이 아니다."""
    parsed = parse_v2(name, folder_path)
    return parsed if parsed is not None and parsed[0] in SAVED_KINDS2 else None


def saved_shape(name: str, folder_path: str) -> bool:
    """렌더 폴더의 **저장본 꼴**인가 — 비교·미러가 '우리 파일' 후보로 볼 수 있는 이름(증거는 따로 본다: 대장·각인).
    v2 로 읽히면 그 종류가 정한다(작업자 이름이 `fin` 인 다빈치 파일 `…_davinci_fin_001` 이 §6 꼴로 읽혀 저장본이 되지 않게).
    v2 로 읽는 방법이 둘 이상이면 가릴 수 없는 이름 — 저장본 꼴이 아니다(§6 으로 다시 읽지 않는다).
    v2 로 전혀 안 읽힐 때만 §6 번호 이름(`<폴더 마디>_<share|fin>_<번호>`)."""
    found = _v2_readings(name, folder_path)
    if found:
        return len(found) == 1 and found[0][0] in SAVED_KINDS2
    numbered = parse_numbered(name)
    return numbered is not None and numbered[1] in SAVED_KINDS2


def _line(worker: str) -> str:
    return hashlib.sha1(worker.casefold().encode("utf-8")).hexdigest()[:12]


def _gen_file2(pid: str, key: str) -> str:
    return hashlib.sha1(f"{pid}\n{key}".encode("utf-8")).hexdigest()[:24]


def disk_numbers2(folders: list[Path], project: str, base: str, worker: str) -> list[int]:
    """그 폴더들에 실제로 있는 같은 프로젝트·폴더·작업자의 v2 이름 번호(종류 불문). 없는 폴더는 건너뛰고, 읽지 못하면 RegistryError.
    장부를 잃어도 이미 있는 파일의 번호를 다른 생성물에 주지 않게 한다."""
    prefix = "_".join(part for part in (project, base) if part)
    shape = re.compile(
        "^" + (re.escape(prefix) + "_" if prefix else "") + "(?:" + "|".join(KINDS2) + ")_" + re.escape(worker) + r"_(\d{3,})$",
        re.IGNORECASE,
    )
    found: list[int] = []
    for folder in folders:
        try:
            names = [entry.name for entry in folder.iterdir()]
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise RegistryError(f"대상 폴더를 읽지 못했습니다: {exc}") from exc
        for name in names:
            match = shape.match(_EXT.sub("", name))
            if match:
                found.append(int(match.group(1)))
    return found


_STEM_FIELDS = ("key", "pid", "project", "base", "worker", "ext")


class NameBook2:
    """한 컷 폴더의 v2 장부 — 작업자 줄마다 번호 한 줄, 생성물마다 배정 한 번(종류와 무관). 저장(비교) 한 번 동안 들고 쓴다.

        n.<작업자 줄>.<번호>          이 번호의 주인                    {key, pid, project, base, worker, seq, ext, folder}
        g.<sha1(pid + 열쇠)>          이 생성물(또는 그 별칭)의 배정    같은 내용 + alias
        d.<종류>.<작업자 줄>.<번호>   그 종류의 파일을 우리가 확정했다  {key, name, folder}
        r.<작업자 줄>.<번호>          이 번호는 저 번호로 이어진다      {line, seq, folder}

    열쇠가 둘일 때의 순서(Codex 코드 리뷰 2026-10-13): **적을 때는 `id` 먼저**(같은 DB·서버를 보는 PC 끼리 반드시 겹치는 열쇠라
    거기서 승부가 난다 — 진 쪽은 아무것도 적기 전에 이긴 배정을 따른다), **찾을 때는 `job_id` 먼저**(PC 마다 `id` 가 다른
    경우의 공통 열쇠). PC 마다 `id` 가 다르면 진 PC 의 `g(id)` 가 진 번호를 가리킨 채 남는다 — 그 번호에 `r` 을 적어 이긴
    번호로 **영구히 잇는다**(그 `id` 만 아는 쪽도 같은 번호에 닿는다). 나중에 채워진 `job_id` 가 이미 다른 번호를 갖고 있을
    때도 같다(옛 번호 → `job_id` 의 번호).
    """

    def __init__(self, render_root: Path, folder_path: str) -> None:
        self.base = name_base2(folder_path)
        self.key = folder_key(folder_path)
        folder = safe_join(render_root / SYNC_DIR / NAMES2_DIR, hashlib.sha1(self.key.encode("utf-8")).hexdigest()[:16])
        if folder is None:
            raise RegistryError("이름 장부 경로가 렌더 폴더 밖을 가리킵니다")
        self.dir = folder
        self._owners: dict[tuple[str, int], dict] = {}
        self._gens: dict[str, dict] = {}
        self._done: dict[tuple[str, str, int], dict] = {}
        self._confirmed: dict[tuple[str, str], Optional[dict]] = {}
        self._moved: dict[tuple[str, int], tuple[str, int]] = {}
        self._disk: dict[tuple, int] = {}  # (대상 폴더들, 프로젝트, 작업자) → 거기 이미 있는 가장 큰 번호 — 한 번만 훑는다(allocate)
        self._seen = 0  # 내가 아는 장부 항목 수(읽은 수 + 내가 적은 수) — 항목은 지워지지 않으므로 수가 다르면 남이 적은 것이다
        self.reload()

    # ── 읽기 ──────────────────────────────────────────────────────────────
    def _load(self, entry: str) -> dict:
        try:
            data = json.loads((self.dir / entry).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise RegistryError(f"이름 장부 항목을 읽지 못했습니다({entry}): {exc}") from exc
        if not isinstance(data, dict) or data.get("folder") != self.key:
            raise RegistryError(f"이름 장부 항목이 맞지 않습니다({entry})")
        return data

    def _stem(self, entry: str) -> dict:
        data = self._load(entry)
        seq = data.get("seq")
        if (
            any(not isinstance(data.get(field), str) for field in _STEM_FIELDS) or not data["key"] or not data["worker"]
            or not isinstance(seq, int) or isinstance(seq, bool) or seq < 1
            or data["base"].casefold() != self.base.casefold() or (data["ext"] and not _EXT.fullmatch(data["ext"]))
        ):
            raise RegistryError(f"이름 장부 항목이 맞지 않습니다({entry})")
        return {**{field: data[field] for field in _STEM_FIELDS}, "seq": seq, "line": _line(data["worker"]), "alias": data.get("alias")}

    @staticmethod
    def _same(first: dict, second: dict) -> bool:
        return all(first[field] == second[field] for field in (*_STEM_FIELDS, "seq"))

    def _entries(self) -> list[str]:
        """장부 폴더의 항목 이름들 — 쓰는 중인 임시 파일(`.<uuid>.tmp`)은 뺀다."""
        try:
            return [entry.name for entry in self.dir.iterdir() if not entry.name.startswith(".")]
        except FileNotFoundError:
            return []
        except OSError as exc:
            raise RegistryError(f"이름 장부를 읽지 못했습니다: {exc}") from exc

    def reload(self) -> None:
        entries = self._entries()
        owners: dict[tuple[str, int], dict] = {}
        gens: dict[str, dict] = {}
        done: dict[tuple[str, str, int], dict] = {}
        moved: dict[tuple[str, int], tuple[str, int]] = {}
        for entry in entries:
            parts = entry.split(".")
            if parts[0] == "n" and len(parts) == 3 and parts[2].isdigit():
                item = self._stem(entry)
                if item["line"] != parts[1] or item["seq"] != int(parts[2]):
                    raise RegistryError(f"이름 장부 항목이 맞지 않습니다({entry})")
                owners[(parts[1], int(parts[2]))] = item
            elif parts[0] == "g" and len(parts) == 2 and parts[1]:
                item = self._stem(entry)
                alias = item["alias"] if isinstance(item["alias"], str) and item["alias"] else item["key"]
                if parts[1] != _gen_file2(item["pid"], alias):
                    raise RegistryError(f"이름 장부 항목이 맞지 않습니다({entry})")
                gens[parts[1]] = item
            elif parts[0] == "d" and len(parts) == 4 and parts[1] in KINDS2 and parts[3].isdigit():
                data = self._load(entry)
                if not isinstance(data.get("key"), str) or not isinstance(data.get("name"), str):
                    raise RegistryError(f"이름 장부 항목이 맞지 않습니다({entry})")
                done[(parts[1], parts[2], int(parts[3]))] = {"key": data["key"], "name": data["name"]}
            elif parts[0] == "r" and len(parts) == 3 and parts[2].isdigit():
                data = self._load(entry)
                if not isinstance(data.get("line"), str) or not isinstance(data.get("seq"), int) or isinstance(data.get("seq"), bool):
                    raise RegistryError(f"이름 장부 항목이 맞지 않습니다({entry})")
                moved[(parts[1], int(parts[2]))] = (data["line"], data["seq"])
            elif parts[0] in ("n", "g", "d", "r"):
                raise RegistryError(f"이름 장부 항목이 맞지 않습니다({entry})")
            # 그 밖의 이름은 건너뛴다
        # 서로 맞는지 — g·d 는 같은 (줄, 번호)의 n 과 열쇠·이름 부분이 같아야 한다. 짝 없는 n 은 결번일 뿐이다.
        for item in gens.values():
            owner = owners.get((item["line"], item["seq"]))
            if owner is None or not self._same(owner, item):
                raise RegistryError(f"이름 장부가 서로 어긋납니다({item['worker']} {item['seq']:03d}) — 번호를 새로 주지 않습니다")
        for spot, target in moved.items():  # r 의 양 끝은 있는 번호여야 하고, 따라가다 제자리로 돌아오면 안 된다
            seen = {spot}
            while target in moved and target not in seen:
                seen.add(target)
                target = moved[target]
            if spot not in owners or target not in owners or target in seen:
                raise RegistryError(f"이름 장부가 서로 어긋납니다(이어진 번호 {spot[1]:03d}) — 번호를 새로 주지 않습니다")
        # 확정 표식(d)이 있는 번호 → 그 주인. `g` 만 잃어도(n·d·파일은 남음) 그 생성물의 번호를 다시 찾는 데 쓴다.
        # 같은 생성물에 확정된 번호가 둘이면 어느 것인지 가릴 수 없다 → 되찾지 않는다(None).
        confirmed: dict[tuple[str, str], Optional[dict]] = {}
        for (kind, line, seq), mark in done.items():
            owner = owners.get((line, seq))
            if owner is None or owner["key"] != mark["key"] or self._name(owner, kind) != mark["name"]:
                raise RegistryError(f"이름 장부가 서로 어긋납니다({kind} {seq:03d}) — 번호를 새로 주지 않습니다")
            slot = (owner["pid"], owner["key"])
            confirmed[slot] = owner if confirmed.get(slot, owner) is owner else None
        self._owners, self._gens, self._done, self._confirmed, self._moved = owners, gens, done, confirmed, moved
        self._seen = len(entries)

    @staticmethod
    def _name(item: dict, kind: str) -> str:
        return v2_name(item["project"], item["base"], kind, item["worker"], f"{item['seq']:03d}", item["ext"])

    def _final(self, item: dict) -> dict:
        """그 번호가 다른 번호로 이어져 있으면(`r`) 끝까지 따라간 배정 — 돌고 도는 일은 reload 가 걸러 냈다."""
        spot = (item["line"], item["seq"])
        while spot in self._moved:
            spot = self._moved[spot]
            item = self._owners[spot]
        return item

    def stem_of(self, ident: Ident) -> Optional[dict]:
        """이 생성물의 배정(없으면 None) — 열쇠 후보 가운데 하나라도 맞으면 그것이다(`job_id` 먼저). 읽기만 한다.
        `g` 가 없어도 그 열쇠로 확정된 번호(d 표식)가 하나 남아 있으면 그것이다 — 이미 있는 파일에 새 번호를 주지 않는다."""
        for key in ident.keys:
            item = self._gens.get(_gen_file2(ident.pid, key))
            if item:
                return self._final(item)
        for key in ident.keys:
            item = self._confirmed.get((ident.pid, key))
            if item:
                return self._final(item)
        return None

    def name_of(self, ident: Ident, kind: str) -> Optional[str]:
        """이 생성물의 그 종류 파일 이름(배정이 없으면 None). 읽기만 한다 — 번호를 만들지 않는다."""
        item = self.stem_of(ident)
        return self._name(item, kind) if item else None

    def is_done(self, ident: Ident, kind: str) -> bool:
        """그 종류의 파일을 우리가 확정한 적이 있나 — 파일이 지금 있는지는 부르는 쪽이 본다."""
        item = self.stem_of(ident)
        return bool(item) and (kind, item["line"], item["seq"]) in self._done

    def older_names(self, ident: Ident, kind: str) -> list[str]:
        """같은 생성물이 **예전에 받았던 번호**(지금 번호로 이어진 것, `r`)로 확정해 둔 그 종류 파일의 이름들.
        이미 있는 파일을 알아보는 데만 쓴다 — 번호가 이어진 뒤에 온 PC 가 옛 번호의 저장본을 못 보고 또 저장하지 않게(Codex 코드 리뷰).
        옛 번호의 확정 표식은 **그 옛 이름**의 증거일 뿐이다(지금 이름의 확정 증거로 쓰지 않는다)."""
        item = self.stem_of(ident)
        if not item:
            return []
        final = (item["line"], item["seq"])
        older = [self._owners[spot] for spot in self._moved if (kind, *spot) in self._done]
        return [self._name(old, kind) for old in older if (self._final(old)["line"], self._final(old)["seq"]) == final]

    # ── 쓰기 ──────────────────────────────────────────────────────────────
    def _publish(self, entry: str, payload: dict) -> bool:
        """항목을 만든다. 만들었으면 True, 이미 있었으면 False(v1 과 같은 규칙 — 덮어쓰지 않는다)."""
        target = self.dir / entry
        tmp = self.dir / f".{uuid.uuid4().hex}.tmp"
        try:
            tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            commit_new(tmp, target)
            self._seen += 1
            return True
        except FileExistsError:
            return False
        except OSError as exc:
            # 응답이 끊겼어도 실제로는 만들어졌을 수 있다 — 다시 읽어 같으면 성공. 확인할 수 없으면 멈춘다(다음 번호로 넘어가지 않는다).
            try:
                if json.loads(target.read_text(encoding="utf-8")) == payload:
                    self._seen = -1  # 방금 만든 것인지 전부터 있던 것인지 모른다 — 수를 믿지 않고 다음에 다시 읽는다
                    return True
            except (OSError, ValueError):
                pass
            raise RegistryError(f"이름 장부에 적지 못했습니다: {exc}") from exc
        finally:
            try:
                tmp.unlink(missing_ok=True)
            except OSError:
                pass

    def _payload(self, item: dict, alias: Optional[str] = None) -> dict:
        payload = {**{field: item[field] for field in _STEM_FIELDS}, "seq": item["seq"], "folder": self.key}
        return {**payload, "alias": alias} if alias else payload

    def _settle(self, ident: Ident, item: dict) -> dict:
        """이 PC 가 아는 열쇠 모두가 한 배정을 가리키게 `g` 를 적고, **그 결과로 정해진 배정**을 돌려준다(item 과 다를 수 있다).

        `id` 부터 적는다(클래스 설명). 어느 열쇠를 다른 PC 가 먼저 적었으면 다시 읽어 그 배정을 따르고, 남은 열쇠도 그쪽에
        잇는다 — 내가 쥔 번호는 결번이 된다. 끝으로, 내 열쇠 가운데 **다른 번호를 가리키는 것이 남았으면**(경합에서 진 내 번호 ·
        `job_id` 가 채워지기 전에 받은 옛 번호) 그 번호에 `r` 을 적어 정해진 번호로 잇는다 — 그 열쇠만 아는 쪽이 옛 번호를
        다시 쓰지 않게(Codex 코드 리뷰). 이미 다 적혀 있으면 NAS 에 가지 않는다."""
        for key in reversed(ident.keys):
            name = _gen_file2(ident.pid, key)
            if name in self._gens:
                continue
            if self._publish(f"g.{name}", self._payload(item, None if key == item["key"] else key)):
                self._gens[name] = item
                continue
            self.reload()  # 그 열쇠를 다른 PC 가 먼저 적었다
            if name not in self._gens:
                raise RegistryError("파일 이름을 배정하지 못했습니다")
            item = self.stem_of(ident) or item
        item = self.stem_of(ident) or item
        final = (item["line"], item["seq"])
        for key in ident.keys:
            other = self._gens.get(_gen_file2(ident.pid, key))
            other = self._final(other) if other else None
            spot = (other["line"], other["seq"]) if other else final
            if spot == final:
                continue
            if self._publish(f"r.{spot[0]}.{spot[1]:03d}", {"line": final[0], "seq": final[1], "folder": self.key}):
                self._moved[spot] = final
            else:
                self.reload()  # 다른 PC 가 그 번호를 먼저 이었다 — 그 값을 따른다
        return self.stem_of(ident) or item

    def refresh(self) -> None:
        """내가 읽은 뒤 다른 PC 가 장부에 적었으면 다시 읽는다 — **쓸 이름을 정하기 직전에** 부른다(Codex 코드 리뷰). 읽어 둔 장부는
        그사이 이어진 번호(`r`)·새 배정을 모른다. 폴더 목록 한 번 — 항목은 지워지지 않으므로 수가 같으면 항목은 읽지 않는다."""
        if len(self._entries()) != self._seen:
            self.reload()

    def link(self, ident: Ident) -> None:
        """이미 배정된 생성물을 다시 만났을 때 — 이 PC 가 새로 알게 된 열쇠(나중에 채워진 `job_id` 등)도 같은 배정을 가리키게 한다.
        배정이 없으면 아무것도 하지 않는다(번호를 만들지 않는다)."""
        found = self.stem_of(ident)
        if found:
            self._settle(ident, found)

    def allocate(self, ident: Ident, kind: str, ext: str, dest_dirs: list[Path]) -> str:
        """이 생성물의 그 종류 파일 이름 — 배정이 있으면 그것, 없으면 그 작업자 줄의 다음 번호를 확보한다. **쓰기 직전에만**
        부른다(조회는 name_of). dest_dirs = 그 컷의 파일이 놓이는 실제 폴더들(컷 폴더와 shared/) — 거기 이미 있는 번호는 건너뛴다."""
        if kind not in KINDS2:
            raise ValueError(f"알 수 없는 이름 종류: {kind}")
        if not ident.keys:
            raise RegistryError("생성물 id 가 없습니다")
        self.refresh()  # 읽어 둔 값으로 옛 번호에 저장하지 않는다
        found = self.stem_of(ident)
        if found:
            return self._name(self._settle(ident, found), kind)
        if not ident.named:
            raise RegistryError("이름 재료(프로젝트·작업자 이름)가 없어 새 번호를 받을 수 없습니다")
        project, worker = _fit(ident.project, self.base, ident.worker)
        if ".." in self.base:  # 목적지 검증이 거부할 이름 — 번호를 쥐기 전에 그만둔다(쥐고 나면 그 이름으로 영영 실패한다)
            raise RegistryError("폴더 이름에 '..' 이 있어 파일 이름을 만들 수 없습니다")
        if ext and not _EXT.fullmatch(ext):  # 읽을 때 거부할 확장자를 적으면 그 컷의 장부 전체가 '읽지 못함'이 된다
            raise RegistryError(f"파일 확장자를 쓸 수 없습니다: {ext}")
        line = _line(worker)
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise RegistryError(f"이름 장부 폴더를 만들지 못했습니다: {exc}") from exc
        taken = [seq for (owner_line, seq) in self._owners if owner_line == line]
        # 대상 폴더는 이 장부를 든 동안 작업자 줄마다 한 번만 훑는다 — 까닭과 천장(ponytail)은 NameBook.allocate 와 같다.
        slot = (tuple(dest_dirs), project, worker)
        if slot not in self._disk:
            self._disk[slot] = max(disk_numbers2(dest_dirs, project, self.base, worker), default=0)
        seq = max([*taken, self._disk[slot]])
        for _probe in range(_MAX_PROBES):
            seq += 1
            # 번호의 주인으로 적는 열쇠 = 맨 먼저 겨루는 열쇠(`id`)
            item = {"key": ident.keys[-1], "pid": ident.pid, "project": project, "base": self.base, "worker": worker, "ext": ext,
                    "seq": seq, "line": line, "alias": None}
            if not self._publish(f"n.{line}.{seq:03d}", self._payload(item)):
                self.reload()
                found = self.stem_of(ident)
                if found:
                    return self._name(self._settle(ident, found), kind)  # 다른 PC 가 같은 생성물을 먼저 배정했다
                held = self._owners.get((line, seq))
                if held is None or held["key"] != item["key"] or held["pid"] != item["pid"]:
                    # 다른 생성물이 가져간 번호 — 방금 다시 읽은 그 줄의 마지막 번호 다음으로 건너뛴다
                    seq = max([seq, *(number for (owner_line, number) in self._owners if owner_line == line)])
                    continue
                item = held  # 같은 생성물이 쥔 번호(응답이 끊겼던 내 재시도 등) — 이어서 쓴다
            self._owners[(line, seq)] = item
            return self._name(self._settle(ident, item), kind)  # 졌으면(다른 PC 가 먼저 배정) 이긴 쪽 이름 — 내 번호는 결번
        raise RegistryError("빈 번호를 찾지 못했습니다")

    def mark_done(self, ident: Ident, kind: str) -> None:
        """그 종류의 파일을 방금 우리가 확정했다고 적는다(목적지 이름 바꾸기가 성공한 뒤에만). 이미 적혀 있으면 내용이 같아야 한다."""
        item = self.stem_of(ident)
        if item is None:
            raise RegistryError("배정되지 않은 생성물입니다")
        slot = (kind, item["line"], item["seq"])
        mark = {"key": item["key"], "name": self._name(item, kind)}
        if not self._publish(f"d.{kind}.{item['line']}.{item['seq']:03d}", {**mark, "folder": self.key}):
            written = self._load(f"d.{kind}.{item['line']}.{item['seq']:03d}")
            if written.get("key") != mark["key"] or written.get("name") != mark["name"]:
                raise RegistryError(f"이름 장부가 서로 어긋납니다({kind} {item['seq']:03d})")
        self._done[slot] = mark
