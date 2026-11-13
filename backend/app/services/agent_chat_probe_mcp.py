"""Codex 연결 점검 전용 stdio MCP. MV 권한 없이 nonce만 돌려준다(표준 라이브러리)."""
import json
import sys


def reply(request: dict, nonce: str) -> dict | None:
    if "id" not in request:
        return None
    method = request.get("method")
    result = None
    if method == "initialize":
        result = {"protocolVersion": request.get("params", {}).get("protocolVersion", "2024-11-05"),
                  "capabilities": {"tools": {}, "resources": {}}, "serverInfo": {"name": "MV Hub connection check", "version": "1"}}
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": [{"name": "check_connection", "description": "Return the connection check text",
                             "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False}}]}
    elif method == "tools/call" and request.get("params", {}).get("name") == "check_connection":
        result = {"content": [{"type": "text", "text": nonce}], "isError": False}
    elif method == "resources/list":
        result = {"resources": []}
    elif method == "resources/templates/list":
        result = {"resourceTemplates": []}
    response = {"jsonrpc": "2.0", "id": request["id"]}
    if result is None:
        response["error"] = {"code": -32601, "message": "Method or tool not found"}
    else:
        response["result"] = result
    return response


def main() -> None:
    nonce = sys.argv[1]
    for line in sys.stdin.buffer:
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("Invalid request")
            response = reply(request, nonce)
        except (ValueError, TypeError, AttributeError):
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Invalid JSON-RPC request"}}
        if response is not None:
            sys.stdout.buffer.write((json.dumps(response) + "\n").encode("utf-8"))
            sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
