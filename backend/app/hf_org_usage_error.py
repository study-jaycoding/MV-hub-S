"""Shared usage errors without key, transport or repository dependencies."""


class UsageError(Exception):
    def __init__(self, code: str, *, retry_after: int = 0):
        self.code = code
        self.retry_after = retry_after
        super().__init__(code)
