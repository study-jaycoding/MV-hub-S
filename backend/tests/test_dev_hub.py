"""tools/dev_hub.py — 로컬 허브 개발 세션의 환경 계약(계정별 DB·위임은 켜고, 실제 공유 서버로 나갈 길은 없다)."""
from __future__ import annotations

import importlib.util
import subprocess
import sys
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
_SPEC = importlib.util.spec_from_file_location("dev_hub_target", ROOT / "tools" / "dev_hub.py")
dev_hub = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(dev_hub)

SHARED = "http://127.0.0.1:8012"
PARENT = {
    "PATH": "",
    "CONTENT_HUB_DB": "남의.db",
    "CONTENT_HUB_NO_PROXY": "1",
    "CONTENT_HUB_AUTH": "1",
    "CONTENT_HUB_LOCAL_AGENT_PAIR_SECRET": "남의 키",
    "HTTP_PROXY": "http://남의-프록시:1",
}


def test_keeps_account_db_switch_and_delegation(tmp_path):
    env = dev_hub.hub_env(PARENT, SHARED, 8013, tmp_path)
    assert "CONTENT_HUB_DB" not in env  # 넣으면 계정별 DB 전환이 꺼진다
    assert "CONTENT_HUB_NO_PROXY" not in env  # 넣으면 허브가 서버로 위임하지 않는다
    assert "CONTENT_HUB_LOCAL_AGENT_PAIR_SECRET" not in env
    assert (env["CONTENT_HUB_AUTH"], env["CONTENT_HUB_SHARED_URL"]) == ("0", SHARED)
    assert (env["CONTENT_HUB_HOST"], env["CONTENT_HUB_PORT"], env["CONTENT_HUB_DATA"]) == ("127.0.0.1", "8013", str(tmp_path))


def test_only_loopback_escapes_the_dead_proxy(tmp_path):
    env = dev_hub.hub_env(PARENT, SHARED, 8013, tmp_path)
    proxies = {"http": env["HTTP_PROXY"], "https": env["HTTPS_PROXY"], "no": env["NO_PROXY"]}
    assert proxies["http"] == proxies["https"] == "http://127.0.0.1:9"
    assert urllib.request.proxy_bypass_environment("127.0.0.1:8012", proxies)
    assert not urllib.request.proxy_bypass_environment("192.168.1.171:8010", proxies)
    assert not urllib.request.proxy_bypass_environment("cloud.comfy.org", proxies)


@pytest.mark.parametrize("url", ["http://192.168.1.171:8010", "http://example.com:8012", "http://127.0.0.1"])
def test_refuses_shared_url_off_this_pc(tmp_path, url):
    with pytest.raises(ValueError):
        dev_hub.hub_env(PARENT, url, 8013, tmp_path)


@pytest.mark.parametrize("path", ["data", "data_test", "data_test/hub", "data/hub", "."])
def test_refuses_data_folder_overlapping_user_data(path):
    with pytest.raises(ValueError):
        dev_hub.hub_env(PARENT, SHARED, 8013, dev_hub.BACKEND / path)


@pytest.mark.parametrize("address", [("192.168.1.171", 8010), ("10.0.0.1", 80), ("172.17.224.1", 80), ("fe80::1%3", 80, 0, 3)])
def test_refuse_lan_stops_private_addresses(address):
    with pytest.raises(PermissionError):
        dev_hub.refuse_lan(address)


@pytest.mark.parametrize("address", [("127.0.0.1", 8012), ("::1", 8012, 0, 0), ("13.35.1.1", 443), "pipe", ()])
def test_refuse_lan_allows_this_pc_and_public(address):
    dev_hub.refuse_lan(address)


@pytest.mark.parametrize("name", ["hub-server", "localhost"])
def test_refuse_lan_refuses_names_without_resolving_again(name):
    with pytest.raises(PermissionError):  # 다시 풀면 C 가 실제로 푼 목적지와 달라질 수 있다
        dev_hub.refuse_lan((name, 8010))


def test_lan_guard_covers_blocking_and_asyncio_connects():
    # 감사 훅은 지울 수 없어 자식 프로세스에서 잰다. 192.0.2.1 은 문서용 주소라 실제로 나가지 않는다.
    code = """
import asyncio, importlib.util, socket, sys
spec = importlib.util.spec_from_file_location("dev_hub", sys.argv[1])
hub = importlib.util.module_from_spec(spec); spec.loader.exec_module(hub)
# 이름을 쓰는 표준 클라이언트가 푼 뒤의 IP 로 막히는지 보려고 파이썬 쪽 해석만 사설 주소로 바꾼다.
real_getaddrinfo = socket.getaddrinfo
def fake_getaddrinfo(host, *args, **kwargs):
    return real_getaddrinfo("192.0.2.1" if host == "localhost" else host, *args, **kwargs)
socket.getaddrinfo = fake_getaddrinfo
hub.install_lan_guard()
def attempt(label, call):
    try:
        call()
    except PermissionError:
        print(label + " refused")
for host in ("192.0.2.1", "localhost"):
    attempt("create_connection " + host, lambda: socket.create_connection((host, 8010), timeout=2))
    attempt("connect " + host, lambda: socket.socket().connect((host, 8010)))
    attempt("asyncio " + host, lambda: asyncio.run(asyncio.wait_for(asyncio.open_connection(host, 8010), 2)))
"""
    out = subprocess.run([sys.executable, "-c", code, str(ROOT / "tools" / "dev_hub.py")], capture_output=True, text=True, timeout=60)
    assert [line for line in out.stdout.split("\n") if line] == [
        f"{kind} {host} refused" for host in ("192.0.2.1", "localhost") for kind in ("create_connection", "connect", "asyncio")
    ], out.stderr


def test_launcher_bat_is_ascii_crlf():
    raw = (ROOT / "test_dev_hub.bat").read_bytes()
    assert raw.isascii()
    assert raw.count(b"\n") == raw.count(b"\r\n")  # LF 만 있으면 cmd 가 라벨(goto)을 놓친다
