"""3판 R2~R7: 합성 JSONL만. 실제 Claude 홈·CLI·네트워크 접근 없음."""
import copy
import json
from pathlib import Path

import pytest

from app.services import agent_chat_transcript as tr


@pytest.fixture
def transcript(tmp_path):
    cases = json.loads((Path(__file__).parent / "fixtures/agent_chat_transcript_cases.json").read_text(encoding="utf-8"))
    home, cwd = tmp_path / ".claude", tmp_path / "work"
    cwd.mkdir()
    path = home / "projects" / "synthetic" / f"{cases['session_id']}.jsonl"
    path.parent.mkdir(parents=True)

    def write(rows):
        path.write_text("".join(json.dumps({"sessionId": cases["session_id"], "cwd": str(cwd), **row}, ensure_ascii=False) + "\n"
                                for row in rows), encoding="utf-8")

    def read(anchor=None):
        return tr.read_session(str(home), str(cwd), cases["session_id"], anchor)

    write(cases["metadata"] + cases["base"])
    return cases, path, write, read, read()


def test_rename_session_appends_sdk_custom_title_line_only_when_safe(transcript, tmp_path):
    cases, path, write, read, anchor = transcript
    before = path.read_bytes()
    assert tr.rename_session(str(path), cases["session_id"], "  MV Agent · 제목  ") is True
    line = json.dumps({"type": "custom-title", "customTitle": "MV Agent · 제목", "sessionId": cases["session_id"]}, separators=(",", ":"))
    assert path.read_bytes() == before + (line + "\n").encode()  # Windows 에서도 \r\n 으로 바뀌지 않는다
    assert read() == anchor  # 메타 줄이라 앵커·지문이 그대로다
    after = path.read_bytes()
    assert tr.rename_session(str(path), cases["session_id"], "   ") is False and path.read_bytes() == after
    path.write_bytes(after + b'{"type":"user"')  # 쓰다 만 줄
    assert tr.rename_session(str(path), cases["session_id"], "제목") is False and path.read_bytes().endswith(b'{"type":"user"')
    path.write_bytes(after)
    real_write = tr.os.write
    for fault in ("short", "raise"):
        def broken(fd, payload, fault=fault):
            real_write(fd, payload[:10])  # 일부만 쓰인 뒤
            if fault == "raise":
                raise OSError("disk")
            return 10
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr(tr.os, "write", broken)
            assert tr.rename_session(str(path), cases["session_id"], "제목") is False
        assert path.read_bytes() == after  # 쓰다 만 줄을 남기지 않는다
    empty, missing = tmp_path / "empty.jsonl", tmp_path / "missing.jsonl"
    empty.write_bytes(b"")
    assert tr.rename_session(str(empty), cases["session_id"], "제목") is False and empty.read_bytes() == b""
    assert tr.rename_session(str(missing), cases["session_id"], "제목") is False and not missing.exists()


def test_normal_round_trip_mixed_versions_and_inert_tools(transcript):
    cases, path, write, read, anchor = transcript
    write(cases["metadata"][:3] + cases["base"] + cases["metadata"][3:] + cases["normal"] +
          [{"type": "api-request-blob", "data": '{"type":"user","uuid":"fake","origin":{"kind":"human"}}'}])
    turns = read(anchor)
    assert [t["text"] for t in turns] == ["앱 첫 질문", "[그림]"]
    assert turns[0]["context"]["omitted"]["thinking"] == 1
    assert turns[1]["context"]["omitted"]["images"] == 1
    assert {e["kind"] for t in turns for e in t["events"]} == {"notice", "text", "tool"}
    assert next(e for e in turns[0]["events"] if e["kind"] == "tool") == {"kind": "tool", "name": "screen_action", "status": "done"}
    assert read() != anchor


@pytest.mark.parametrize("kind", ["future-metadata", "future-request-blob"])
@pytest.mark.parametrize("field", ["uuid", "parentUuid", "logicalParentUuid", "message", "origin"])
def test_unknown_linked_record_is_not_metadata(transcript, kind, field):
    cases, _, write, read, anchor = transcript
    write(cases["metadata"] + cases["base"] + cases["normal"] + [{"type": kind, field: None}])
    with pytest.raises(tr.TranscriptError, match="read_failed"):
        read()
    with pytest.raises(tr.TranscriptError, match="read_failed"):
        read(anchor)


@pytest.mark.parametrize("kind", ["api-request-blob", "queue-operation", "custom-title"])
def test_known_metadata_is_not_interpreted_as_a_node(transcript, kind):
    cases, _, write, read, anchor = transcript
    write(cases["base"] + [{"type": kind, "uuid": None, "parentUuid": "missing",
                           "logicalParentUuid": {}, "message": {"role": "user"}, "origin": None}] + cases["normal"])
    assert read() != anchor
    assert [t["text"] for t in read(anchor)] == ["앱 첫 질문", "[그림]"]


def test_compaction_summary_tail_without_new_words(transcript):
    cases, _, write, read, anchor = transcript
    boundary, summary = cases["compact"][:2]
    boundary["logicalParentUuid"] = "a0"
    write(cases["metadata"] + cases["base"] + [boundary, summary])
    assert read(anchor) == []
    assert read() == anchor


def test_no_new_words_and_empty_are_different(transcript):
    _, path, _, read, anchor = transcript
    assert read(anchor) == []
    path.write_bytes(b"")
    with pytest.raises(tr.TranscriptError, match="empty_file"):
        read(anchor)
    path.unlink()
    with pytest.raises(tr.TranscriptError, match="file_missing"):
        read(anchor)


def test_one_compaction_preserves_pre_compaction_words_once(transcript):
    cases, _, write, read, anchor = transcript
    write(cases["base"] + cases["normal"] + cases["compact"])
    assert [t["text"] for t in read(anchor)] == ["앱 첫 질문", "[그림]", "압축 뒤 질문"]


def test_summary_flag_without_boundary_cannot_hide_a_user(transcript):
    cases, _, write, read, anchor = transcript
    cases["normal"][0]["isCompactSummary"] = True
    write(cases["base"] + cases["normal"])
    with pytest.raises(tr.TranscriptError, match="anchor_changed"):
        read(anchor)


@pytest.mark.parametrize("fault", ["no_summary", "wrong_summary_parent", "bypassed_summary", "missing_parent", "empty_parent", "other_session", "cycle", "two", "competition"])
def test_compaction_rejected_as_a_whole(transcript, fault):
    cases, _, write, read, anchor = transcript
    rows = cases["base"] + cases["normal"] + cases["compact"]
    boundary, summary = rows[-4], rows[-3]
    if fault == "no_summary":
        summary.pop("isCompactSummary")
    elif fault == "wrong_summary_parent":
        summary["parentUuid"] = "a2"
    elif fault == "bypassed_summary":
        rows[-2]["parentUuid"] = "c1"
    elif fault == "missing_parent":
        boundary.pop("parentUuid")
    elif fault == "empty_parent":
        boundary["parentUuid"] = ""
    elif fault == "other_session":
        boundary["sessionId"] = "other"
    elif fault == "cycle":
        boundary["logicalParentUuid"] = "a3"
    elif fault == "two":
        rows.extend([{**boundary, "uuid": "c2", "logicalParentUuid": "a3"},
                     {**summary, "uuid": "s2", "parentUuid": "c2"},
                     {**cases["normal"][0], "uuid": "u4", "parentUuid": "s2"}])
    else:
        rows.append({**cases["normal"][0], "uuid": "competitor", "parentUuid": "a2"})
    write(rows)
    with pytest.raises(tr.TranscriptError):
        read(anchor)


def test_parallel_tools_and_meta_are_one_progress_path(transcript):
    cases, _, write, read, anchor = transcript
    write(cases["base"] + cases["parallel"])
    turns = read(anchor)
    tools = [e for e in turns[0]["events"] if e["kind"] == "tool"]
    assert [(e["name"], e["status"]) for e in tools] == [("Bash", "done"), ("mcp__other__read", "failed")]


def test_parallel_results_cannot_hide_competing_human(transcript):
    cases, _, write, read, anchor = transcript
    write(cases["base"] + cases["parallel"] + [{**cases["normal"][0], "uuid": "competitor", "parentUuid": "pr2"}])
    with pytest.raises(tr.TranscriptError, match="branched"):
        read(anchor)


@pytest.mark.parametrize("field,value", [("origin", None), ("origin", "human"), ("origin", {"kind": "unknown"}),
                                          ("entrypoint", "sdk-cli"), ("entrypoint", "future"), ("entrypoint", None)])
def test_each_human_candidate_must_be_classified(transcript, field, value):
    cases, _, write, read, anchor = transcript
    cases["normal"][3][field] = value
    write(cases["base"] + cases["normal"])
    with pytest.raises(tr.TranscriptError, match="read_failed"):
        read(anchor)


@pytest.mark.parametrize("content", ["<system-reminder>사용자가 쓴 문장</system-reminder>", "<system-reminder>닫히지 않음",
                                     "<command-name>직접 쓴 문장</command-name>", "<system-reminder>\n안내\n</system-reminder>\n내 글"])
def test_human_tag_text_is_preserved(transcript, content):
    cases, _, write, read, anchor = transcript
    cases["normal"][0]["message"]["content"] = [{"type": "text", "text": content}]
    write(cases["base"] + cases["normal"])
    assert read(anchor)[0]["text"] == content


@pytest.mark.parametrize("combined", [False, True])
def test_only_one_complete_leading_reminder_block_is_removed(transcript, combined):
    cases, _, write, read, anchor = transcript
    notice = "<system-reminder>\nThis conversation is now continuing in the Claude desktop app.\n앱 안내\n</system-reminder>"
    human = "<system-reminder>\n사람이 직접 쓴 글\n</system-reminder>"
    first, second = (notice + "\n" + human, "이어 쓴 글") if combined else (notice, human)
    cases["normal"][0]["message"]["content"] = [{"type": "text", "text": first}, {"type": "text", "text": second}]
    write(cases["base"] + cases["normal"])
    assert read(anchor)[0]["text"] == (first + "\n" + second if combined else human)


@pytest.mark.parametrize("second", [{"type": "image", "source": {"type": "base64", "data": "synthetic"}}, {"type": "text", "text": "이어 쓴 글"}])
def test_tag_shaped_first_block_without_app_notice_is_kept(transcript, second):
    cases, _, write, read, anchor = transcript
    human = "<system-reminder>\n사용자가 쓴 글\n</system-reminder>"
    cases["normal"][0]["message"]["content"] = [{"type": "text", "text": human}, second]
    write(cases["base"] + cases["normal"])
    assert read(anchor)[0]["text"] == human + "\n" + ("[그림]" if second["type"] == "image" else "이어 쓴 글")


def test_local_command_and_summary_are_not_humans(transcript):
    cases, _, write, read, anchor = transcript
    caveat = {"type": "user", "uuid": "cav", "parentUuid": "a0", "isMeta": True, "entrypoint": "claude-desktop",
              "message": {"role": "user", "content": "<local-command-caveat>합성 안내</local-command-caveat>"}}
    command = {"type": "user", "uuid": "cmd", "parentUuid": "cav", "entrypoint": "claude-desktop", "message": {"role": "user",
               "content": "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"}}
    stdout = {"type": "user", "uuid": "out", "parentUuid": "cmd", "entrypoint": "claude-desktop",
              "message": {"role": "user", "content": "<local-command-stdout>합성 출력</local-command-stdout>"}}
    write(cases["base"] + [caveat, command, stdout])
    assert read(anchor) == []


@pytest.mark.parametrize("content", ["<local-command-caveat>isMeta 없는 안내</local-command-caveat>",
                                     "<command-name>직접 쓴 문장</command-name>",
                                     [{"type": "text", "text": "<local-command-stdout>목록 content</local-command-stdout>"}],
                                     "<command-name>/compact</command-name>\n덧붙인 사람 글"])
def test_origin_missing_row_outside_observed_local_shapes_fails(transcript, content):
    cases, _, write, read, anchor = transcript
    row = {"type": "user", "uuid": "odd", "parentUuid": "a0", "entrypoint": "claude-desktop", "message": {"role": "user", "content": content}}
    write(cases["base"] + [row])
    with pytest.raises(tr.TranscriptError, match="read_failed"):
        read(anchor)


def test_result_of_tool_called_before_anchor_becomes_supplement_event(transcript):
    cases, _, write, read, _ = transcript
    pending = {"type": "assistant", "uuid": "a0", "parentUuid": "u0", "message": {"role": "assistant", "id": "response0", "content": [
        {"type": "text", "text": "도구를 부름"}, {"type": "tool_use", "id": "t0", "name": "mcp__mvhub_panel__read_context", "input": {}}]}}
    write(cases["base"][:1] + [pending])
    anchor = read()
    result = {"type": "user", "uuid": "r0", "parentUuid": "a0", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t0", "content": "{}"}]}}
    answer = {"type": "assistant", "uuid": "a1", "parentUuid": "r0", "entrypoint": "claude-desktop",
              "message": {"role": "assistant", "id": "response1", "content": [{"type": "text", "text": "결과 뒤 답"}]}}
    write(cases["base"][:1] + [pending, result, answer])
    turns = read(anchor)
    assert len(turns) == 1 and turns[0]["text"] == "[Claude 앱에서 이어진 답변]" and turns[0]["context"]["supplement"] is True
    assert turns[0]["events"][1:] == [{"kind": "tool", "name": "read_context", "status": "done"}, {"kind": "text", "text": "결과 뒤 답"}]
    write(cases["base"][:1] + [pending, result, {**result, "uuid": "r1", "parentUuid": "r0"}])
    with pytest.raises(tr.TranscriptError, match="read_failed"):  # 같은 결과 두 번은 실패
        read(anchor)


@pytest.mark.parametrize("fault,code", [("prefix", "anchor_changed"), ("missing_anchor", "anchor_changed"), ("broken_parent", "anchor_changed"),
                                        ("branch", "branched"), ("detached", "branched"), ("duplicate", "read_failed"),
                                        ("unknown_node", "read_failed"), ("other_session", "read_failed")])
def test_structural_failures(transcript, fault, code):
    cases, _, write, read, anchor = transcript
    rows = cases["base"] + cases["normal"]
    if fault == "prefix":
        rows[0]["message"]["content"] = "앞이 바뀜"
    elif fault == "missing_anchor":
        rows[1]["uuid"] = "new-anchor"
        rows[2]["parentUuid"] = "new-anchor"
    elif fault == "broken_parent":
        rows[-1]["parentUuid"] = "missing"
    elif fault in ("branch", "detached"):
        rows.append({**cases["normal"][0], "uuid": "branch", "parentUuid": "a0" if fault == "branch" else None})
    elif fault == "duplicate":
        rows.append({**rows[-1], "parentUuid": "u1"})
    elif fault == "unknown_node":
        rows.append({"type": "future", "uuid": "future", "parentUuid": "a2"})
    else:
        rows[-1]["sessionId"] = "other"
    write(rows)
    with pytest.raises(tr.TranscriptError, match=code):
        read(anchor)


@pytest.mark.parametrize("tail", [b'{"type":', b'not json\n', b'[]\n', b'\xff\n'])
def test_bad_and_incomplete_lines_are_not_skipped(transcript, tail):
    _, path, _, read, anchor = transcript
    with path.open("ab") as stream:
        stream.write(tail)
    with pytest.raises(tr.TranscriptError, match="read_failed"):
        read(anchor)


def test_duplicate_location_and_different_cwd(transcript):
    cases, path, write, read, anchor = transcript
    other = path.parent.parent / "duplicate" / path.name
    other.parent.mkdir()
    other.write_bytes(path.read_bytes())
    with pytest.raises(tr.TranscriptError, match="read_failed"):
        read(anchor)
    other.unlink()
    cases["base"][0]["cwd"] = str(path.parent)
    write(cases["base"])
    with pytest.raises(tr.TranscriptError, match="read_failed"):
        read(anchor)


@pytest.mark.parametrize("limit", ["MAX_FILE", "MAX_LINE", "MAX_RESULT", "MAX_TURNS", "MAX_EVENTS"])
def test_protection_limits(transcript, monkeypatch, limit):
    cases, _, write, read, anchor = transcript
    write(cases["base"] + cases["normal"])
    monkeypatch.setattr(tr, limit, 1)
    with pytest.raises(tr.TranscriptError, match="too_large"):
        read(anchor)


def test_file_replaced_while_reading(transcript, monkeypatch):
    _, path, _, read, anchor = transcript
    real = tr._stamp
    count = 0

    def stamp(value):
        nonlocal count
        count += 1
        result = real(value)
        return (result[0], result[1] + 1, *result[2:]) if count >= 4 else result

    monkeypatch.setattr(tr, "_stamp", stamp)
    with pytest.raises(tr.TranscriptError, match="file_changed"):
        read(anchor)


def test_omissions_unmatched_tools_and_supplement(transcript):
    cases, _, write, read, anchor = transcript
    row = copy.deepcopy(cases["normal"][1])
    row["parentUuid"] = "a0"
    row["message"]["content"][1]["text"] = "x" * (tr.MAX_TEXT + 10)
    write(cases["base"] + [row])
    turn = read(anchor)[0]
    assert turn["context"]["supplement"] is True
    assert turn["context"]["omitted"]["characters"] == 10
    assert next(e for e in turn["events"] if e["kind"] == "tool")["status"] == "unknown"


def test_large_request_body_is_not_a_conversation(transcript):
    cases, _, write, read, anchor = transcript
    blob = {"type": "api-request", "request": {"padding": "x" * 1024**2, "type": "user", "uuid": "fake",
                                               "origin": {"kind": "human"}, "message": "not a message"}}
    write(cases["base"] + [blob] + cases["normal"])
    assert len(read(anchor)) == 2


def test_junction_escape_is_rejected_before_file_read(transcript, monkeypatch):
    _, path, _, read, anchor = transcript
    original = Path.resolve

    def escaped(self, *args, **kwargs):
        if self == path.parent:
            return path.parents[4] / "outside"
        return original(self, *args, **kwargs)

    monkeypatch.setattr(Path, "resolve", escaped)
    with pytest.raises(tr.TranscriptError, match="read_failed"):
        read(anchor)


def test_invalid_unicode_is_a_read_error(transcript):
    cases, _, write, read, anchor = transcript
    cases["normal"][0]["message"]["content"] = "bad"
    write(cases["base"] + cases["normal"])
    _, path, _, _, _ = transcript
    path.write_text(path.read_text(encoding="utf-8").replace('"bad"', '"\\ud800"'), encoding="utf-8")
    with pytest.raises(tr.TranscriptError, match="read_failed"):
        read(anchor)
