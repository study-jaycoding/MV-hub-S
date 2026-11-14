"""Restore generation (share_db_generation) read and write gate — a leaf with no repo imports.

share_commands re-exports these names; scene_notebook and the other 1C-1 write paths import them from here
so they do not pull share → identity back into an import cycle.
"""


def database_generation(conn):
    row = conn.execute("SELECT value FROM app_setting WHERE key='share_db_generation'").fetchone()
    return row[0] if row else None


class RestoreGenerationConflict(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def require_restore_generation(conn, supplied):
    current = database_generation(conn)
    if not isinstance(current, str) or not current or len(current) > 200:
        raise RuntimeError('restore generation is unavailable')
    if supplied is None:
        raise RestoreGenerationConflict('restore_generation_required')
    if supplied != current:
        raise RestoreGenerationConflict('restore_generation_changed')
    return current
