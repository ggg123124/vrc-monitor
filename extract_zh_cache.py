#!/usr/bin/env python3
"""一次性工具：从 收藏世界分类表_中文.md 提取翻译缓存 (worldName, authorName) → 中文简介"""
import json, re, os

SRC = '收藏世界分类表_中文.md'
OUT = 'favorites_zh_cache.json'

if not os.path.exists(SRC):
    print(f'❌ {SRC} 不存在')
    exit(1)

cache = {}
with open(SRC, encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line.startswith('|') or '![图]' not in line:
            continue
        cols = [c.strip() for c in line.split('|')]
        # | # | 世界 | 作者 | 收藏 | 简介（中文） | 图片 |
        if len(cols) < 7:
            continue
        name = cols[2]
        author = cols[3]
        desc = cols[5]
        if name and desc and desc != '(无简介)':
            key = f'{name}||{author}'
            cache[key] = desc

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(cache, f, ensure_ascii=False, indent=1)
print(f'✅ 翻译缓存: {len(cache)} 条 → {OUT}')
