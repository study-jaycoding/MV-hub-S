"""ComfyUI API 포맷 워크플로우 파싱 — 조절 가능한 파라미터/미디어 슬롯 감지.

animetic-enhancement 의 routers/workflow.py 순수 파싱 로직을 이식한 것.
차이: MV-hub-S 는 워크플로우를 전역 설정이 아니라 캔버스 Comfy 노드(씬 카드)에 저장하므로
config 의존을 걷어내고 exposed 집합을 인자로 받는다(stateless).

API 포맷 JSON = { "<node_id>": { class_type, _meta.title, inputs:{field: value} } } 평탄 객체.
input 값의 종류로 역할이 갈린다:
  - 스칼라(int/float/bool/str) = 조절 가능한 파라미터
  - [node_id, slot] 리스트        = 다른 노드 출력으로의 배선(조절 불가)
  - dict                          = 구조(제외)
"""
import re

IMAGE_CLASSES = {"LoadImage", "LoadImageMask"}
# 경로 입력형(절대경로 치환 가능) 영상 노드
VIDEO_PATH_CLASSES = {"VHS_LoadVideoPath"}
# 파일 선택형(ComfyUI input 폴더에 있어야 함) 영상 노드
VIDEO_FILE_CLASSES = {"VHS_LoadVideo", "LoadVideo"}
# 영상 노드에서 치환할 입력 필드 후보 (실제 JSON에 있는 것만 사용)
VIDEO_FIELD_CANDIDATES = ("video", "file", "path")

# Seedance(ByteDance) 계열 영상 노드의 조절 파라미터 — 실제 필드명은 평탄 점표기(model.ratio 등).
# class_type 이 노드마다 달라(api_seedance2_0_mini 등) exact 매칭이 자주 빗나가므로 _curated_spec 의 fallback 으로도 붙인다.
SEEDANCE_PARAMS = {
    "model": {"label": "Seedance 모델",
              "choices": ["Seedance 2.0", "Seedance 2.0 Fast", "Seedance 2.0 Mini"]},
    "model.ratio": {"label": "비율", "choices": ["16:9", "9:16", "1:1"]},
    "model.resolution": {"label": "화질", "choices": ["480p", "720p"]},
}

# 파라미터 팝업에 노출할 항목 큐레이션 — {class_type: {field: {label, choices}}}
# 새 워크플로우에서 다른 노드 값을 조절하고 싶으면 여기에 추가한다.
CURATED_PARAMS = {
    "ByteDance2ReferenceNode": SEEDANCE_PARAMS,
    "ImageBlur": {
        "blur_radius": {"label": "blur_radius"},
        "sigma": {"label": "sigma"},
    },
    "ImpactSwitch": {
        "select": {"label": "블러 스위치 (1=블러, 2=원본)", "choices": [1, 2]},
    },
}


def _curated_spec(class_type: str, field: str) -> dict:
    """이 필드의 큐레이션(label/choices) — exact class_type 우선, 없으면 Seedance/ByteDance 계열 fallback.
    class_type 이름이 노드마다 달라도(api_seedance2_0_mini 등) 드롭다운을 붙이기 위함."""
    exact = (CURATED_PARAMS.get(class_type) or {}).get(field)
    if exact:
        return exact
    if re.search(r"(seedance|bytedance)", str(class_type or ""), re.IGNORECASE):
        return SEEDANCE_PARAMS.get(field) or {}
    return {}


def _infer_type(val) -> str:
    return ("bool" if isinstance(val, bool)
            else "number" if isinstance(val, (int, float)) else "text")


def _field_entry(field: str, val, label=None, choices=None) -> dict:
    return {"field": field, "value": val, "type": _infer_type(val),
            "label": label or field, "choices": choices}


def _str_set(raw) -> set:
    """"node|field" 리스트 → 문자열 원소만 담은 set (malformed 방어)."""
    return {k for k in raw if isinstance(k, str)} if isinstance(raw, list) else set()


def _dict(v) -> dict:
    """dict 가 아니면 빈 dict (malformed 워크플로 방어 — inputs 가 list, _meta 가 문자열이어도
    .get()/.items() 에서 500 나지 않게)."""
    return v if isinstance(v, dict) else {}


def extract_combo_choices(object_info: dict, class_type: str) -> dict:
    """ComfyUI /object_info 응답에서 한 노드의 COMBO(드롭다운) 위젯 후보를 {field: [choices]} 로 뽑는다.
    위젯 스펙 형태: field -> [<type>, {opts}]. ComfyUI 는 두 가지 COMBO 표기를 쓴다:
      · 구형: 첫 원소가 후보 리스트.        예: ["resolution", [["1K","2K","4K"], {"default":"1K"}]]
      · 신형: 첫 원소가 "COMBO", 후보는 opts.options. 예: ["COMBO", {"options": ["480p","720p"]}]
    스칼라 타입("INT"/"STRING" 등, options 없음)이면 후보 없음(→ 텍스트/숫자 입력)."""
    node = _dict(_dict(object_info).get(class_type))
    inp = _dict(node.get("input"))
    out: dict = {}
    for section in ("required", "optional"):
        for field, spec in _dict(inp.get(section)).items():
            if not isinstance(spec, (list, tuple)) or not spec:
                continue
            choices = None
            if isinstance(spec[0], list):                          # 구형: 후보 리스트가 첫 원소
                choices = spec[0]
            elif len(spec) > 1 and isinstance(spec[1], dict):      # 신형: opts.options
                opts = spec[1].get("options")
                if isinstance(opts, list):
                    choices = opts
            if (choices and all(isinstance(x, (str, int, float)) and not isinstance(x, bool)
                                for x in choices)):
                out[field] = list(choices)
    return out


def detect_slots(wf: dict, exposed=None) -> dict:
    """API 포맷 JSON에서 이미지/영상 슬롯과 노출된 조절 파라미터를 감지한다.
    필드명은 추측하지 않고 실제 inputs에 존재하는 키만 대상으로 한다.
    exposed=노출 선택한 파라미터 집합("node|field", 체크한 것만). 없으면 params 는 빈 목록."""
    if not isinstance(wf, dict) or not wf:
        raise ValueError("빈 JSON")
    exposed = _str_set(exposed) if not isinstance(exposed, set) else exposed
    image_slots, video_slots, unknown_video_like = [], [], []

    for node_id, node in wf.items():
        if not isinstance(node, dict) or "class_type" not in node:
            # UI 포맷(nodes 배열)이면 여기 걸림
            raise ValueError(
                "API 포맷이 아닙니다. ComfyUI에서 'Export (API)'로 내보낸 JSON을 사용하세요."
            )
        ct = node["class_type"]
        inputs = _dict(node.get("inputs"))
        title = _dict(node.get("_meta")).get("title") or ct

        if ct in IMAGE_CLASSES:
            image_slots.append({
                "node_id": node_id, "title": title, "class_type": ct,
                "field": "image", "current": inputs.get("image"),
            })
        elif ct in VIDEO_PATH_CLASSES or ct in VIDEO_FILE_CLASSES:
            field = next((f for f in VIDEO_FIELD_CANDIDATES
                          if isinstance(inputs.get(f), str)), None)
            if field is None:
                raise ValueError(
                    f"영상 노드 {node_id}({ct})에서 치환할 문자열 입력을 찾지 못했습니다: "
                    f"{list(inputs.keys())}"
                )
            video_slots.append({
                "node_id": node_id, "title": title, "class_type": ct,
                "field": field, "current": inputs.get(field),
                "mode": "path" if ct in VIDEO_PATH_CLASSES else "file",
            })
        elif re.search(r"loadvideo|videoload", ct, re.IGNORECASE):
            # 모르는 커스텀 영상 노드 — 감지만 하고 사용자에게 알림
            unknown_video_like.append({"node_id": node_id, "class_type": ct,
                                       "inputs": list(inputs.keys())})

    # 이미지 슬롯을 "참조되는 소켓 번호" 순으로 정렬 (예: reference_images.image_1 을
    # 받는 노드가 1번). 이미지를 일부만 지정할 때 image_1 부터 채워지게 하기 위함.
    def socket_order(node_id: str):
        best = None
        for node in wf.values():
            for key, val in _dict(node.get("inputs")).items():
                if isinstance(val, list) and len(val) == 2 and str(val[0]) == node_id:
                    m = re.search(r"(\d+)\s*$", key)
                    if m:
                        n = int(m.group(1))
                        best = n if best is None else min(best, n)
        return best

    image_slots.sort(key=lambda s: (
        (order := socket_order(s["node_id"])) is None, order or 0, s["node_id"]))

    # 조절 가능한 파라미터: 사용자가 노출(체크)한 것만. CURATED 는 라벨/choices 만 제공.
    # 이미지/영상 슬롯 필드는 별도 처리하므로 파라미터에서 제외한다.
    slot_keys = {(s["node_id"], s["field"]) for s in (image_slots + video_slots)}
    params = []
    for node_id, node in wf.items():
        ct = node["class_type"]
        inputs = _dict(node.get("inputs"))
        fields = []
        for key, val in inputs.items():
            if (isinstance(val, (list, dict)) or (node_id, key) in slot_keys
                    or f"{node_id}|{key}" not in exposed):
                continue
            spec = _curated_spec(ct, key)
            fields.append(_field_entry(key, val, spec.get("label"), spec.get("choices")))
        if fields:
            params.append({
                "node_id": node_id,
                "title": _dict(node.get("_meta")).get("title") or ct,
                "fields": fields,
            })

    return {"image_slots": image_slots, "video_slots": video_slots,
            "unknown_video_like": unknown_video_like, "node_count": len(wf),
            "params": params}


def param_candidates(wf: dict, exposed=None) -> list:
    """노출 선택 UI 용 — 워크플로우의 조절 가능한 primitive 입력 후보 전체.
    슬롯 필드·링크(list)·구조(dict) 입력은 제외.
    curated=CURATED 에 라벨/choices 가 있는 필드(드롭다운 제공, 노출 강제 아님).
    exposed 로 각 후보의 현재 체크 여부를 표시."""
    exposed = _str_set(exposed) if not isinstance(exposed, set) else exposed
    slots = detect_slots(wf, exposed)
    slot_keys = {(s["node_id"], s["field"])
                 for s in (slots["image_slots"] + slots["video_slots"])}
    out = []
    for node_id, node in wf.items():
        ct = node["class_type"]
        title = _dict(node.get("_meta")).get("title") or ct
        for key, val in _dict(node.get("inputs")).items():
            if isinstance(val, (list, dict)) or (node_id, key) in slot_keys:
                continue  # 링크/구조/슬롯은 조절 대상 아님
            spec = _curated_spec(ct, key)
            out.append({
                "node_id": node_id, "class_type": ct, "title": title,
                "field": key, "value": val, "type": _infer_type(val),
                "label": spec.get("label") or key,
                "choices": spec.get("choices"),  # 드롭다운 후보(있으면)
                "curated": bool(spec),  # 라벨/드롭다운 제공(노출 강제 아님)
                "exposed": f"{node_id}|{key}" in exposed,
            })
    return out
