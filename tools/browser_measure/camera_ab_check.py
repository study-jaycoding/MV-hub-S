"""Fixed camera (c) experiment contract and checker; no browser or server startup."""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import math
from pathlib import Path
import re
import statistics

FORMAT = "camera-ab-c-120-v1"
CONTRACT = "26d1189607e2b6e9582cb443c0b9e4bbd3667ba5d7db738ef438c66edfb53c7c"
HELPER_REVISION = "d971883c9356d95d68613dee7973693116004f9a"
PRODUCTS = (
    "frontend/src/lib/sceneStore.ts", "frontend/src/lib/useSceneViewport.ts",
    "frontend/src/features/canvas/gpu/GpuBoard.tsx",
)
HELPERS = (
    "backend/app/services/win_job.py", "tools/browser_measure/cdp.py",
    "tools/browser_measure/canvas_notebook.py", "tools/browser_measure/servers.py",
    "tools/verify_canvas_notebook_measure.py",
)
ROUNDS = {"bake": 10, "ops": 10, "switch": 10}
LIMITS = {"alpha": 0.05, "ops_max_total_delta": 20, "switch_max_total_delta": 15,
          "lock_max_candidate": 2, "lock_max_delta": 1}
OPS = ("low_out", "mid_in", "mid_out", "pan_25", "pan_50")
EXIT_CODES = {"passed": 0, "not-passed": 1, "incomplete": 2}
SMOKE_CHECKS = {"static", "jpegs", "locate", "batch", "notices", "outsideApi", "releaseBlocked", "wrongMethod",
                "blocked", "ws", "ownWS", "blob", "data", "serviceWorkerBypass", "allowed_api_reached", "release_api_not_reached"}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def loads(data):
    def pairs(items):
        out = {}
        for key, value in items:
            require(key not in out, "duplicate JSON key")
            out[key] = value
        return out
    def invalid(_value):
        raise ValueError("nonfinite JSON number")
    return json.loads(data, object_pairs_hook=pairs, parse_constant=invalid)


def read(path):
    return loads(path.read_bytes())


def spec_check(spec):
    require(isinstance(spec, dict) and set(spec) == {
        "format", "sources", "d_commit", "source_diff_sha256", "rounds", "order", "criteria"}, "experiment fields")
    require(spec["format"] == FORMAT and spec["order"] == "original-alternating-v1", "experiment format/order")
    require(canonical(spec["rounds"]) == canonical(ROUNDS) and canonical(spec["criteria"]) == canonical(LIMITS), "fixed experiment constants")
    require(isinstance(spec["sources"], dict) and set(spec["sources"]) == {"src_o", "src_n"}, "two sources required")
    for revision in [*spec["sources"].values(), spec["d_commit"]]:
        require(isinstance(revision, str) and re.fullmatch(r"[0-9a-f]{40}", revision), "full commit SHA required")
    require(isinstance(spec["source_diff_sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", spec["source_diff_sha256"]), "patch SHA256 required")


def source_check(spec, git):
    spec_check(spec)
    base, target = (spec["sources"][s] for s in ("src_o", "src_n"))
    for revision in (base, target, spec["d_commit"]):
        require(git("rev-parse", "--verify", revision + "^{commit}").decode().strip() == revision, "source is not a commit")
    require(git("rev-list", "--parents", "-n", "1", target).decode().split() == [target, base], "candidate parent must be baseline")
    git("merge-base", "--is-ancestor", spec["d_commit"], base)
    raw = git("diff", "--no-ext-diff", "--no-textconv", "--raw", "--no-abbrev", "--no-renames", "-z", base, target, "--")
    fields = raw.decode("utf-8").rstrip("\0").split("\0")
    require(len(fields) == 6, "exactly three product changes required")
    paths = []
    for header, path in zip(fields[::2], fields[1::2]):
        mode_before, mode_after, _before, _after, status = header.split()
        require(mode_before == ":100644" and mode_after == "100644" and status == "M", "only regular file content changes allowed")
        paths.append(path)
    require(set(paths) == set(PRODUCTS), "unexpected product change")
    patch = git("diff", "--no-ext-diff", "--no-textconv", "--binary", base, target, "--")
    require(digest(patch) == spec["source_diff_sha256"], "unreviewed source patch")
    helpers = {}
    for path in HELPERS:
        fixed = git("show", f"{HELPER_REVISION}:{path}")
        for revision in (base, target):
            require(git("show", f"{revision}:{path}") == fixed, "fixed helper changed")
        helpers[path] = digest(fixed)
    return {"sources": spec["sources"], "d_commit": spec["d_commit"], "diff": digest(patch), "helpers": helpers}


def order():
    return [dict(mode=mode, round=r, src=src, flag=flag, rate=rate,
                 key=f"{src}|gpu{flag}|x{rate}", tag=mode + "10")
            for mode in ROUNDS for r in range(1, 11)
            for src in (("src_o", "src_n") if r % 2 else ("src_n", "src_o"))
            for flag in (("0", "1") if mode == "switch" else ("1",))
            for rate in ((1, 4) if mode == "switch" else (4,))]


def count(value):
    require(type(value) is int and value >= 0, "count must be a nonnegative integer")
    return value


def number(value):
    require(type(value) in (int, float) and math.isfinite(value) and value >= 0, "invalid duration")
    return value


def phase_check(phase):
    # SceneBoard removes data-gpu in DOM mode, including after a GPU lock.
    require(isinstance(phase, dict) and "gpu" in phase and phase["gpu"] in (None, "gpu", "dom", "preparing", "probing") and "lock" in phase, "missing GPU/lock phase")
    require(phase["lock"] is None or isinstance(phase["lock"], str), "invalid lock")


def locked(result):
    m, row, evidence = result["measurement"], result["row"], result["evidence"]
    keys = ("start", "end") if row["mode"] == "ops" else ("end",) if row["mode"] == "bake" else ("phase",)
    phases = [m[key] for key in keys] + [evidence["phase"]]
    for key in ("start", "end", "phase"):
        if key in m and key not in keys:
            phases.append(m[key])
    for phase in phases:
        phase_check(phase)
    return any(bool(phase["lock"]) for phase in phases)


def row_check(result, expected):
    require(result["status"] == "measured" and canonical(result["row"]) == canonical(expected), "row identity/status mismatch")
    e, m = result["evidence"], result["measurement"]
    for value in e["stored_cards"]:
        count(value)
    require(e["stored_cards"] == ([412, 412] if expected["mode"] == "switch" else [2060]), "stored card count mismatch")
    obs = e["observations"]
    require(count(obs["raf"]) > 0 and obs["loafSupported"] is True and obs["loafError"] is False, "RAF/LoAF precondition")
    for key in ("draw", "tick", "cam", "flush", "blockedWS"):
        count(obs[key])
    require(obs["blockedWS"] == 0 and count(e["runtime_errors"]) == 0 and count(e["static_errors"]) == 0, "instrumentation/network error")
    for key, value in e["requests"].items():
        count(value)
        require(not value or key in ("owned", "fake-media", "local-resource", "disabled-background"), "unexpected blocked request")
    renderer = e["renderer"]
    require(isinstance(renderer, str) and renderer and not any(x in renderer.lower() for x in ("swiftshader", "llvmpipe", "software", "basic render")), "hardware renderer required")
    is_locked = locked(result)
    if expected["flag"] == "1":
        require(obs["draw"] > 0, "GPU not entered")
        end = m["phase"] if expected["mode"] == "switch" else m["end"]
        require((end["gpu"] == "gpu" and e["phase"]["gpu"] == "gpu") or is_locked, "GPU exit without lock")
    else:
        require(not is_locked, "GPU-off row locked")
    versions = result["versions"]
    require(set(versions) == {"python", "PIL", "websockets"} and all(isinstance(v, str) and v for v in versions.values()), "missing runtime version")
    browser = e["browser_version"]
    require(isinstance(browser, dict) and all(isinstance(browser.get(k), str) and browser[k] for k in ("product", "revision", "jsVersion", "protocolVersion")), "missing browser version")
    require(len(result["jpeg_hashes"]) == 32 and all(isinstance(h, str) and re.fullmatch(r"[0-9a-f]{64}", h) for h in result["jpeg_hashes"]), "missing synthetic media hashes")
    if expected["mode"] == "ops":
        require(set(m["ops"]) == set(OPS), "operation fields")
        for item in m["ops"].values():
            for key in ("gaps33", "bakes", "bake_calls", "cam_commits"):
                count(item[key])
            for key in ("first_input_delay", "window_ms"):
                number(item[key])
            for key in ("idb", "flush"):
                count(item[key]["n"])
                number(item[key]["ms"])
    elif expected["mode"] == "bake":
        for key in ("pending_before", "bakes", "bakes_after", "gaps33", "bake_calls", "cam_commits_in_window"):
            count(m[key])
        number(m["first_input_delay"])
        number(m["window_ms"])
        require(m["pending_before"] > 0, "bake pending precondition")
    else:
        count(m["after_switch_2s_gaps33"])
        require(isinstance(m["idb"], list), "missing switch IDB")
        for span in m["idb"]:
            require(isinstance(span, list) and len(span) == 2 and type(span[0]) in (int, float) and math.isfinite(span[0]), "invalid switch IDB span")
            number(span[1])
    return {"renderer": renderer, "versions": versions, "browser": browser, "jpeg_hashes": result["jpeg_hashes"]}


def job_check(job):
    require(job.get("status") == "exited" and type(job.get("exit_code")) is int and job["exit_code"] == 0
            and type(job.get("active_after")) is int and job["active_after"] == 0
            and job.get("cleanup_errors") == [] and "error_type" not in job, "worker Job incomplete")


def metric(base, target, margin):
    require(len(base) == len(target) == 10, "ten pairs required")
    diffs = [count(t) - count(b) for b, t in zip(base, target)]
    delta = sum(diffs)
    hits = sum(sum(s * d for s, d in zip(signs, diffs)) >= delta for signs in itertools.product((-1, 1), repeat=10))
    return {"B": base, "T": target, "B_total": sum(base), "T_total": sum(target), "delta": delta,
            "hits": hits, "permutations": 1024, "p_bad": hits / 1024, "max_total_delta": margin,
            "passed": hits >= 52 and delta <= margin}


def summary(values):
    return {"values": values, "total": sum(values), "median": statistics.median(values)}


def judge(rows):
    require(len(rows) == 120, "120 rows required")
    indexed, environment = {}, None
    for expected, result in zip(order(), rows):
        actual = row_check(result, expected)
        require(environment is None or actual == environment, "measurement environment changed")
        environment = actual
        indexed[(expected["mode"], expected["src"], expected["round"], expected["flag"], expected["rate"])] = result
    def selected(mode, src, flag="1", rate=4):
        return [indexed[(mode, src, r, flag, rate)] for r in range(1, 11)]
    metrics, supplemental, locks, bake = {}, {}, {}, {}
    for mode in ("ops", "switch"):
        totals = {}
        for src in ("src_o", "src_n"):
            if mode == "ops":
                totals[src] = [sum(r["measurement"]["ops"][op]["gaps33"] for op in OPS) for r in selected(mode, src)]
                supplemental[src + "|ops"] = {op: {
                    "gaps33": summary([r["measurement"]["ops"][op]["gaps33"] for r in selected(mode, src)]),
                    "first_input_delay": summary([r["measurement"]["ops"][op]["first_input_delay"] for r in selected(mode, src)]),
                    "idb": {key: summary([r["measurement"]["ops"][op]["idb"][key] for r in selected(mode, src)]) for key in ("n", "ms")},
                    "flush": {key: summary([r["measurement"]["ops"][op]["flush"][key] for r in selected(mode, src)]) for key in ("n", "ms")},
                } for op in OPS}
            else:
                totals[src] = [sum(indexed[(mode, src, r, flag, rate)]["measurement"]["after_switch_2s_gaps33"]
                                   for flag in ("0", "1") for rate in (1, 4)) for r in range(1, 11)]
                for flag in ("0", "1"):
                    for rate in (1, 4):
                        group = selected(mode, src, flag, rate)
                        supplemental[f"{src}|switch|gpu{flag}|x{rate}"] = {
                            "gaps33": summary([r["measurement"]["after_switch_2s_gaps33"] for r in group]),
                            "idb_started_relative_to_switch_ms": [r["measurement"]["idb"] for r in group],
                        }
        metrics[mode] = metric(totals["src_o"], totals["src_n"], LIMITS[mode + "_max_total_delta"])
    for mode, rate in (("bake", 4), ("ops", 4), ("switch", 1), ("switch", 4)):
        b, t = (sum(locked(r) for r in selected(mode, src, rate=rate)) for src in ("src_o", "src_n"))
        locks[f"{mode}|gpu1|x{rate}"] = {"B": b, "T": t, "rows_per_source": 10, "passed": t <= b + 1 and t <= 2}
    for src in ("src_o", "src_n"):
        bake[src] = {key: [r["measurement"][key] for r in selected("bake", src)] for key in (
            "pending_before", "bakes", "bakes_after", "gaps33", "first_input_delay")}
        supplemental[src + "|bake"] = {key: summary(bake[src][key]) for key in ("gaps33", "first_input_delay")}
    bake["baseline_median"] = statistics.median(bake["src_o"]["bakes"])
    require(bake["baseline_median"] > 0, "baseline bake not reproduced")
    bake["preconditions"] = {"pending_all_positive": True, "baseline_median_positive": True}
    bake["passed"] = all(v == 0 for v in bake["src_n"]["bakes"]) and all(v > 0 for v in bake["src_n"]["bakes_after"])
    reasons = [key for key, value in {**metrics, **locks, "bake": bake}.items() if not value["passed"]]
    notes = ["judge: not measured; contract pass is not equivalence or overall safety"]
    if all(supplemental[src + "|ops"]["low_out"]["gaps33"]["total"] == 0 for src in ("src_o", "src_n")):
        notes.append("low_out: historical signal not exercised (both zero)")
    return {"status": "not-passed" if reasons else "passed", "metrics": metrics, "locks": locks,
            "bake": bake, "supplemental": supplemental, "reasons": reasons, "notes": notes}


def read_series(work, folder, expected, environment=None):
    directory = work / folder
    names = {f"row-{i:03}.json" for i in range(len(expected))}
    require({p.name for p in directory.glob("row-*.json") if not p.name.endswith(".job.json")} == names, "missing/extra row files")
    require({p.name for p in directory.glob("row-*.job.json")} == {n.replace(".json", ".job.json") for n in names}, "missing/extra Job files")
    rows, aggregates, hashes = [], {}, {}
    for i, row in enumerate(expected):
        path = directory / f"row-{i:03}.json"
        job_path = directory / f"row-{i:03}.job.json"
        result, job = read(path), read(job_path)
        try:
            job_check(job)
            current = row_check(result, row)
            require(environment is None or environment == current, "measurement environment changed")
        except (ValueError, KeyError, TypeError) as exc:
            detail = str(exc) if isinstance(exc, ValueError) else type(exc).__name__
            raise ValueError(f"{folder}/row-{i:03}: {detail}") from exc
        environment = current
        rows.append(result)
        aggregates.setdefault(row["tag"], {}).setdefault(row["key"], []).append(result["measurement"])
        for p in (path, job_path):
            hashes[p.relative_to(work).as_posix()] = digest(p.read_bytes())
    for tag, values in aggregates.items():
        path = directory / f"rd_{tag}.json"
        require(canonical(read(path)) == canonical(values), "aggregate differs from raw rows")
        hashes[path.relative_to(work).as_posix()] = digest(path.read_bytes())
    return rows, environment, hashes


def check_smoke(work, meta):
    smoke = read(work / "safety-smoke/complete.json")
    require(smoke["status"] == "passed" and smoke["cases"] == ["normal", "error", "timeout"] and smoke["tool"] == meta["tool"], "safety smoke incomplete")
    evidence = {}
    for behavior in smoke["cases"]:
        root = work / "safety-smoke" / behavior
        observed, job = read(root / "smoke.json"), read(root / "worker.job.json")
        require(count(observed["canary_hits"]) == 0 and count(observed["static_errors"]) == 0
                and set(observed["checks"]) == SMOKE_CHECKS
                and all(v is True for v in observed["checks"].values()), "smoke canary incomplete")
        require(count(job["active_after"]) == 0 and job["cleanup_errors"] == [] and "error_type" not in job, "smoke Job cleanup incomplete")
        require((job["status"] == "timeout" if behavior == "timeout" else job["status"] == "exited"
                 and type(job["exit_code"]) is int and job["exit_code"] == (0 if behavior == "normal" else 2)), "smoke outcome mismatch")
        for name in ("smoke.json", "worker.job.json"):
            evidence[(root / name).relative_to(work).as_posix()] = digest((root / name).read_bytes())
    return evidence


def check(work):
    if __package__:
        from . import camera_original as camera
    else:
        import camera_original as camera
    meta = camera.validate(work)
    require(meta["format"] == FORMAT, "not an AB experiment")
    evidence = check_smoke(work, meta)
    gate = read(work / "pilot/complete.json")
    require(gate["status"] == "ready" and gate["rows"] == 12, "pilot incomplete")
    _, environment, hashes = read_series(work, "pilot", [r for r in order() if r["round"] == 1])
    evidence.update(hashes)
    rows, _, hashes = read_series(work, "measurement", order(), environment)
    evidence.update(hashes)
    result = judge(rows)
    for name in ("manifest.json", "experiment.json", "order.json", "safety-smoke/complete.json", "pilot/complete.json"):
        evidence[name] = digest((work / name).read_bytes())
    evidence["checker"] = digest(Path(__file__).read_bytes())
    return {"format": FORMAT, "experiment_sha256": meta["experiment_sha256"], "sources": meta["sources"], **result, "evidence": evidence}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", required=True, type=Path)
    args = parser.parse_args(argv)
    work = args.run.resolve(strict=True)
    try:
        result = check(work)
    except Exception as exc:
        result = {"format": FORMAT, "status": "incomplete",
                  "reasons": [str(exc) if isinstance(exc, ValueError) else type(exc).__name__]}
    with (work / "measurement/ab-verdict.json").open("x", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
    print("사전 고정한 실험 계약: " + {"passed": "통과", "not-passed": "미달", "incomplete": "미완료"}[result["status"]])
    for name, metric_ in result.get("metrics", {}).items():
        print(f"{name}: B={metric_['B_total']} T={metric_['T_total']} D={metric_['delta']} "
              f"hits={metric_['hits']}/1024 허용차={metric_['max_total_delta']}")
    for line in result.get("reasons", []) + result.get("notes", []):
        print(line)
    print("상세 근거: measurement/ab-verdict.json")
    return EXIT_CODES[result["status"]]


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"incomplete: {type(error).__name__}")
        raise SystemExit(2) from None
