"""Minimal stdio MCP server for transport tests: one JSON-RPC message
per line on stdin, one response per line on stdout.

Pass --fail-init on the command line to make the initialize exchange
return a JSON-RPC error instead of a successful result; used to test
subprocess cleanup on init failure."""
import json
import sys

FAIL_INIT = "--fail-init" in sys.argv

for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("id") is None:       # notification
        continue
    if msg["method"] == "initialize":
        if FAIL_INIT:
            sys.stdout.write(json.dumps(
                {"jsonrpc": "2.0", "id": msg["id"],
                 "error": {"code": -32099, "message": "init failure sentinel"}}) + "\n")
            sys.stdout.flush()
            continue
        result = {"protocolVersion": "2025-03-26",
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "fake-stdio", "version": "0"},
                  "instructions": (
                      "Fake build123d MCP instructions: read quickref, "
                      "show named parts, render before export."
                  )}
    elif msg["method"] == "tools/list":
        result = {"tools": [{"name": "make_box", "description": "box",
                             "inputSchema": {"type": "object"}}]}
    elif msg["method"] == "resources/list":
        result = {"resources": [{
            "uri": "build123d://quickref",
            "name": "quickref",
            "mimeType": "text/plain",
            "description": "build123d quick reference",
        }]}
    elif msg["method"] == "resources/templates/list":
        result = {"resourceTemplates": [{
            "uriTemplate": "build123d://docs/{topic}",
            "name": "docs",
            "mimeType": "text/plain",
        }]}
    elif msg["method"] == "resources/read":
        result = {"contents": [{
            "uri": msg["params"]["uri"],
            "mimeType": "text/plain",
            "text": "quick reference text",
        }]}
    elif msg["method"] == "tools/call" and msg["params"]["name"] == "fail":
        sys.stdout.write(json.dumps(
            {"jsonrpc": "2.0", "id": msg["id"],
             "error": {"code": -32000, "message": "stdio boom"}}) + "\n")
        sys.stdout.flush()
        continue
    else:
        result = {"content": [{"type": "text", "text": "ok"}], "isError": False}
    sys.stdout.write(json.dumps(
        {"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
    sys.stdout.flush()
