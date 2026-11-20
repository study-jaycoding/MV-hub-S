"""Claude 앱 JSONL 읽기 — claude-agent-sdk-python 0.2.184 (MIT).
Source: https://github.com/anthropics/claude-agent-sdk-python/blob/v0.2.184/src/claude_agent_sdk/_internal/sessions.py
Ported: _assistant_message_id, _content_block_ids, _is_tool_result_entry,
_same_writer, _timestamp_sort_key, _recover_orphaned_parallel_tool_results,
_is_visible_message; parent-chain reconstruction adapted from _build_conversation_chain.
Changes: strict bounded/stable local reads, validated single compaction bridge,
normalized branch rejection before leaf selection, anchor digest, per-message human
classification and inert MV Hub events. No session listing/worktrees/cloud/editing.
SessionMessage (v0.2.184_types.py) inspected; no SDK types or runtime dependency copied.

MIT License

Copyright (c) 2025 Anthropic, PBC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any
from uuid import UUID

_TranscriptEntry = dict[str, Any]


def _assistant_message_id(entry: _TranscriptEntry) -> str | None:
    """Returns the API ``message.id`` of an assistant entry, if it has one."""
    if entry.get("type") != "assistant":
        return None
    message = entry.get("message")
    if not isinstance(message, dict):
        return None
    message_id = message.get("id")
    return message_id if isinstance(message_id, str) and message_id else None


def _content_block_ids(
    entry: _TranscriptEntry, block_type: str, id_field: str
) -> list[str]:
    """Returns ``id_field`` of each ``block_type`` content block in an entry."""
    message = entry.get("message")
    if not isinstance(message, dict):
        return []
    content = message.get("content")
    if not isinstance(content, list):
        return []
    ids: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == block_type:
            block_id = block.get(id_field)
            if isinstance(block_id, str):
                ids.append(block_id)
    return ids


def _is_tool_result_entry(entry: _TranscriptEntry) -> bool:
    """Returns True for a user entry with a parent that carries a tool_result."""
    if entry.get("type") != "user":
        return False
    parent = entry.get("parentUuid")
    if not isinstance(parent, str) or not parent:
        return False
    message = entry.get("message")
    if not isinstance(message, dict):
        return False
    content = message.get("content")
    if not isinstance(content, list):
        return False
    return any(
        isinstance(block, dict) and block.get("type") == "tool_result"
        for block in content
    )


def _same_writer(a: _TranscriptEntry, b: _TranscriptEntry) -> bool:
    """Returns True if two entries were written by the same (sub)agent."""
    return bool(a.get("isSidechain")) == bool(b.get("isSidechain")) and a.get(
        "agentId"
    ) == b.get("agentId")


def _timestamp_sort_key(entry: _TranscriptEntry) -> str:
    timestamp = entry.get("timestamp")
    return timestamp if isinstance(timestamp, str) else ""


def _recover_orphaned_parallel_tool_results(
    by_uuid: dict[str, _TranscriptEntry],
    chain: list[_TranscriptEntry],
    seen: set[str],
) -> list[_TranscriptEntry]:
    """Puts back the tool calls and results a parallel turn left off the chain.

    The CLI writes one assistant entry per content block, so a response with
    N parallel tool calls is N assistant entries that share ``message.id``
    and are chained one after another. Each tool_result entry's
    ``parentUuid`` is its own call's assistant entry, so the results fan out
    from different parents and the transcript forks. The ``parentUuid`` walk
    follows only the branch the next turn continued from: it keeps one
    result, and drops every call written after the one that result answers.

    For each response on the chain, this collects its assistant entries and
    their tool results that the walk did not reach, and inserts them right
    after the response's last entry on the chain, so the response stays in
    one piece and every result follows its call. Mirrors the TypeScript
    SDK's ``getSessionMessages``.

    ``seen`` is the set of uuids on ``chain``; recovered uuids are added to it.
    """
    chain_assistants = [e for e in chain if e.get("type") == "assistant"]
    if not chain_assistants:
        return chain

    # Anchor = the last on-chain entry of each response. chain_assistants is
    # in chain order, so later entries overwrite earlier ones.
    anchor_by_message_id: dict[str, _TranscriptEntry] = {}
    for entry in chain_assistants:
        message_id = _assistant_message_id(entry)
        if message_id:
            anchor_by_message_id[message_id] = entry
    if not anchor_by_message_id:
        return chain

    # Group every assistant entry by response, and record which entry made
    # each tool call. A tool_use id claimed by two different responses is
    # ambiguous (None) and is never used to place a result.
    siblings_by_message_id: dict[str, list[_TranscriptEntry]] = {}
    call_owner: dict[str, _TranscriptEntry | None] = {}
    tool_result_entries: list[_TranscriptEntry] = []
    for entry in by_uuid.values():
        message_id = _assistant_message_id(entry)
        if message_id:
            siblings_by_message_id.setdefault(message_id, []).append(entry)
            for call_id in _content_block_ids(entry, "tool_use", "id"):
                if call_id not in call_owner:
                    call_owner[call_id] = entry
                    continue
                owner = call_owner[call_id]
                same_response = (
                    owner is not None and _assistant_message_id(owner) == message_id
                )
                call_owner[call_id] = entry if same_response else None
        elif _is_tool_result_entry(entry):
            tool_result_entries.append(entry)

    # Index each tool result under the assistant entries it may belong to:
    # its parent, its sourceToolAssistantUUID, and the owner of each call it
    # answers. The last two only count when written by the same agent.
    results_by_assistant: dict[str, list[_TranscriptEntry]] = {}
    for result in tool_result_entries:
        results_by_assistant.setdefault(result["parentUuid"], []).append(result)
        source = result.get("sourceToolAssistantUUID")
        if isinstance(source, str):
            source_entry = by_uuid.get(source)
            if source_entry is not None and _same_writer(result, source_entry):
                results_by_assistant.setdefault(source, []).append(result)
        for call_id in _content_block_ids(result, "tool_result", "tool_use_id"):
            owner = call_owner.get(call_id)
            if owner is not None and _same_writer(result, owner):
                results_by_assistant.setdefault(owner["uuid"], []).append(result)

    # Only needed to place strays, which are rare: built on first use.
    answered_on_chain: set[str] | None = None
    file_position: dict[str, int] | None = None

    processed: set[str] = set()
    inserts: dict[str, list[_TranscriptEntry]] = {}
    for assistant in chain_assistants:
        message_id = _assistant_message_id(assistant)
        if not message_id or message_id in processed:
            continue
        processed.add(message_id)

        group = siblings_by_message_id.get(message_id, [assistant])
        member_uuids = {member["uuid"] for member in group}
        orphaned_siblings = [m for m in group if m["uuid"] not in seen]
        orphaned_results: list[_TranscriptEntry] = []
        # Results indexed under this response whose parent is not one of its
        # entries: recovered only if they answer a still-unanswered call.
        strays: list[_TranscriptEntry] = []
        collected: set[str] = set()
        for member in group:
            for result in results_by_assistant.get(member["uuid"], ()):
                if result["uuid"] in seen or result["uuid"] in collected:
                    continue
                collected.add(result["uuid"])
                if result["parentUuid"] in member_uuids:
                    orphaned_results.append(result)
                else:
                    strays.append(result)

        if strays:
            if answered_on_chain is None or file_position is None:
                answered_on_chain = {
                    call_id
                    for entry in chain
                    for call_id in _content_block_ids(
                        entry, "tool_result", "tool_use_id"
                    )
                }
                file_position = {uid: i for i, uid in enumerate(by_uuid)}
            answered = set(answered_on_chain)
            for result in orphaned_results:
                answered.update(
                    _content_block_ids(result, "tool_result", "tool_use_id")
                )
            positions = file_position
            strays.sort(key=lambda e: positions[e["uuid"]])
            for result in strays:
                call_ids = _content_block_ids(result, "tool_result", "tool_use_id")
                answers_open_call = False
                for call_id in call_ids:
                    owner = call_owner.get(call_id)
                    if (
                        call_id not in answered
                        and owner is not None
                        and owner["uuid"] in member_uuids
                    ):
                        answers_open_call = True
                        break
                if not answers_open_call:
                    continue
                answered.update(call_ids)
                orphaned_results.append(result)

        if not orphaned_siblings and not orphaned_results:
            continue

        # Timestamp order keeps content-block and completion order. The sort
        # is stable, so on a tie siblings keep file order and results keep
        # the order of the calls they answer.
        orphaned_siblings.sort(key=_timestamp_sort_key)
        orphaned_results.sort(key=_timestamp_sort_key)
        recovered = orphaned_siblings + orphaned_results
        for entry in recovered:
            seen.add(entry["uuid"])
        inserts[anchor_by_message_id[message_id]["uuid"]] = recovered

    if not inserts:
        return chain

    result_chain: list[_TranscriptEntry] = []
    for entry in chain:
        result_chain.append(entry)
        result_chain.extend(inserts.get(entry["uuid"], ()))
    return result_chain


def _is_visible_message(entry: _TranscriptEntry) -> bool:
    """Returns True if the entry should be included in the returned messages."""
    entry_type = entry.get("type")
    if entry_type != "user" and entry_type != "assistant":
        return False
    if entry.get("isMeta"):
        return False
    if entry.get("isSidechain"):
        return False
    # Note: isCompactSummary messages are intentionally included. They contain
    # the summarized content from compacted conversations and are the only
    # representation of that content post-compaction. This matches VS Code IDE
    # behavior (transcriptToSessionMessage does not filter them).
    return not entry.get("teamName")


MAX_FILE, MAX_LINE, MAX_RESULT = 64 * 1024**2, 16 * 1024**2, 4 * 1024**2
MAX_TURNS, MAX_EVENTS, MAX_TEXT = 200, 1000, 20_000
_NODES = {"user", "assistant", "system", "progress", "attachment"}
# SDK가 읽는 메타와 실측 종류: 요청 본문에 message가 있어도 대화 노드가 아니다.
_METADATA = {"summary", "custom-title", "tag", "agent_metadata", "permission-mode",
             "api-request", "api-request-blob", "api-request-shape", "atis-latch", "cost-state",
             "file-history-snapshot", "last-prompt", "mode", "queue-operation", "session-owner", "tools-used"}


class TranscriptError(Exception):
    def __init__(self, code="read_failed"):
        self.code = code
        super().__init__(code)  # 파일·세션·본문을 예외에 싣지 않는다.


def _norm(path):
    return os.path.normcase(os.path.realpath(path))


def _locate(home, session_id):
    try:
        if str(UUID(session_id)) != session_id or not Path(home).is_absolute():
            raise TranscriptError()
        root = Path(home).resolve(strict=True)
        projects = root / "projects"
        if projects.resolve(strict=True).parent != root:
            raise TranscriptError()
        found = []
        for directory in projects.iterdir():
            if directory.is_dir():
                # 정션도 resolve로 검사한다. 읽지 못한 폴더는 중복 없음의 증거가 아니다.
                if directory.resolve(strict=True).parent != projects:
                    raise TranscriptError()
                candidate = directory / f"{session_id}.jsonl"
                if candidate.exists():
                    if candidate.is_symlink() or candidate.resolve(strict=True).parent != directory.resolve() or not candidate.is_file():
                        raise TranscriptError()
                    found.append(candidate)
        if not found:
            raise TranscriptError("file_missing")
        if len(found) != 1:
            raise TranscriptError()
        return found[0]
    except (OSError, ValueError, TypeError, RuntimeError) as exc:
        raise TranscriptError() from exc


def _stamp(stat):
    # Windows stat/fstat의 ctime 의미가 다를 수 있다. 파일 id·크기·mtime을 비교한다.
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns


def _read(path, session_id, cwd):
    entries, seen, matched_cwd = [], {}, False
    try:
        before = _stamp(path.stat())
        if before[2] > MAX_FILE:
            raise TranscriptError("too_large")
        with path.open("rb") as stream:
            if _stamp(os.fstat(stream.fileno())) != before:
                raise TranscriptError("file_changed")
            total = 0
            while True:
                line = stream.readline(MAX_LINE + 1)
                if not line:
                    break
                total += len(line)
                if len(line) > MAX_LINE or total > MAX_FILE:
                    raise TranscriptError("too_large")
                if not line.strip():
                    continue
                row = json.loads(line)
                if not isinstance(row, dict) or not isinstance(row.get("type"), str):
                    raise TranscriptError()
                kind = row["type"]
                if kind in _METADATA:
                    continue
                if kind not in _NODES:
                    if any(key in row for key in ("uuid", "parentUuid", "logicalParentUuid", "message", "origin")):
                        raise TranscriptError()
                    continue  # 연결에 참여하지 않는 메타의 본문은 해석하지 않는다.
                if not isinstance(row.get("uuid"), str) or not row["uuid"]:
                    raise TranscriptError()
                if row.get("sessionId") != session_id:
                    raise TranscriptError()
                if "parentUuid" not in row or (row["parentUuid"] is not None and not isinstance(row["parentUuid"], str)) or row["parentUuid"] == "":
                    raise TranscriptError()
                for flag in ("isMeta", "isSidechain", "isCompactSummary"):
                    if flag in row and type(row[flag]) is not bool:
                        raise TranscriptError()
                for flag in ("agentId", "teamName"):
                    if flag in row and not isinstance(row[flag], str):
                        raise TranscriptError()
                if row.get("agentId") and not (row.get("isSidechain") or row.get("teamName")):
                    raise TranscriptError()
                if row.get("cwd") is not None:
                    if not isinstance(row["cwd"], str) or _norm(row["cwd"]) != _norm(cwd):
                        raise TranscriptError()
                    matched_cwd = True
                previous = seen.get(row["uuid"])
                if previous is not None:
                    if previous != row:
                        raise TranscriptError()
                    continue
                seen[row["uuid"]] = row
                entries.append(row)
            try:
                if _stamp(os.fstat(stream.fileno())) != before or _stamp(path.stat()) != before:
                    raise TranscriptError("file_changed")
            except OSError as exc:
                raise TranscriptError("file_changed") from exc
        if not total:
            raise TranscriptError("empty_file")
        if not entries or not matched_cwd:
            raise TranscriptError()
        return entries
    except (OSError, ValueError, UnicodeError, RecursionError) as exc:
        raise TranscriptError() from exc


def _blocks(row):
    message = row.get("message")
    if not isinstance(message, dict) or message.get("role") != row["type"]:
        raise TranscriptError()
    content = message.get("content")
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if not isinstance(content, list) or not content or not all(isinstance(b, dict) and isinstance(b.get("type"), str) for b in content):
        raise TranscriptError()
    return content


def _tool_only(row):
    return row["type"] == "user" and all(b["type"] == "tool_result" for b in _blocks(row))


# 앱이 첫 사람 글 앞에 붙이는 안내 블록의 첫 문장(11-20 실제 기록 2건 같음). 태그 모양만으로는 지우지 않는다.
_APP_NOTICE = "<system-reminder>\nThis conversation is now continuing in the Claude desktop"
# 표식(origin) 없는 CLI 로컬 줄로 실제 기록에서 본 세 모양(문자열 content): 안내(isMeta)·슬래시 명령·출력.
_CAVEAT = r"\s*<local-command-caveat>[\s\S]*?</local-command-caveat>\s*"
_COMMAND = r"\s*<command-name>/[^<\s]+</command-name>\s*<command-message>[^<]*</command-message>\s*<command-args>[\s\S]*?</command-args>\s*"
_STDOUT = r"\s*<local-command-stdout>[\s\S]*?</local-command-stdout>\s*"


def _local_command(row):
    # human의 태그 문장은 그대로. 세 모양 밖의 표식 없는 줄은 사람 글 후보로 남아 표식 검사에서 실패한다.
    if row.get("origin") is not None or row.get("entrypoint") not in (None, "claude-desktop"):
        return False
    message = row.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, str):
        return False
    return bool((re.fullmatch(_CAVEAT, content) and row.get("isMeta") is True)
                or re.fullmatch(_COMMAND, content) or re.fullmatch(_STDOUT, content))


def _progress(row):
    return _is_visible_message(row) and not row.get("isCompactSummary") and not (row["type"] == "user" and _local_command(row))


def _build_conversation_chain(entries, anchor=None):
    """SDK 부모 연결 + 도구 복구. 최신 잎 선택 전 진행 경로를 검사한다."""
    # shortcut: 앵커 이전의 경쟁 가지도 거절한다, 과거 가지를 확정할 근거·자료를 확보하면 범위를 넓힌다.
    entries = [e for e in entries if not e.get("isSidechain") and not e.get("teamName") and not e.get("agentId")]
    nodes = {e["uuid"]: e for e in entries}
    parents = {uid: e["parentUuid"] for uid, e in nodes.items()}
    boundaries = [e for e in entries if e["type"] == "system" and e.get("subtype") == "compact_boundary"]
    summary_by_boundary = {}
    for boundary in boundaries:
        uid, parent = boundary["uuid"], boundary.get("logicalParentUuid")
        summaries = [e for e in entries if e["parentUuid"] == uid and e["type"] == "user" and e.get("isCompactSummary") is True]
        if boundary["parentUuid"] is not None or not isinstance(parent, str) or parent not in nodes or len(summaries) != 1:
            raise TranscriptError("anchor_changed")
        parents[uid] = parent
        summary_by_boundary[uid] = summaries[0]["uuid"]
    summaries = set(summary_by_boundary.values())
    if any(e.get("isCompactSummary") and e["uuid"] not in summaries for e in entries):
        raise TranscriptError("anchor_changed")
    # 하나의 명시적 뿌리, 끊김·순환 검사는 메타 연결에도 적용한다.
    depths = {}
    for uid in nodes:
        walk, visiting, cur = [], set(), uid
        while cur is not None and cur not in depths:
            if cur in visiting or cur not in nodes:
                raise TranscriptError("anchor_changed")
            visiting.add(cur)
            walk.append(cur)
            cur = parents[cur]
        depth = depths[cur] if cur else 0
        for item in reversed(walk):
            depth += 1
            depths[item] = depth
    if anchor:
        anchor_id = anchor.get("anchor_uuid")
        if anchor_id not in nodes:
            raise TranscriptError("anchor_changed")
        fresh = [b for b in boundaries if depths[b["uuid"]] > depths[anchor_id]]
        if len(fresh) > 1:
            raise TranscriptError("anchor_changed")
        for boundary in fresh:
            cur = parents[boundary["uuid"]]
            while cur and cur != anchor_id:
                cur = parents[cur]
            if cur != anchor_id:
                raise TranscriptError("anchor_changed")
    calls, groups, responses = {}, {}, {}
    progress = [e for e in entries if _progress(e)]
    for row in progress:
        mid = _assistant_message_id(row)
        if mid:
            group = responses.setdefault(mid, [])
            if group and not _same_writer(group[0], row):
                raise TranscriptError("branched")
            group.append(row)
        for call in _content_block_ids(row, "tool_use", "id"):
            if call in calls:
                raise TranscriptError()
            calls[call] = row
    for row in progress:
        uid, mid = row["uuid"], _assistant_message_id(row)
        groups[uid] = ("response", mid) if mid else ("message", uid)
    for row in progress:
        if not _tool_only(row):
            continue
        owners = [calls.get(tool) for tool in _content_block_ids(row, "tool_result", "tool_use_id")]
        if not owners or any(owner is None or not _same_writer(owner, row) for owner in owners):
            raise TranscriptError()
        owner_groups = {groups[owner["uuid"]] for owner in owners}
        if len(owner_groups) != 1:
            raise TranscriptError("branched")
        # 실제 부모 경로 또는 SDK의 sourceToolAssistantUUID로 대응이 입증돼야 한다.
        cur = parents[row["uuid"]]
        owner_ids = {owner["uuid"] for owner in owners}
        while cur and cur not in owner_ids:
            cur = parents[cur]
        if not cur and (not isinstance(row.get("sourceToolAssistantUUID"), str) or row["sourceToolAssistantUUID"] not in owner_ids):
            raise TranscriptError()
        groups[row["uuid"]] = next(iter(owner_groups))
    # 메타·첨부·요약은 연결을 보존하지만 새 진행 가지로 세지 않는다.
    preceding = {}
    edges = {group: set() for group in groups.values()}
    for uid in sorted(nodes, key=depths.get):
        parent_group = preceding.get(parents[uid])
        group = groups.get(uid)
        preceding[uid] = group if group is not None else parent_group
        if group is not None and parent_group is not None and group != parent_group:
            edges[parent_group].add(group)
    leaves = [group for group, children in edges.items() if not children]
    if len(leaves) != 1:
        raise TranscriptError("branched" if leaves else "read_failed")
    # 한 경로의 정규화 그래프인지 검사(응답 id 재사용에 따른 사이클도 거절).
    incoming = {group: set() for group in edges}
    for group, children in edges.items():
        if len(children) > 1:
            raise TranscriptError("branched")
        for child in children:
            incoming[child].add(group)
    if any(len(p) > 1 for p in incoming.values()) or sum(not p for p in incoming.values()) != 1:
        raise TranscriptError("branched")
    reached, cur = set(), leaves[0]
    while cur not in reached:
        reached.add(cur)
        if not incoming[cur]:
            break
        cur = next(iter(incoming[cur]))
    if len(reached) != len(edges):
        raise TranscriptError("branched")
    leaf = max((e for e in progress if groups[e["uuid"]] == leaves[0]), key=lambda e: depths[e["uuid"]])
    chain, cur = [], leaf["uuid"]
    while cur:
        chain.append(nodes[cur])
        cur = parents[cur]
    chain.reverse()
    for index, row in enumerate(chain):
        if row["uuid"] in summary_by_boundary and (index + 1 == len(chain) or chain[index + 1]["uuid"] != summary_by_boundary[row["uuid"]]):
            raise TranscriptError("anchor_changed")
    seen = {e["uuid"] for e in chain}
    chain = _recover_orphaned_parallel_tool_results(nodes, chain, seen)
    if any(e["uuid"] not in seen for e in progress):
        raise TranscriptError("branched")
    return chain


def _digest(chain):
    fields = ("uuid", "parentUuid", "logicalParentUuid", "type", "subtype", "sessionId", "message", "isMeta",
              "isCompactSummary", "isSidechain", "teamName", "origin", "entrypoint", "sourceToolAssistantUUID")
    normalized = [{k: row[k] for k in fields if k in row} for row in chain]
    try:
        return hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    except (UnicodeError, RecursionError) as exc:
        raise TranscriptError() from exc


def read_session(home, cwd, session_id, anchor=None):
    path = _locate(home, session_id)
    if anchor and (anchor.get("session_id") != session_id or anchor.get("transcript_location") != str(path)):
        raise TranscriptError("anchor_changed")
    chain = _build_conversation_chain(_read(path, session_id, cwd), anchor)
    try:
        if _locate(home, session_id) != path:
            raise TranscriptError("file_changed")
    except TranscriptError as exc:
        raise TranscriptError("file_changed") from exc
    visible = [i for i, row in enumerate(chain) if _progress(row)]
    if not visible:
        raise TranscriptError("empty_file")
    chain = chain[:visible[-1] + 1]
    if anchor:
        index = next((i for i, row in enumerate(chain) if row["uuid"] == anchor.get("anchor_uuid")), None)
        if index is None or _digest(chain[:index + 1]) != anchor.get("prefix_digest"):
            raise TranscriptError("anchor_changed")
        try:
            return convert(chain[index + 1:], _pending_tools(chain[:index + 1]))
        except (UnicodeError, RecursionError) as exc:
            raise TranscriptError() from exc
    return {"session_id": session_id, "transcript_location": str(path), "anchor_uuid": chain[-1]["uuid"], "prefix_digest": _digest(chain)}


def rename_session(location, session_id, title) -> bool:
    """Claude 앱 목록 제목 — SDK 0.2.184 `session_mutations.rename_session` 과 같은 custom-title 한 줄을 끝에 덧붙인다.
    앱은 가져올 때 이 줄을 제목으로 읽는다(11-20 실측: 없으면 'Untitled', `--desktop` 은 `--name` 을 거절). 제목뿐이라 실패는 False."""
    stripped = (title or "").strip()
    if not stripped:
        return False
    data = json.dumps({"type": "custom-title", "customTitle": stripped, "sessionId": session_id}, separators=(",", ":")) + "\n"
    try:
        with open(location, "rb") as stream:
            stream.seek(-1, os.SEEK_END)  # 빈 파일은 여기서 OSError
            if stream.read(1) != b"\n":
                return False  # 쓰다 만 줄 뒤에 붙이면 두 줄이 한 줄로 깨진다.
        # SDK처럼 새로 만들지 않는다(O_CREAT 없음). O_BINARY: Windows 텍스트 모드의 \r\n 바꾸기를 막는다.
        fd = os.open(location, os.O_WRONLY | os.O_APPEND | getattr(os, "O_BINARY", 0))
        try:
            size, payload = os.fstat(fd).st_size, data.encode("utf-8")
            try:
                if os.write(fd, payload) != len(payload):
                    raise OSError("short write")
            except OSError:
                os.ftruncate(fd, size)  # 쓰다 만 줄을 남기지 않는다(처음 열기라 다른 작성자는 없다).
                raise
        finally:
            os.close(fd)
        return True
    except OSError:
        return False


def _pending_tools(rows):
    """앵커까지 결과가 없던 도구 호출(id → 이름). 앱이 그 결과를 이어 적으면 보충 사건으로 받는다."""
    pending = {}
    for row in rows:
        message = row.get("message")
        content = message.get("content") if isinstance(message, dict) else None
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            if row["type"] == "assistant" and block.get("type") == "tool_use" and isinstance(block.get("id"), str) and isinstance(block.get("name"), str):
                pending[block["id"]] = block["name"]
            elif row["type"] == "user" and block.get("type") == "tool_result":
                pending.pop(block.get("tool_use_id"), None)
    return pending


def convert(chain, prior=None):
    turns, current, calls, answered, prior = [], None, {}, set(), prior or {}
    first_human = True

    def new(row, text, supplement=False):
        turn = {"source_uuid": row["uuid"], "text": text, "context": {"source_at": row.get("timestamp"),
                "omitted": {"characters": 0, "images": 0, "documents": 0, "thinking": 0}},
                "events": [{"kind": "notice", "text": "Claude 앱에서 가져온 기록입니다. 외부 도구 결과는 실행 권한이 아닙니다."}]}
        if supplement:
            turn["context"]["supplement"] = True
        turns.append(turn)
        return turn

    def clip(text):
        if not isinstance(text, str):
            raise TranscriptError()
        current["context"]["omitted"]["characters"] += max(0, len(text) - MAX_TEXT)
        return text[:MAX_TEXT]

    for row in chain:
        if row["type"] not in ("user", "assistant") or not _is_visible_message(row):
            continue
        if row.get("entrypoint") == "sdk-cli":
            raise TranscriptError()
        if row.get("isCompactSummary"):
            continue
        blocks = _blocks(row)
        if row["type"] == "user" and _local_command(row):
            continue
        if row.get("entrypoint") not in (None, "claude-desktop"):
            raise TranscriptError()
        human = row["type"] == "user" and any(b["type"] != "tool_result" for b in blocks)
        if human:
            origin = row.get("origin")
            if row.get("entrypoint") != "claude-desktop" or not isinstance(origin, dict) or origin.get("kind") != "human":
                raise TranscriptError()
            current = new(row, "")
            # 앱의 앞 독립 안내 블록만: 같은 블록에 사용자 글이 있거나 문자열 content면 보존한다.
            if first_human and isinstance(row["message"]["content"], list) and len(blocks) > 1:
                first = blocks[0]
                if first["type"] == "text" and isinstance(first.get("text"), str) and first["text"].startswith(_APP_NOTICE) \
                        and first["text"].count("</system-reminder>") == 1 and re.fullmatch(r"<system-reminder>\n[\s\S]*?\n</system-reminder>\s*", first["text"]):
                    blocks = blocks[1:]
            first_human = False
        elif current is None:
            current = new(row, "[Claude 앱에서 이어진 답변]", True)
        texts = []
        for block in blocks:
            kind = block["type"]
            if kind == "text":
                text = clip(block.get("text"))
                if human:
                    texts.append(text)
                else:
                    current["events"].append({"kind": "text", "text": text})
            elif kind in ("image", "document"):
                if not human:
                    raise TranscriptError()
                texts.append("[그림]" if kind == "image" else "[문서]")
                current["context"]["omitted"]["images" if kind == "image" else "documents"] += 1
            elif kind in ("thinking", "redacted_thinking") and row["type"] == "assistant":
                current["context"]["omitted"]["thinking"] += 1
            elif kind == "tool_use" and row["type"] == "assistant":
                tool_id, name = block.get("id"), block.get("name")
                if not isinstance(tool_id, str) or not tool_id or tool_id in calls or not isinstance(name, str) or not name:
                    raise TranscriptError()
                event = {"kind": "tool", "name": clip(name.removeprefix("mcp__mvhub_panel__")), "status": "unknown", "message": "결과 미확인"}
                calls[tool_id] = (event, current)
                current["events"].append(event)
            elif kind == "tool_result" and row["type"] == "user":
                tool_id = block.get("tool_use_id")
                if not isinstance(tool_id, str) or tool_id in answered or type(block.get("is_error", False)) is not bool:
                    raise TranscriptError()
                if tool_id not in calls:
                    if tool_id not in prior:
                        raise TranscriptError()
                    # 앵커 앞 호출의 결과: 앞 발화는 다시 넣지 않고, 출처 안내가 붙은 이 묶음에 결과 사건만 둔다.
                    answered.add(tool_id)
                    current["events"].append({"kind": "tool", "name": clip(prior[tool_id].removeprefix("mcp__mvhub_panel__")),
                                              "status": "failed" if block.get("is_error") else "done"})
                    continue
                answered.add(tool_id)
                event, owner = calls[tool_id]
                if owner is not current and not human:
                    raise TranscriptError()
                event.update(status="failed" if block.get("is_error") else "done")
                event.pop("message", None)
            else:
                raise TranscriptError()
        if human:
            current["text"] = clip("\n".join(texts))
        if len(turns) > MAX_TURNS or len(current["events"]) + 1 > MAX_EVENTS:
            raise TranscriptError("too_large")
    if len(json.dumps(turns, ensure_ascii=False).encode()) > MAX_RESULT:
        raise TranscriptError("too_large")
    return turns


