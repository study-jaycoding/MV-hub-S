"""비용 없이 MV Hub와 ComfyUI의 실제 HTTP 실행 경계를 왕복 검증한다.

사용자 DB, 실행 중인 개발 서버, Comfy Cloud 계정은 건드리지 않는다. 고유한 임시 데이터
폴더와 포트에 MV Hub 백엔드를 띄우고, 로컬 가짜 ComfyUI 서버를 실제 HTTP 대상으로 사용한다.
이미지 업로드, 동시 실행 제한, 완료 결과 다운로드, 실패한 prompt만 취소, 임시파일·in-flight
흔적 정리까지 한 번에 확인한다.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import closing
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
DEFAULT_TIMEOUT_SECONDS = 45.0
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUB"
    "AScY42YAAAAASUVORK5CYII="
)


class LiveVerifyError(RuntimeError):
    """실측 실패를 사람이 바로 이해할 수 있는 메시지로 전달한다."""


@dataclass
class _FakeComfyState:
    lock: threading.Lock = field(default_factory=threading.Lock)
    prompts: dict[str, dict[str, Any]] = field(default_factory=dict)
    active: set[str] = field(default_factory=set)
    submitted_workflows: list[dict[str, Any]] = field(default_factory=list)
    submission_order: list[str] = field(default_factory=list)
    queue_deletes: list[str] = field(default_factory=list)
    upload_count: int = 0
    interrupt_count: int = 0
    max_active: int = 0

    def submit(self, workflow: dict[str, Any]) -> str:
        prompt_id = "fake-" + uuid.uuid4().hex[:12]
        mode = "failure" if any(
            isinstance(node, dict)
            and isinstance(node.get("inputs"), dict)
            and node["inputs"].get("force_fail") is True
            for node in workflow.values()
        ) else "success"
        with self.lock:
            self.prompts[prompt_id] = {"mode": mode, "polls": 0}
            self.active.add(prompt_id)
            self.submitted_workflows.append(workflow)
            self.submission_order.append(prompt_id)
            self.max_active = max(self.max_active, len(self.active))
        return prompt_id

    def history(self, prompt_id: str) -> dict[str, Any]:
        with self.lock:
            prompt = self.prompts.get(prompt_id)
            if prompt is None:
                return {}
            prompt["polls"] += 1
            if prompt["polls"] < 2:
                return {}
            self.active.discard(prompt_id)
            if prompt["mode"] == "failure":
                return {
                    prompt_id: {
                        "status": {
                            "status_str": "error",
                            "completed": True,
                            "messages": [
                                [
                                    "execution_error",
                                    {"exception_message": "synthetic node failure"},
                                ]
                            ],
                        },
                        "outputs": {},
                    }
                }
            return {
                prompt_id: {
                    "status": {"status_str": "success", "completed": True},
                    "outputs": {
                        "2": {
                            "images": [
                                {
                                    "filename": f"{prompt_id}.png",
                                    "subfolder": "mvhub",
                                    "type": "output",
                                }
                            ]
                        }
                    },
                }
            }


def _make_fake_handler(state: _FakeComfyState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "MVHubFakeComfy/1.0"

        def log_message(self, _format: str, *_args: Any) -> None:
            return

        def _body(self) -> bytes:
            try:
                length = int(self.headers.get("Content-Length") or "0")
            except ValueError:
                length = 0
            return self.rfile.read(max(0, length))

        def _json(self, status: int, payload: Any) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - stdlib HTTP handler contract
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path == "/system_stats":
                self._json(200, {"system": {"os": "fake"}})
                return
            if parsed.path == "/queue":
                with state.lock:
                    active = sorted(state.active)
                self._json(200, {"queue_running": active, "queue_pending": []})
                return
            if parsed.path.startswith("/history/"):
                prompt_id = urllib.parse.unquote(parsed.path.removeprefix("/history/"))
                self._json(200, state.history(prompt_id))
                return
            if parsed.path == "/view":
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(_PNG)))
                self.end_headers()
                self.wfile.write(_PNG)
                return
            self._json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802 - stdlib HTTP handler contract
            parsed = urllib.parse.urlsplit(self.path)
            body = self._body()
            if parsed.path == "/upload/image":
                if b'name="image"' not in body or _PNG not in body:
                    self._json(400, {"error": "invalid multipart upload"})
                    return
                with state.lock:
                    state.upload_count += 1
                self._json(
                    200,
                    {"name": "input.png", "subfolder": "mvhub", "type": "input"},
                )
                return
            if parsed.path == "/prompt":
                try:
                    payload = json.loads(body.decode("utf-8"))
                    workflow = payload["prompt"]
                    if not isinstance(workflow, dict):
                        raise TypeError("prompt is not an object")
                except (KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                    self._json(400, {"error": str(exc)})
                    return
                self._json(200, {"prompt_id": state.submit(workflow)})
                return
            if parsed.path == "/queue":
                try:
                    payload = json.loads(body.decode("utf-8") or "{}")
                    deletes = payload.get("delete") or []
                except (UnicodeDecodeError, json.JSONDecodeError):
                    deletes = []
                with state.lock:
                    for prompt_id in deletes:
                        value = str(prompt_id)
                        state.queue_deletes.append(value)
                        state.active.discard(value)
                self._json(200, {})
                return
            if parsed.path == "/interrupt":
                with state.lock:
                    state.interrupt_count += 1
                self._json(200, {})
                return
            self._json(404, {"error": "not found"})

    return Handler


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _request(
    method: str,
    url: str,
    *,
    json_body: Any | None = None,
    body: bytes | None = None,
    content_type: str | None = None,
    timeout: float = 10.0,
) -> tuple[int, Any, bytes]:
    if json_body is not None:
        body = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
        content_type = "application/json"
    req = urllib.request.Request(url, data=body, method=method)
    if content_type:
        req.add_header("Content-Type", content_type)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            status = int(response.status)
            raw = response.read()
    except urllib.error.HTTPError as exc:
        status = int(exc.code)
        raw = exc.read()
    try:
        payload = json.loads(raw.decode("utf-8")) if raw else None
    except (UnicodeDecodeError, json.JSONDecodeError):
        payload = None
    return status, payload, raw


def _multipart(fields: dict[str, str], filename: str, file_bytes: bytes) -> tuple[bytes, str]:
    boundary = "----mvhub-live-" + uuid.uuid4().hex
    parts: list[bytes] = []
    for key, value in fields.items():
        parts.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode(),
                value.encode("utf-8"),
                b"\r\n",
            ]
        )
    parts.extend(
        [
            f"--{boundary}\r\n".encode(),
            (
                'Content-Disposition: form-data; name="media"; '
                f'filename="{filename}"\r\n'
            ).encode(),
            b"Content-Type: image/png\r\n\r\n",
            file_bytes,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ]
    )
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


def _workflow(force_fail: bool) -> dict[str, Any]:
    return {
        "1": {
            "class_type": "LoadImage",
            "inputs": {"image": "placeholder.png", "force_fail": force_fail},
        },
        "2": {
            "class_type": "SaveImage",
            "inputs": {"images": ["1", 0], "filename_prefix": "mvhub-live"},
        },
    }


def _start_run(base_url: str, force_fail: bool) -> str:
    fields = {
        "content": json.dumps(_workflow(force_fail), separators=(",", ":")),
        "param_values": "{}",
        "media_meta": '[{"type":"image"}]',
    }
    body, content_type = _multipart(fields, "input.png", _PNG)
    status, payload, _raw = _request(
        "POST",
        f"{base_url}/api/comfy/run",
        body=body,
        content_type=content_type,
    )
    if status != 200 or not isinstance(payload, dict) or not payload.get("job_id"):
        raise LiveVerifyError(f"Comfy 실행 시작 실패: HTTP {status}, {payload}")
    return str(payload["job_id"])


def _wait_ready(base_url: str, process: subprocess.Popen[Any], timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise LiveVerifyError(f"격리 MV Hub 서버가 조기 종료했습니다(code={process.returncode})")
        try:
            status, payload, _raw = _request(
                "GET", f"{base_url}/api/ready", timeout=1.0
            )
            if status == 200 and isinstance(payload, dict) and payload.get("status") == "ready":
                return
        except (urllib.error.URLError, TimeoutError, OSError):
            # 프로세스 생성과 리스너 바인딩 사이의 정상적인 짧은 구간. 제한 시간까지 재시도한다.
            pass
        time.sleep(0.1)
    raise LiveVerifyError("격리 MV Hub 서버가 제한 시간 안에 준비되지 않았습니다")


def _wait_runs(base_url: str, jobs: dict[str, bool], timeout: float) -> dict[str, dict[str, Any]]:
    pending = set(jobs)
    completed: dict[str, dict[str, Any]] = {}
    deadline = time.monotonic() + timeout
    while pending and time.monotonic() < deadline:
        for job_id in list(pending):
            status, payload, _raw = _request(
                "GET", f"{base_url}/api/comfy/run_status?job_id={job_id}", timeout=3.0
            )
            expected_failure = jobs[job_id]
            if status == 200 and isinstance(payload, dict) and "outputs" in payload:
                if expected_failure:
                    raise LiveVerifyError("실패 워크플로우가 성공으로 기록됐습니다")
                completed[job_id] = {"status": status, "payload": payload}
                pending.remove(job_id)
            elif status == 502:
                if not expected_failure:
                    raise LiveVerifyError(f"성공 워크플로우가 실패했습니다: {payload}")
                detail = str((payload or {}).get("detail") if isinstance(payload, dict) else payload)
                if "synthetic node failure" not in detail:
                    raise LiveVerifyError(f"실행 오류 원인이 보존되지 않았습니다: {payload}")
                completed[job_id] = {"status": status, "payload": payload}
                pending.remove(job_id)
            elif status != 200:
                raise LiveVerifyError(f"Comfy 상태 조회 실패: HTTP {status}, {payload}")
        if pending:
            time.sleep(0.1)
    if pending:
        raise LiveVerifyError(f"Comfy 작업이 제한 시간 안에 끝나지 않았습니다: {sorted(pending)}")
    return completed


def _tail(path: Path, lines: int = 80) -> str:
    try:
        return "\n".join(path.read_text("utf-8", errors="replace").splitlines()[-lines:])
    except OSError:
        return "(로그를 읽을 수 없음)"


def _stop_process(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def verify(timeout: float = DEFAULT_TIMEOUT_SECONDS) -> dict[str, Any]:
    fake_state = _FakeComfyState()
    fake_port = _free_port()
    fake_server = ThreadingHTTPServer(
        ("127.0.0.1", fake_port), _make_fake_handler(fake_state)
    )
    # 가짜 서버가 포트를 실제 점유한 뒤 앱 포트를 고른다. 둘 다 "빈 포트 확인"만 하고
    # 나중에 바인딩하면 Windows가 같은 포트를 두 번 돌려주는 작은 TOCTOU 경쟁이 생길 수 있다.
    app_port = _free_port()
    fake_thread = threading.Thread(
        target=fake_server.serve_forever, name="mvhub-fake-comfy", daemon=True
    )
    fake_thread.start()

    with tempfile.TemporaryDirectory(prefix="mvhub-comfy-live-") as tmp:
        root = Path(tmp)
        data_dir = root / "data"
        media_dir = data_dir / "media"
        temp_dir = root / "temp"
        log_path = root / "backend.log"
        temp_dir.mkdir(parents=True)
        env = os.environ.copy()
        env.update(
            {
                "CONTENT_HUB_DATA": str(data_dir),
                "CONTENT_HUB_MEDIA": str(media_dir),
                "CONTENT_HUB_ASSETS_DIR": str(data_dir / "assets"),
                "CONTENT_HUB_HOST": "127.0.0.1",
                "CONTENT_HUB_PORT": str(app_port),
                "CONTENT_HUB_AUTH": "0",
                "CONTENT_HUB_MANAGE": "0",
                "CONTENT_HUB_NO_PROXY": "1",
                "CONTENT_HUB_EXTERNAL_RECOVERY": "0",
                "CONTENT_HUB_ACCESS_LOG": "0",
                "CONTENT_HUB_METRICS_LOG_INTERVAL": "0",
                "CONTENT_HUB_COMFY_TIMEOUT_SEC": "60",
                "NO_PROXY": "127.0.0.1,localhost",
                "TEMP": str(temp_dir),
                "TMP": str(temp_dir),
                "PYTHONUNBUFFERED": "1",
            }
        )
        base_url = f"http://127.0.0.1:{app_port}"
        process: subprocess.Popen[Any] | None = None
        log_handle = log_path.open("w", encoding="utf-8")
        try:
            process = subprocess.Popen(
                [sys.executable, "serve.py"],
                cwd=BACKEND,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
            )
            try:
                _wait_ready(base_url, process, min(timeout, 20.0))
                fake_url = f"http://127.0.0.1:{fake_port}"
                status, settings, _raw = _request(
                    "PUT",
                    f"{base_url}/api/comfy/settings",
                    json_body={
                        "comfy_target": "local",
                        "comfy_url": fake_url,
                        "comfy_api_key": "",
                        "comfy_concurrency": 2,
                        "comfy_input_dir": "",
                    },
                )
                if status != 200 or not isinstance(settings, dict):
                    raise LiveVerifyError(f"Comfy 설정 저장 실패: HTTP {status}, {settings}")
                status, health, _raw = _request("GET", f"{base_url}/api/comfy/health")
                if status != 200 or health != {"alive": True, "target": fake_url}:
                    raise LiveVerifyError(f"Comfy 연결 확인 실패: HTTP {status}, {health}")

                jobs = {
                    _start_run(base_url, False): False,
                    _start_run(base_url, False): False,
                    _start_run(base_url, True): True,
                }
                completed = _wait_runs(base_url, jobs, timeout)

                output_urls: list[str] = []
                prompt_ids: list[str] = []
                for result in completed.values():
                    if result["status"] != 200:
                        continue
                    payload = result["payload"]
                    prompt_ids.append(str(payload["prompt_id"]))
                    outputs = payload.get("outputs") or []
                    if len(outputs) != 1 or outputs[0].get("kind") != "image":
                        raise LiveVerifyError(f"Comfy 성공 출력 구조가 올바르지 않습니다: {outputs}")
                    output_url = str(outputs[0].get("url") or "")
                    status, _payload, raw = _request("GET", base_url + output_url)
                    if status != 200 or raw != _PNG:
                        raise LiveVerifyError(f"저장된 Comfy 출력 파일 검증 실패: {output_url}")
                    output_urls.append(output_url)

                with fake_state.lock:
                    submitted = list(fake_state.submission_order)
                    queue_deletes = list(fake_state.queue_deletes)
                    workflows = list(fake_state.submitted_workflows)
                    max_active = fake_state.max_active
                    upload_count = fake_state.upload_count
                    interrupt_count = fake_state.interrupt_count
                    failed_prompts = {
                        prompt_id
                        for prompt_id, item in fake_state.prompts.items()
                        if item["mode"] == "failure"
                    }
                if len(submitted) != 3 or upload_count != 3:
                    raise LiveVerifyError(
                        f"제출/업로드 수가 맞지 않습니다: submit={len(submitted)}, upload={upload_count}"
                    )
                if max_active != 2:
                    raise LiveVerifyError(f"동시 실행 제한 2가 지켜지지 않았습니다: max={max_active}")
                if set(queue_deletes) != failed_prompts or len(queue_deletes) != 1:
                    raise LiveVerifyError(
                        f"실패 prompt 정밀 취소가 맞지 않습니다: deletes={queue_deletes}, "
                        f"failed={sorted(failed_prompts)}"
                    )
                if interrupt_count != 0:
                    raise LiveVerifyError("실패 처리 중 다른 작업까지 중단하는 /interrupt가 호출됐습니다")
                injected = [
                    ((workflow.get("1") or {}).get("inputs") or {}).get("image")
                    for workflow in workflows
                ]
                if injected != ["mvhub/input.png"] * 3:
                    raise LiveVerifyError(f"업로드 파일의 워크플로우 주입이 맞지 않습니다: {injected}")

                leftovers = sorted(path.name for path in temp_dir.glob("mvhub-comfy-input-*.part"))
                if leftovers:
                    raise LiveVerifyError(f"Comfy 입력 임시파일이 남았습니다: {leftovers}")

                db_path = data_dir / "db" / "content_hub.db"
                # sqlite3.Connection 컨텍스트는 트랜잭션만 끝내고 파일 핸들은 닫지 않는다.
                # Windows에서 곧바로 격리 폴더를 지울 수 있도록 closing으로 연결까지 닫는다.
                with closing(sqlite3.connect(db_path)) as conn:
                    row = conn.execute(
                        "SELECT value FROM app_setting WHERE key='comfy_inflight_runs'"
                    ).fetchone()
                inflight = json.loads(row[0]) if row else []
                if inflight != []:
                    raise LiveVerifyError(f"완료 뒤 Comfy in-flight 흔적이 남았습니다: {inflight}")

                return {
                    "ok": True,
                    "isolation": {
                        "temporary_data": True,
                        "cloud_requests": 0,
                        "user_server_touched": False,
                    },
                    "connection": health,
                    "execution": {
                        "jobs": len(jobs),
                        "succeeded": len(output_urls),
                        "failed_as_expected": sum(
                            result["status"] == 502 for result in completed.values()
                        ),
                        "uploads": upload_count,
                        "max_active": max_active,
                        "configured_concurrency": 2,
                        "prompt_ids": sorted(prompt_ids),
                        "output_urls": sorted(output_urls),
                    },
                    "failure_boundary": {
                        "targeted_queue_deletes": queue_deletes,
                        "blanket_interrupts": interrupt_count,
                    },
                    "cleanup": {
                        "staged_inputs": 0,
                        "inflight_runs": len(inflight),
                    },
                }
            except Exception as exc:
                log_handle.flush()
                if isinstance(exc, LiveVerifyError):
                    raise LiveVerifyError(f"{exc}\n\n격리 백엔드 로그:\n{_tail(log_path)}") from exc
                raise LiveVerifyError(
                    f"{type(exc).__name__}: {exc}\n\n격리 백엔드 로그:\n{_tail(log_path)}"
                ) from exc
        finally:
            if process is not None:
                _stop_process(process)
            log_handle.close()
            fake_server.shutdown()
            fake_server.server_close()
            fake_thread.join(timeout=5)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="전체 Comfy 작업 완료 대기 시간(초)",
    )
    args = parser.parse_args()
    if args.timeout < 10:
        parser.error("--timeout은 최소 10초입니다")
    try:
        result = verify(args.timeout)
    except Exception as exc:  # noqa: BLE001 - 검증 CLI는 원인을 JSON으로 남긴다.
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
