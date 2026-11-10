"""Secret operations have fixed errors and never log DPAPI input or exceptions."""
from hashlib import sha256

from . import comfy_team_key


class UsageError(Exception):
    def __init__(self, code: str, *, retry_after: int = 0):
        self.code = code
        self.retry_after = retry_after
        super().__init__(code)


def protect_key(value: str) -> str:
    try:
        return comfy_team_key.protect(value)
    except Exception:
        raise UsageError("protect_failed") from None


def load_key(config: dict) -> str:
    if not config.get("encrypted_key"):
        raise UsageError("key_none")
    try:
        value = comfy_team_key.unprotect(config["encrypted_key"])
        if not value:
            raise ValueError()
        return value
    except Exception:
        raise UsageError("key_undecryptable") from None


def hashed(value: str) -> str:
    return sha256(value.encode("utf-8")).hexdigest()[:16]


def public_key_state(config: dict) -> dict:
    state = "none"
    if config.get("encrypted_key"):
        try:
            load_key(config)
            state = "ok"
        except UsageError:
            state = "undecryptable"
    fields = ("revision", "enabled", "restore_paused", "registered_at_ms", "registered_by",
              "expires_on", "last_check_at_ms", "last_check_code")
    result = {key: config.get(key) for key in fields}
    result.update(state=state, registered=bool(config.get("encrypted_key")),
                  org_hash=hashed(config["org_id"]) if config.get("org_id") else None)
    return result
