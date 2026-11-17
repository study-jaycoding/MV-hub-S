"""Seedance Draft의 일반 재사용과 원본 작업 완성을 구분하는 순수 규칙."""

class DraftFinishConflict(ValueError):
    def __init__(self, generation_id: str, resolution: str = "1080p"):
        self.generation_id = generation_id
        super().__init__(f"진행 또는 확인 중인 Draft {resolution} 요청이 있습니다. 기존 생성 ID: {generation_id}")


def fresh_params(model: str | None, params: dict | None) -> dict:
    result = dict(params or {})
    result.pop("draft_job_id", None)
    if model == "seedance_2_5" and result.get("resolution") == "480p":
        result["draft"] = True
    else:
        result.pop("draft", None)
    return result


def finish_params(generation: dict, resolution: str = "1080p") -> dict:
    if resolution not in ("1080p", "4k"):
        raise ValueError("Draft 완성 화질은 1080p 또는 4k여야 합니다")
    params = generation.get("params") or {}
    job_id = generation.get("job_id")
    if (
        generation.get("model") != "seedance_2_5"
        or generation.get("status") != "done"
        or not isinstance(params, dict)
        or params.get("draft") is not True
        or params.get("draft_job_id")
        or not isinstance(job_id, str)
        or not job_id.strip()
        or generation.get("deleted")
        or generation.get("deleted_at")
    ):
        raise ValueError("원격 작업 번호가 확인된 완료 Draft만 고화질로 생성할 수 있습니다")
    return {**params, "resolution": resolution, "draft": False, "draft_job_id": job_id}
