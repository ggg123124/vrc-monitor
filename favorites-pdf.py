#!/usr/bin/env python3
"""
收藏世界 PDF 生成器（整合功能部件）
用法: python favorites-pdf.py [--out 收藏世界分类表.pdf] [--limit 500]

流程: 1) 调 MCP get_my_favorite_worlds 拉取收藏（服务须在 127.0.0.1:8799 运行）
      2) 中文简介: favorites_zh_cache.json 缓存优先，缺失回退原文
      3) 生成 Markdown 表格（按分类分组，收藏降序）
      4) 下载缩略图 → 压缩 → base64 内嵌 HTML
      5) Chrome headless 打印 PDF
依赖: 本机 Chrome（或 Edge）、PIL、markdown 库
"""
import json, sys, os, io, re, base64, subprocess, urllib.request

MCP_URL = 'http://127.0.0.1:8799/mcp'
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ZH_CACHE_FILE = os.path.join(BASE_DIR, 'favorites_zh_cache.json')
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36'
IMG_MAX_W = 320          # 缩略图压缩宽度
IMG_MAX_BYTES = 45 * 1024  # 单图内嵌上限 ~45KB
PAGE_MAX = 500           # 默认拉取上限

CATEGORY_RULES = [
    # 游戏（含运动/战斗/解谜/赛车/桌游/街机）
    (re.compile(r'game|ゲーム|fps|racing|race|puzzle|謎解き|udon|battle|対戦|action|アクション|card|カード|sports|スポーツ|tennis|テニス|golf|ボウリング|bowling|shooting|シューティング|mafia|人狼|quiz|クイズ|escape|脱出|parkour|パルクール|obstacle|アスレチック', re.I), '🎮 游戏'),
    # 恐怖（恐怖探索/解谜/精神污染/backroom）
    (re.compile(r'horror|怖|ホラー|backroom|creepy|不気味|暗い|廃墟|abandoned|サイコ|psycho|呪い|curse|幽霊|ghost|心霊|怪異', re.I), '👻 恐怖'),
    # 音乐（音乐欣赏/DJ/演唱会/舞池/音游/乐器）
    (re.compile(r'music|音楽|dj|ライブ|concert|dance|舞|song|曲|piano|ピアノ|guitar|ギター|instrument|楽器|beat|ビート|k歌|卡拉ok|カラオケ|club|クラブ|party|パーティー|live|sound|サウンド|visualizer', re.I), '🎵 音乐体验'),
    # 风景/观光（自然/城市/天空/海/山/星空/摄影胜地）
    (re.compile(r'景観|景色|scenic|view|観光|landscape|nature|自然|海|sea|ocean|空|sky|山|mountain|星|star|夜空|night sky|夕日|sunset|sunrise|桜|sakura|雪|snow|湖|lake|森|forest|wood|滝|waterfall|river|川|庭園|garden|park|公園|bridge|橋|街|city|town|urban|夜|night|雪景色|紅葉|autumn|花|flower|温泉|hot spring|島|island', re.I), '🌄 风景/观光'),
    # Avatar/模型（Avatar 世界/模型展示/改模/商店）
    (re.compile(r'avatar|アバター|model|展示|改模|店|shop|store|衣装|outfit|clothes|fashion|コスプレ|cosplay|mascot|マスコット|photo booth', re.I), '🧍 Avatar/模型'),
    # 社交/聚会（聊天/休息室/酒吧/咖啡/夜店/广场）
    (re.compile(r'social|hangout|集合|club|バー|居酒屋|cafe|カフェ|bar|飲み|drink|ラウンジ|lounge|plaza|広場|meet|交流|集会|nightclub', re.I), '🍻 社交/聚会'),
    # 休闲/睡觉（睡眠/放松/疗愈/发呆/ASMR）
    (re.compile(r'vrcsleep|睡眠|寝る|sleep|chill|チル|relax|リラックス|heal|癒し|癒|comfy|居心地|cozy|まったり|のんびり|休憩|rest|nap|asmr|安眠|sleeping', re.I), '😴 休闲/睡觉'),
    # 拍照（摄影/相机/取景）
    (re.compile(r'photo|写真|撮影|カメラ|camera|photography|グラビア', re.I), '📷 拍照'),
]


def mcp_call(tool, args=None):
    """调 MCP 工具（JSON-RPC over HTTP）"""
    if args is None:
        args = {}
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': tool, 'arguments': args}}).encode()
    req = urllib.request.Request(MCP_URL, data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=280) as r:
        raw = r.read().decode()
    for line in raw.splitlines():
        if line.startswith('data:'):
            d = json.loads(line[5:].strip())
            for c in d.get('result', {}).get('content', []):
                if c.get('type') == 'text':
                    return json.loads(c['text'])
    raise RuntimeError('MCP 返回异常')


def load_zh_cache():
    """加载翻译缓存: {name||author: 中文简介}"""
    try:
        with open(ZH_CACHE_FILE, encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}


def classify(w):
    hay = f"{w.get('worldName','')} {(w.get('description','') or '')[:200]} {' '.join(w.get('tags', []) or [])}"
    for re_, cat in CATEGORY_RULES:
        if re_.search(hay):
            return cat
    return '其他'


def fetch_and_build(limit):
    """拉取收藏并按分类分组"""
    print('⏳ 拉取收藏世界...')
    data = mcp_call('get_my_favorite_worlds', {'limit': limit})
    worlds = data.get('worlds', [])
    print(f'  ✅ 收藏 {len(worlds)} 个 | 分类 {len(data.get("categories", []))} 类')
    for w in worlds:
        w['category'] = classify(w)
    cats = {}
    order = []
    for w in worlds:
        c = w['category']
        if c not in cats:
            cats[c] = []
            order.append(c)
        cats[c].append(w)
    for c in order:
        cats[c].sort(key=lambda x: x.get('favorites', 0), reverse=True)
    return cats, order


def build_markdown(cats, order, zh_cache):
    """生成 Markdown（中文简介优先）"""
    lines = [f"# 🗂️ 我的 VRChat 收藏世界分类（共 {sum(len(v) for v in cats.values())} 个 · 中文简介）", ""]
    for cat in order:
        lst = cats[cat]
        lines.append(f"## {cat}（{len(lst)} 个）")
        lines.append("")
        lines.append("| # | 世界 | 作者 | 收藏 | 简介（中文） | 图片 |")
        lines.append("|---|------|------|-----:|------|------|")
        for i, w in enumerate(lst, 1):
            name = (w.get('worldName', '') or '')[:40]
            author = (w.get('authorName', '') or '')[:15]
            fav = f"{w.get('favorites', 0):,}"
            key = f'{name}||{author}'
            desc = zh_cache.get(key) or (w.get('description', '') or '').replace('\n', ' ')[:60] or '(无简介)'
            img = w.get('imageUrl') or ''
            if img:
                lines.append(f"| {i} | {name} | {author} | {fav} | {desc} | ![图]({img}) |")
            else:
                lines.append(f"| {i} | {name} | {author} | {fav} | {desc} | (无) |")
        lines.append("")
    return '\n'.join(lines)


def images_to_base64(md_text):
    """下载 md 中所有图片 → 压缩 → base64 替换（带本地缓存 img_cache/）"""
    import markdown
    urls = re.findall(r'!\[图\]\((https?://[^)]+)\)', md_text)
    cache_dir = os.path.join(BASE_DIR, 'img_cache')
    os.makedirs(cache_dir, exist_ok=True)
    print(f'⏳ 处理 {len(urls)} 张图片（缓存目录 img_cache/）...')
    enc_map = {}
    done = 0
    cached_hits = 0
    for i, url in enumerate(urls):
        if url in enc_map:
            continue
        # 缓存文件名 = URL 的 md5
        import hashlib
        h = hashlib.md5(url.encode()).hexdigest()
        cache_path = os.path.join(cache_dir, f'{h}.b64')
        if os.path.exists(cache_path):
            with open(cache_path, encoding='utf-8') as f:
                enc_map[url] = f.read()
            cached_hits += 1
            done += 1
            continue
        try:
            data = download_img(url)
            b64 = compress_img(data)
            with open(cache_path, 'w', encoding='utf-8') as f:
                f.write(b64)
            enc_map[url] = b64
            done += 1
            if done % 50 == 0:
                print(f'  {done}/{len(urls)}...')
        except Exception as e:
            enc_map[url] = None
    # 替换 md 为 data URI
    for url, b64 in enc_map.items():
        if b64:
            md_text = md_text.replace(f'![图]({url})', f'![图](data:image/jpeg;base64,{b64})')
        else:
            md_text = md_text.replace(f'![图]({url})', '(图加载失败)')
    print(f'  ✅ 图片处理完成 ({done} 张，缓存命中 {cached_hits}，新下载 {done - cached_hits})')
    return md_text


def download_img(url, timeout=20):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def compress_img(data):
    """PIL 压缩: 限宽 + JPEG 质量迭代，控制在 ~45KB"""
    from PIL import Image
    img = Image.open(io.BytesIO(data))
    if img.mode in ('RGBA', 'P'):
        img = img.convert('RGB')
    ratio = IMG_MAX_W / img.width
    if ratio < 1:
        img = img.resize((IMG_MAX_W, int(img.height * ratio)), Image.LANCZOS)
    quality = 72
    while quality >= 30:
        buf = io.BytesIO()
        img.save(buf, 'JPEG', quality=quality)
        if buf.tell() <= IMG_MAX_BYTES:
            break
        quality -= 12
    return base64.b64encode(buf.getvalue()).decode()


def html_from_md(md_text, title):
    import markdown
    body = markdown.markdown(md_text, extensions=['tables'])
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body {{ font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif; margin: 32px; color: #222; }}
  h1 {{ color: #1a5276; border-bottom: 3px solid #1a5276; padding-bottom: 8px; }}
  h2 {{ color: #2c3e50; margin-top: 28px; border-left: 5px solid #3498db; padding-left: 10px; }}
  table {{ border-collapse: collapse; width: 100%; font-size: 11px; margin: 10px 0 20px; }}
  th, td {{ border: 1px solid #bdc3c7; padding: 5px 7px; text-align: left; vertical-align: middle; }}
  th {{ background: #ecf0f1; font-weight: bold; }}
  tr:nth-child(even) {{ background: #fafafa; }}
  img {{ max-width: 110px; max-height: 70px; border-radius: 4px; }}
  code {{ background: #f4f4f4; padding: 1px 4px; border-radius: 3px; }}
</style></head><body>{body}</body></html>"""


def find_chrome():
    for p in (CHROME, EDGE):
        if os.path.exists(p):
            return p
    # 环境变量兜底
    for var in ('CHROME_PATH', 'EDGE_PATH'):
        p = os.environ.get(var)
        if p and os.path.exists(p):
            return p
    raise RuntimeError('未找到 Chrome/Edge，请安装或设置 CHROME_PATH')


def main():
    out_pdf = '收藏世界分类表.pdf'
    limit = PAGE_MAX
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == '--out' and i + 1 < len(args):
            out_pdf = args[i + 1]; i += 2
        elif args[i] == '--limit' and i + 1 < len(args):
            limit = int(args[i + 1]); i += 2
        else:
            i += 1

    zh_cache = load_zh_cache()
    cats, order = fetch_and_build(limit)
    md_text = build_markdown(cats, order, zh_cache)
    md_text = images_to_base64(md_text)
    html = html_from_md(md_text, '收藏世界分类')
    html_path = out_pdf.rsplit('.', 1)[0] + '_tmp.html'
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)

    chrome = find_chrome()
    pdf_path = os.path.abspath(out_pdf)
    html_abs = os.path.abspath(html_path)
    print(f'⏳ Chrome 打印 PDF...')
    subprocess.run([chrome, '--headless', '--disable-gpu', '--no-sandbox',
                    f'--print-to-pdf={pdf_path}', '--print-to-pdf-no-header',
                    f'file:///{html_abs.replace(chr(92), "/")}'],
                   capture_output=True, timeout=180)
    os.remove(html_path)
    size_mb = os.path.getsize(pdf_path) / 1024 / 1024
    print(f'✅ 完成: {pdf_path} ({size_mb:.1f}MB)')


if __name__ == '__main__':
    main()
