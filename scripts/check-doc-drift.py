#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
check-doc-drift.py — vrchat-assistant 文档漂移检测 + 自动修复（固定脚本）

权威口径：core/mcp-definitions.js 中 name: '...' 的集合 = 实际 MCP 工具清单。

检查项（对应 vrchat-assistant-history skill Phase 2）：
  [FAIL] 工具清单完整    代码新增工具必须登记进 skills/vrc-monitor-agent/SKILL.md「MCP 工具」章节（2026-08-15 起权威登记位置；README 仅人类简介）
  [INFO] AGENTS.md 工具列举     提示哪些工具未在 AGENTS 出现（AGENTS 为采样列举，仅新增工具需核对）
  [FAIL] 工具总数数字残留        全仓库禁止"N 个 MCP 工具"表述（2026-08-14 拍板去数字）
  [FAIL] plugin.yaml 版本同步    hermes-plugin/plugin.yaml version 应 = package.json version
  [WARN] GitHub 仓库描述        描述不应含过时工具数（gh repo view；修复需 owner 权限，失败仅提示）
  [FAIL] 历史记录 PR 状态漂移    docs/history/ 中标注的 PR 状态（OPEN/待评审/已合并等）应与 gh 实际状态一致
  [FAIL] skill 工具引用死链       各 skill 文件中反引号包裹的工具名必须存在于 core/mcp-definitions.js
  [WARN] skills/ 目录一致性       README 提及的 skill 名应与 skills/ 实际子目录一致（新增漏登记/删除残留）

用法：
  python scripts/check-doc-drift.py             # 只检测，输出报告
  python scripts/check-doc-drift.py --fix       # 检测 + 自动修复（数字残留清除、plugin.yaml 版本同步）
  python scripts/check-doc-drift.py --json      # 输出 JSON 摘要（供 agent 解析）

退出码：0=无漂移 / 1=检测到漂移（含 INFO 级提示） / 2=执行错误（文件缺失等）
"""
import argparse
import json
import os
import re
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根（本脚本在 scripts/ 下）

# 需要扫数字残留的路径（相对仓库根；目录递归，文件单查）
NUMERIC_RESIDUE_TARGETS = [
    "README.md", "README.en.md", "README.ja.md", "AGENTS.md", "ARCHITECTURE.md",
    "core/", "skills/", "start-monitor.js", "hermes-plugin/",
]
# 数字残留正则：覆盖 skill 中的几种写法
NUMERIC_RE = re.compile(
    r"[0-9]+\s*个\s*(?:MCP\s*)?工具\s*|"
    r"MCP\s*工具（[0-9]+\s*个）\s*|"
    r"[0-9]+\s*个\s*MCP\s*工具\s*|"
    r"[0-9]+\s*MCP\s*tools",
    re.IGNORECASE,
)

def read_text(rel):
    """读文件，容忍编码问题。返回 str 或 None。"""
    path = os.path.join(REPO, rel)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read()

def extract_code_tools():
    """从 core/mcp-definitions.js 提取权威工具清单。"""
    src = read_text("core/mcp-definitions.js")
    if src is None:
        return None
    return set(re.findall(r"name:\s*'([a-z_]+)'", src))

def extract_doc_tools():
    """从权威工具登记文档提取已登记工具（反引号包裹的 snake_case 标识符）。

    2026-08-15 变更：锚点从 README「🔌 MCP 工具」迁到 skills/vrc-monitor-agent/SKILL.md
    「MCP 工具」章节——README 改为人类优先精简版，不再平铺工具清单；
    工具权威登记位置 = Agent Skill 的工具表格（Agent 实际照此调用）。
    注意：skill 章节内部的小节标题是 `### `（三级），结束于下一个 `## `（二级）标题。
    必须用 ^## 行首锚定 + MULTILINE，避免把 `### ` 的子串误判为章节边界。
    """
    skill = read_text("skills/vrc-monitor-agent/SKILL.md")
    if skill is None:
        return None
    m = re.search(r"^## MCP 工具.*?\n(.*?)^## ", skill, re.DOTALL | re.MULTILINE)
    section = m.group(1) if m else skill
    return set(re.findall(r"`([a-z_]+)`", section))

def scan_numeric_residue():
    """扫描数字残留，返回 [(相对路径, 行号, 匹配文本)]。"""
    hits = []
    for target in NUMERIC_RESIDUE_TARGETS:
        full = os.path.join(REPO, target)
        if os.path.isdir(full):
            for root, _dirs, files in os.walk(full):
                for fn in files:
                    if not fn.endswith((".md", ".js", ".py", ".yaml", ".yml", ".json")):
                        continue
                    _scan_file(os.path.relpath(os.path.join(root, fn), REPO), hits)
        elif os.path.isfile(full):
            _scan_file(target, hits)
    return hits

def _scan_file(rel, hits):
    try:
        with open(os.path.join(REPO, rel), "r", encoding="utf-8", errors="replace") as f:
            for i, line in enumerate(f, 1):
                if NUMERIC_RE.search(line):
                    hits.append((rel, i, line.strip()[:120]))
    except OSError:
        pass

def version_sync():
    """返回 (pkg_version, plugin_version) 或 None（文件缺失）。"""
    pkg = read_text("package.json")
    plugin = read_text("hermes-plugin/plugin.yaml")
    if pkg is None or plugin is None:
        return None
    try:
        pv = json.loads(pkg)["version"]
    except (json.JSONDecodeError, KeyError):
        pv = None
    m = re.search(r"^version:\s*(\S+)", plugin, re.M)
    plv = m.group(1) if m else None
    return (pv, plv)

def fix_numeric_residue():
    """清除数字残留。返回修改的文件数。"""
    fixed = 0
    for rel, _line, _text in scan_numeric_residue():
        path = os.path.join(REPO, rel)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            new_content = NUMERIC_RE.sub("", content)
            if new_content != content:
                with open(path, "w", encoding="utf-8", newline="") as f:
                    f.write(new_content)
                fixed += 1
        except OSError:
            continue
    return fixed

def fix_plugin_version():
    """把 plugin.yaml version 对齐 package.json。返回 True 表示已修改。"""
    pv, plv = version_sync()
    if not pv or plv == pv:
        return False
    path = os.path.join(REPO, "hermes-plugin", "plugin.yaml")
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()
    content = re.sub(r"^version:\s*\S+", f"version: {pv}", content, count=1, flags=re.M)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(content)
    return True

def gh_repo_description():
    """查 GitHub 仓库描述。返回 (desc, error)。gh 不可用或网络失败时 error 非空。"""
    try:
        r = subprocess.run(
            ["gh", "repo", "view", "ggg123124/vrchat-assistant", "--json", "description", "-q", ".description"],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            return None, r.stderr.strip() or "gh repo view failed"
        return r.stdout.strip(), None
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        return None, str(e)

def gh_all_pr_states():
    """一次拉取仓库全部 PR 的实际状态。返回 ({num: (state, mergedAt)}, error)。"""
    try:
        r = subprocess.run(
            ["gh", "pr", "list", "--state", "all", "--limit", "100",
             "--json", "number,state,mergedAt",
             "--jq", r'.[] | "\(.number)|\(.state)|\(.mergedAt // "")"'],
            capture_output=True, text=True, timeout=30,
        )
        if r.returncode != 0:
            return None, r.stderr.strip() or "gh pr list failed"
        states = {}
        for line in r.stdout.strip().splitlines():
            parts = line.split("|")
            if len(parts) == 3:
                try:
                    states[int(parts[0])] = (parts[1], parts[2])
                except ValueError:
                    pass
        return states, None
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError) as e:
        return None, str(e)

# 历史记录中的 PR 状态标注模式
# 1) 显式括号标注：`#30` (OPEN, 2026-08-14) 或 #30 (OPEN, 2026-08-14)（兼容反引号包裹）
# 2) 行内状态词：PR #30 ... 待评审 / 待审核 / 已合并 / 已合入 / 已关闭
PR_STATUS_RE = re.compile(
    r"#(\d+)[`\s]*\((OPEN|CLOSED|MERGED)[^)]*\)|"      # (OPEN/CLOSED/MERGED, date)
    r"PR\s*#(\d+)[^\n。]*?(待评审|待审核|待合并|已合并|已合入|已关闭)",  # 行内状态词
)

def extract_history_pr_refs():
    """解析 docs/history/*.md 中的 PR 引用与显式状态标注。

    返回 {pr_num: {"status": "OPEN"/"MERGED"/"CLOSED"/None, "mentions": [(相对路径, 行号, 摘录)]}}
    仅记录有显式状态标注的 PR；无标注的 PR（如发布记录里顺带提及）不入此表。
    """
    refs = {}
    hist_dir = os.path.join(REPO, "docs", "history")
    if not os.path.isdir(hist_dir):
        return refs
    for fn in sorted(os.listdir(hist_dir)):
        if not fn.endswith(".md") or fn == "INDEX.md":
            continue
        rel = os.path.join("docs", "history", fn)
        path = os.path.join(hist_dir, fn)
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for lineno, line in enumerate(f, 1):
                    for m in PR_STATUS_RE.finditer(line):
                        if m.group(1):  # 括号标注形式 #N (STATE, ...)
                            n = int(m.group(1))
                            st = m.group(2)
                        else:           # 行内状态词形式 PR #N ... 状态
                            n = int(m.group(3))
                            word = m.group(4)
                            st = "MERGED" if word in ("已合并", "已合入") else (
                                "CLOSED" if word == "已关闭" else "OPEN")
                        rec = refs.setdefault(n, {"status": None, "mentions": []})
                        # 多条标注时，OPEN 优先级最高（OPEN 最容易过时漏改）
                        if rec["status"] is None or st == "OPEN":
                            rec["status"] = st
                        rec["mentions"].append((rel, lineno, line.strip()[:120]))
        except OSError:
            continue
    return refs

def check_pr_status_drift(history_refs, actual_states):
    """对比历史记录标注状态 vs 实际状态。

    返回 [{pr, doc_status, actual_status, merged_at, mentions}]（仅不一致项）。
    标注 OPEN 但实际已 MERGED/CLOSED = 过时未改（最常见）；
    标注 MERGED/CLOSED 但实际 OPEN = 提前宣称（罕见，同样报）。
    """
    drifts = []
    for n, rec in history_refs.items():
        actual = actual_states.get(n)
        if actual is None:
            continue
        astate, merged_at = actual
        dstatus = rec["status"]
        if dstatus == "OPEN" and astate != "OPEN":
            drifts.append({"pr": n, "doc_status": dstatus, "actual_status": astate,
                           "merged_at": merged_at, "mentions": rec["mentions"]})
        elif dstatus in ("MERGED", "CLOSED") and astate != dstatus:
            drifts.append({"pr": n, "doc_status": dstatus, "actual_status": astate,
                           "merged_at": merged_at, "mentions": rec["mentions"]})
    return drifts

def check_skills_consistency(code_tools):
    """检查 skills/ 目录一致性（2026-08-15 新增）。

    三个子检查：
    1. skill 目录清单：列出 skills/ 下所有含 SKILL.md 的子目录（实际存在）
    2. README 提及的 skill 名 vs 实际目录：README 里提到的 skill 名称应与目录一致
       （README 漏登记新增 skill / README 提到已删除的 skill = 漂移）
    3. 各 skill 文件中的工具引用死链：skill 里反引号包裹的工具名必须存在于
       core/mcp-definitions.js（引用了不存在的工具 = 死引用，说明工具被删/改名后 skill 没同步）

    返回 {skills_dir, readme_mention_issues, dead_refs}，全部信息级，不置 has_drift。
    """
    result = {"skills_dir": [], "readme_mention_issues": [], "dead_refs": []}

    # 1. 实际 skill 目录
    skills_root = os.path.join(REPO, "skills")
    if os.path.isdir(skills_root):
        result["skills_dir"] = sorted(
            d for d in os.listdir(skills_root)
            if os.path.isdir(os.path.join(skills_root, d))
            and os.path.isfile(os.path.join(skills_root, d, "SKILL.md"))
        )

    # 2. README 提及的 skill 名（skills/<name> 或 `<name>` 紧邻 skills/ 的写法）
    readme = read_text("README.md") or ""
    readme_mentions = set(re.findall(r"skills/([a-z0-9-]+)", readme))
    readme_mentions |= set(re.findall(r"`([a-z0-9-]+)`[^`\n]*?skill", readme, re.IGNORECASE))
    # 反向：目录里有但 README 完全没提（新增 skill 漏登记）
    if result["skills_dir"]:
        mentioned = set(result["skills_dir"])
        for name in result["skills_dir"]:
            if name not in readme:
                result["readme_mention_issues"].append(
                    f"skills/{name} 目录存在但 README 未提及（新增 skill 漏登记？）")
        # README 提了但目录不存在
        for name in sorted(readme_mentions):
            if name not in result["skills_dir"]:
                result["readme_mention_issues"].append(
                    f"README 提及 skills/{name} 但目录不存在（已删除或拼写错误？）")

    # 3. 各 skill 文件中的工具引用死链
    # 只检测「工具表格行首」的标识符（`| \`tool_name\` |` 或 `| \`a\` / \`b\` |`）——那才是
    # 声称"这是工具"的位置；表格同行的字段名/参数名（cached/note/price 等）与正文说明不算。
    for name in result["skills_dir"]:
        skill_text = read_text(os.path.join("skills", name, "SKILL.md"))
        if not skill_text:
            continue
        refs = set()
        in_field_table = False
        for line in skill_text.splitlines():
            line = line.strip()
            if not line.startswith("|"):
                in_field_table = False
                continue
            # 分隔行（|---|---|）：表格内，保持当前表格状态
            if re.match(r"^\|[-:|\s]+\|$", line):
                continue
            # 表头感知（2026-08-17）：字段/参数说明表（表头「字段|说明」「参数|说明」等）不是工具表，
            # 行首反引号是字段名/参数名而非工具引用，整表跳过（案例：get_online_friends 返回
            # 字段表行首 `nickname` 被误判为死引用）；工具表表头「工具|说明」不受影响
            cells = [c.strip() for c in line.strip("|").split("|")]
            if len(cells) >= 2 and cells[0] in ("字段", "参数", "返回字段") and cells[1] in ("说明", "描述", "含义"):
                in_field_table = True
                continue
            if in_field_table:
                continue
            # 行首单元格：| `tool_a` | 或 | `tool_a` / `tool_b` | 或 | `tool_a`,`tool_b` |
            m = re.match(r"\| `([a-z_]+)`(?:\s*(?:/|,)\s*`([a-z_]+)`)*", line)
            if m:
                refs.add(m.group(1))
                for g in m.groups()[1:]:
                    if g:
                        refs.add(g)
        dead = sorted(t for t in refs if t not in code_tools)
        for t in dead:
            result["dead_refs"].append(f"skills/{name}/SKILL.md 引用了不存在的工具: {t}")

    return result

def main():
    ap = argparse.ArgumentParser(description="vrchat-assistant 文档漂移检测 + 自动修复")
    ap.add_argument("--fix", action="store_true", help="自动修复可确定性修复的漂移")
    ap.add_argument("--json", action="store_true", help="输出 JSON 摘要")
    args = ap.parse_args()

    code_tools = extract_code_tools()
    if code_tools is None:
        print("ERROR: core/mcp-definitions.js 不存在，无法检测", file=sys.stderr)
        return 2

    doc_tools = extract_doc_tools()
    if doc_tools is None:
        print("ERROR: README.md 不存在", file=sys.stderr)
        return 2

    # ── 检测 ──
    missing_readme = sorted(code_tools - doc_tools)
    agents = read_text("AGENTS.md") or ""
    agents_present = set(re.findall(r"[a-z_]+", agents))
    missing_agents = sorted(t for t in code_tools if t not in agents_present)
    numeric_hits = scan_numeric_residue()
    pkg_v, plugin_v = version_sync() if version_sync() else (None, None)
    version_ok = (pkg_v is not None and pkg_v == plugin_v)
    gh_desc, gh_err = gh_repo_description()
    gh_ok = True
    if gh_desc is not None:
        gh_ok = not NUMERIC_RE.search(gh_desc)

    # PR 状态漂移（历史记录标注状态 vs GitHub 实际状态）
    pr_states, pr_err = gh_all_pr_states()
    history_refs = extract_history_pr_refs()
    pr_drifts = check_pr_status_drift(history_refs, pr_states) if pr_states else []

    # skills/ 目录一致性（目录清单 / README 提及 / 工具引用死链）
    skills_check = check_skills_consistency(code_tools)

    # ── 修复 ──
    fixed_numeric = 0
    fixed_plugin = False
    if args.fix:
        fixed_numeric = fix_numeric_residue()
        fixed_plugin = fix_plugin_version()
        # 修复后重测
        missing_readme = sorted(code_tools - extract_doc_tools())
        numeric_hits = scan_numeric_residue()
        pkg_v, plugin_v = version_sync() if version_sync() else (None, None)
        version_ok = (pkg_v is not None and pkg_v == plugin_v)

    # ── 汇总 ──
    # 死引用 = skill 里引用了不存在的工具（FAIL 级）；README 提及不一致 = WARN 级（不算 has_drift）
    has_drift = bool(missing_readme or numeric_hits or not version_ok or pr_drifts
                     or skills_check["dead_refs"])
    # AGENTS 缺失仅 INFO（README 是完整权威清单；AGENTS 采样列举，只提示）
    report = {
        "code_tools_count": len(code_tools),
        "doc_tools_count": len(doc_tools & code_tools),
        "missing_in_readme": missing_readme,
        "missing_in_agents": missing_agents,
        "numeric_residue": [{"file": r, "line": l, "text": t} for r, l, t in numeric_hits],
        "plugin_yaml_version": plugin_v,
        "package_json_version": pkg_v,
        "version_in_sync": version_ok,
        "gh_description": gh_desc,
        "gh_check_ok": gh_ok,
        "gh_error": gh_err,
        "pr_status_drift": pr_drifts,
        "pr_status_check_error": pr_err,
        "skills_dir": skills_check["skills_dir"],
        "readme_skill_issues": skills_check["readme_mention_issues"],
        "skill_dead_refs": skills_check["dead_refs"],
        "has_drift": has_drift,
    }

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 1 if has_drift else 0

    print("=" * 60)
    print("vrchat-assistant 文档漂移检测（固定脚本 check-doc-drift.py）")
    print("=" * 60)
    print(f"权威工具数（core/mcp-definitions.js）: {len(code_tools)}")
    print(f"skill 工具清单已登记: {len(doc_tools & code_tools)}")
    if missing_readme:
        print(f"\n[FAIL] README 缺失 {len(missing_readme)} 个工具（需补进「🔌 MCP 工具」对应分组）:")
        for t in missing_readme:
            print(f"  - {t}")
    else:
        print("\n[OK] skill 工具清单完整")

    if missing_agents:
        print(f"\n[INFO] {len(missing_agents)} 个工具未在 AGENTS.md 出现（AGENTS 为采样列举，仅新增工具需核对补录）:")
        print("  " + ", ".join(missing_agents))
    else:
        print("\n[OK] AGENTS.md 工具覆盖无缺失")

    if numeric_hits:
        print(f"\n[FAIL] 发现 {len(numeric_hits)} 处工具总数数字残留（2026-08-14 拍板全仓库去数字）:")
        for rel, line, text in numeric_hits:
            print(f"  - {rel}:{line}  {text}")
    else:
        print("\n[OK] 无工具总数数字残留")

    if version_ok:
        print(f"\n[OK] plugin.yaml 版本同步（{plugin_v}）")
    else:
        print(f"\n[FAIL] plugin.yaml 版本 {plugin_v} ≠ package.json 版本 {pkg_v}（--fix 可自动对齐）")

    if gh_desc is not None:
        if gh_ok:
            print(f"\n[OK] GitHub 描述无过时工具数")
        else:
            print(f"\n[WARN] GitHub 描述可能含过时工具数: {gh_desc!r}")
            print("       （gh repo edit 需 owner 权限，nixi-agent 会 404 —— 请在 Phase 5 报告提醒用户手动改）")
    elif gh_err:
        print(f"\n[WARN] GitHub 描述检查跳过（{gh_err}）")

    if pr_drifts:
        print(f"\n[FAIL] 历史记录 PR 状态与实际 GitHub 状态不一致，共 {len(pr_drifts)} 处:")
        for d in pr_drifts:
            merged = d.get("merged_at") or ""
            merged_txt = f"（mergedAt {merged}）" if merged else ""
            print(f"  - PR #{d['pr']}: 历史记录标注「{d['doc_status']}」但实际「{d['actual_status']}」{merged_txt}")
            for rel, lineno, snippet in d["mentions"]:
                print(f"      {rel}:{lineno}  {snippet}")
        print("       （修复：把历史记录中该 PR 的状态标注改为实际状态；skill Phase 3 有说明）")
    elif pr_err:
        print(f"\n[WARN] 历史记录 PR 状态检查跳过（{pr_err}）")
    else:
        print("\n[OK] 历史记录 PR 状态与 GitHub 一致")

    # skills/ 目录一致性报告
    if skills_check["skills_dir"]:
        print(f"\n[INFO] skills/ 目录 {len(skills_check['skills_dir'])} 个 skill: " + ", ".join(skills_check["skills_dir"]))
    if skills_check["readme_mention_issues"]:
        print(f"\n[WARN] skills/ 目录与 README 提及不一致，共 {len(skills_check['readme_mention_issues'])} 处:")
        for msg in skills_check["readme_mention_issues"]:
            print(f"  - {msg}")
        print("       （新增 skill 需在 README「文档导航」登记；已删除 skill 需从 README 移除）")
    if skills_check["dead_refs"]:
        print(f"\n[FAIL] skill 文件引用了不存在的工具（死引用），共 {len(skills_check['dead_refs'])} 处:")
        for msg in skills_check["dead_refs"]:
            print(f"  - {msg}")
        print("       （工具被删除/改名后 skill 未同步；修复：更新 skill 中过时的工具名）")

    if args.fix:
        print(f"\n[FIX] 清除数字残留 {fixed_numeric} 处；plugin.yaml 版本{'已对齐' if fixed_plugin else '无需修改'}")

    print("\n" + ("结论: ✅ 无漂移，文档与现状一致" if not has_drift else "结论: ❌ 存在漂移（详见上方 [FAIL] 项）"))
    return 1 if has_drift else 0

if __name__ == "__main__":
    sys.exit(main())
