"""Import-time shared-server defaults without repository dependencies."""
from __future__ import annotations

import os


K_URL = "shared_server_url"
DEFAULT_SHARED_URL = (os.environ.get("CONTENT_HUB_SHARED_URL") or "http://192.168.1.171:8010").rstrip("/")
