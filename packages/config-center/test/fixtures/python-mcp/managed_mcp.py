"""Local MCP fixture; records the interpreter used by uvx, never calls an LLM."""
import json
import os
import sys


def main():
    observation = os.environ.get("MCP_FIXTURE_OUTPUT")
    if observation:
        with open(observation, "w", encoding="utf-8") as file:
            json.dump({"python": sys.executable, "base": sys.base_prefix,
                       "cache": os.environ.get("UV_CACHE_DIR"),
                       "preference": os.environ.get("UV_PYTHON_PREFERENCE")}, file)
    for line in sys.stdin:
        message = json.loads(line)
        if "id" not in message:
            continue
        if message["method"] == "initialize":
            result = {"protocolVersion": message["params"]["protocolVersion"],
                      "capabilities": {"tools": {}},
                      "serverInfo": {"name": "managed-python-fixture", "version": "1.0.0"}}
        elif message["method"] == "tools/list":
            result = {"tools": [{"name": "runtime_info", "description": "Fixture runtime information",
                                 "inputSchema": {"type": "object", "properties": {}}}]}
        elif message["method"] == "tools/call":
            result = {"content": [{"type": "text", "text": "managed Python ready"}]}
        else:
            result = {}
        print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
