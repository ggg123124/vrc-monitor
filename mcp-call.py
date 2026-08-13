#!/usr/bin/env python3
"""MCP 调用辅助脚本: python mcp-call.py <tool> '<json args>'"""
import json, sys, urllib.request, re

def mcp_call(tool, args=None):
    if args is None:
        args = {}
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request("http://127.0.0.1:8799/mcp", data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        raw = resp.read().decode()
    # 解析 SSE: 取所有 data: 行并拼接
    texts = []
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            payload = line[5:].strip()
            try:
                d = json.loads(payload)
                content = d.get("result", {}).get("content", [])
                for c in content:
                    texts.append(c.get("text", ""))
            except json.JSONDecodeError:
                texts.append(payload)
    return "\n".join(texts)

if __name__ == "__main__":
    tool = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    result = mcp_call(tool, args)
    # 输出时尝试格式化 JSON
    try:
        parsed = json.loads(result)
        print(json.dumps(parsed, ensure_ascii=False, indent=1))
    except json.JSONDecodeError:
        print(result)
