---
name: vrchat-world-queries
description: "VRChat world: new worlds, recommend, lore, X creators."
version: 1.0.0
metadata:
  hermes:
    tags: [vrchat, gaming, worlds, queries, lore]
    related_skills: [vrc-monitor-agent, vrchat-social-queries]
---

# VRChat 世界域 — 挑世界/推荐/情报挖掘/X 博主

本 skill 覆盖 **vrc-monitor 的世界域**：挑新世界、待逛列表（backlog）、世界推荐、PlanetVRC 检索、世界情报/彩蛋/攻略挖掘、X 博主世界推荐，以及地图列表展示格式。

> ⚠️ **工具表唯一权威在 vrc-monitor-agent skill**。本 skill 只写工作流与域内细节，不复制工具表。通用 MCP 调用陷阱见 vrc-monitor-agent「常见陷阱」。
> MCP 端点：`http://127.0.0.1:8799/mcp`；**开图用 open_world 的完整参数/回退语义见 vrchat-social-queries §11.4**（跨域指针，本域只记调用行）。

## 1. 挑新世界（「没去过的 + 适合聊天的」）

用户说「挑个新世界 / 没去过的 / 适合聊天」时，四步：

1. **拉候选**：`get_new_worlds {onlyUnvisited: true, limit: 50, sortBy: 'favorites'}` → 未逛新世界按收藏降序（⚠️ 字段名 `worldName` 不是 `name`；limit 上限 50，不够可翻页/换 sortBy）
2. **按名粗筛**：剔除明显的游戏图（名字含 Game/战斗/恐怖/Roleplay/赌场等），留氛围向（神殿/旅馆/月亮/安静小屋/咖啡厅）
3. **补简介**：候选逐个 `get_world_name {worldId}` 拿 description + capacity 判断聊天氛围
4. **开图**：用户拍板后调 MCP `open_world {worldId, type:'hidden', region:'jp'}` → 自动建 jp 隐藏房；管道直发优先、不可用静默回退 API 邀请（响应 `method: "api"` = 回退态，非失败）

**用户偏好（通用建议）**：给 3-5 个候选表格（名称/人气/在线/氛围一句话）让用户选；用户说「随机挑一个」用 `random.choice`；用户说「去过某个」就跳过继续推。

**数据坑**：
- **`get_new_worlds` 的 favorites 是扫描时快照，会迅速过期**——展示人气时对候选逐个 `get_world_name` 刷新（缓存命中快），别直接用扫描值
- **`visited` 标记可能不可靠**：`get_new_worlds {onlyUnvisited:true}` 仍可能返回逛过的世界——排除已逛世界时交叉核对 `get_world_name` 返回的 `note` 字段（逛过的世界常留了 note）
- **主题化挑世界（睡觉/聊天/氛围等）**：`search_worlds` 用日英关键词效果很好（如 `おやすみ`/`sleep`）——主题关键词走 API 可靠（区别于中文世界名搜索的坑）

### 世界待逛列表（backlog）

用户说「把这张图加进待逛/待办」时走 3 工具：

- `add_to_backlog {worldId, reason?, priority?}` — 加入待逛列表（本地待办，不动云端收藏；幂等，priority 0-2；世界不在 world_kb 时插兜底行）
- `get_backlog {status? (pending|visited|all 默认 pending), sortBy? (added_at|priority|favorites 默认 added_at), limit?}` — 查看待逛列表；**逛完自动从未逛区消失**（visited 后 pending 不再显示，记录保留在 visited 历史）
- `remove_from_backlog {worldId}` — 移出待逛列表（只清 backlog 标记，保留行，幂等）

## 2. 世界推荐 recommend_worlds

`recommend_worlds`：多源融合（本地新世界池 × PlanetVRC × 官方主题搜索 × 用户反馈）+ 本地状态感知（visited/sleep_ok/note）+ 可解释 reasons 数组 + 一键 open_world 闭环。

- 参数：`theme` / `excludeTheme` / `sources` / `excludeVisited`
- 评分模型：热度 + 新鲜度 + 主题 + 作者画像（30 天窗口熟客）
- 输出带 `reasons`（如 `熟悉度39 + 黄金区63% + group+3` 粒度）
- 用户反馈工具：`rate_world {worldId, rating: 1|-1|0}`（好图加权/烂图降权）、`mark_world_visited {worldId}`（事件驱动 visited 会漏记，开图闭环手动确认）、`favorite_world {worldId, group?}`（云端收藏，tags 必须映射 worldsN 分组，写操作需确认）

**作者维度**：作者画像按 `author_id` 聚合（个人偏好 > 圈层热度 > 纯热度，3:1:1 起步），⚠️ **必须用 author_id 匹配不用 author_name**（作者可改名）。

### 按作者列出全部图（get_worlds_by_author）

用户说「把这个作者的全部图找出来 / 全部加权重」时：

1. `get_world_name {worldId, forceRefresh: true}` → 拿当前图 `authorId`（⚠️ 缓存命中的旧行可能无 authorId，用 forceRefresh 走 API 才拿全）
2. `get_worlds_by_author {authorId}` → 列出该作者全部图（worldId/名称/收藏/浏览/容量/标签/发布时间，顺带写 world_cache 含 author_id）；也可直接传 `authorName` 内部经 `/users` 解析
3. 批量操作：遍历 `worlds` 逐个 `rate_world {worldId, rating}` 加权重，或展示给用户选

⚠️ 用 `authorId` 匹配不用 `author_name`（作者可改名）；`limit` 默认 100（「最多 100 张」，不是必然全量），作者图多时显式调大（上限 500）。

## 3. PlanetVRC 地图检索

`search_planet_worlds` / `recommend_planet_worlds`：planetvrchat.net 日文世界目录，适合 VRChat API 搜不到的日文/小众图。

- `search_planet_worlds {query}`：关键词搜索 → 世界名/wrld_id/平台/分类/收藏数；limit 最大 8（每个结果抓详情页补 wrld_id，约 1-2s/个）
- `recommend_planet_worlds {sort}`：sort=popular（访问者数最多）/ new / updated → 世界+wrld_id+最大人数+访问量+收藏数+公开日
- ⚠️ 返回字段是 **`wrldId`**（驼峰）不是 `wrld_id`——反查详情时写错键拿 None（实测踩坑）

## 4. 世界情报/彩蛋/攻略挖掘

用户在世界里发现可疑元素（电话亭/神秘符号/隐藏区域）说"帮我搜一下这图的秘密/攻略"时，**三源组合拳**：

1. **PlanetVRC 收录页**：`https://planetvrchat.net/archives/{postId}`（postId 来自 `recommend_planet_worlds`）——页面**自带 AI 摘要**，常直接点破地图设定，还带作者/分类/发布日/访客收藏数
2. **DuckDuckGo HTML 版**：`https://html.duckduckgo.com/html/?q=<关键词>`——国内直连稳定，正则解析 `result__a`/`result__snippet`；**X 博主的实况介绍推文常被索引**
3. **X oEmbed API**：`https://publish.twitter.com/oembed?url=https://x.com/<user>/status/<id>`——**免登录拿推文完整文本**（`html` 字段剥标签即正文）

**已验证的坑**：
- ❌ Bing 搜索结果页反爬；`r.jina.ai` 渲染代理 403；**X 搜索页面=登录墙**：未登录返回 200 但内容全空——**X 不登录不给任何搜索结果**；要搜 X 必须登录态 cookie（见下文方案）
- **攻略现状判断**：搜"XX 攻略/解け/見つけた"看有没有人公开解出——没人解出就明说"全网暂无攻略，可能是前几个解开的人"
- **解谜进展闭环**：用户每发现一个机关/交互，持续 `set_world_note` 追加到该世界 note（note 即探索笔记，下次带人/续解直接翻）

**调查方法论（可复用）**：
- **作者 X 账号定位（最可靠）**：官方 API `GET /users/{authorId}` 的 **`bioLinks` 数组直接给作者 X/Twitter 链接**，比搜索可靠
- **"哪些博主推过这个图"最快入口 = `x_world_recommendations` 表**：sqlite 按 world_id 或 world_name LIKE 反查，creators JSON 数组带推文 ID/链接
- **推文全文+配图三件套**：oEmbed 拿正文；x.com 单推文页 `og:description` 拿完整正文 + `og:image` 拿配图直链（pbs.twimg.com，下载带 Referer + 代理）
- **X 视频直链提取**：x.com 状态页 HTML 内嵌 JSON 里的 `video.twimg.com/.../*.mp4` 多分辨率直链，正则提取，代理下载
- ⚠️ **用户偏好（通用建议）**：视频/实况素材**不要自己抽帧分析**，直接把视频文件发用户自己看；用户催"先给我链接"时，先发链接/文件再补文字分析
- ⚠️ **世界 ID 反查坑**：用户说"昨天玩的那张图"，按名字 LIKE 会混入无关世界（名字含 Archive/Arch 的搜索工具图）——**先用 `note` 字段反查最可靠**（逛过的世界 note 里有正确 worldId）
- **vrcmap 世界档案站**（`vrcmap.com/world/{worldId}`，代理可达）：世界简介 + 收藏/访问排名 + **作者全部作品列表**（⚠️ 现可直接用 `get_worlds_by_author` 拉作者全部作品，见 §2 作者维度）
- **YouTube 实况搜索**：`youtube.com/results?search_query=<世界名+作者>` 提取 videoId；⚠️ 评论区可能关闭（yt-dlp 返回 0 条 ≠ 失败），别反复重试

**X 搜索登录态（cookie→API 直连方案）**：
- ⚠️ **不要用 computer_use 逐元素点浏览器**——用浏览器 cookie 插件（Cookie-Editor 等）复制登录 cookie，agent 直调平台 API
- 需要 `auth_token` + `ct0`（其余 twid/kdt/lang 更稳），请求头 `x-csrf-token: <ct0>` + Cookie 串，直调 X 搜索 API（GraphQL SearchTimeline 或 `search/adaptive.json`）
- ⚠️ guest token 方案已死（`api.twitter.com/1.1/guest/activate.json` 返回 401）；Nitter `/search/rss` 搜索端点不可用——必须登录态 cookie

## 5. X 博主世界推荐（x_world_digest / x_add_creator 系列）

用户说"关注推特上 XX 博主/添加推荐博主"时：

1. **添加**：`x_add_creator {screen_name, name}`——screen_name 是 X 用户名**不带 @**；name 是展示名（可中文/日文，MSYS curl 发中文会乱码，**必须 Python urllib 直发**）。博主清单存 DB config 表 `x_creators`（JSON 数组），添加即时生效无需重启
2. **验证 handle**：`fetchCreatorRss(screenName)`（`core/fetch-x-worlds.js`，需要代理 env）确认 RSS 可抓
3. **抓取网络前提**：Nitter RSS 国内**直连不通**，必须代理（`VRC_MONITOR_HTTP_PROXY`/`HTTPS_PROXY` env；代理关时自动回退直连）。改 env 后**必须重启服务**才生效
4. **扫描**：`x_scan_creators` 抓全部博主推文→提取世界链接→逐个查 VRChat API 收藏/浏览入库（限流 ~2.6s/个）。**⚠️ 数十个世界要几分钟，MCP 客户端会超时但服务端照常跑完**——超时后等几分钟直接查 `x_world_recommendations` 表验证，别重发
5. **查询**：`x_world_digest {days, limit, creator?, refresh?}` 按收藏排序输出，`favoriteVisitRatio ≥ highlightRatio(默认0.2)` 标 ⭐重点。未配置博主（x_creators=[]）返回空 worlds 不是故障

## 6. 地图列表展示格式（通用推荐）

展示地图列表时按此格式（6 列）：

```
| 序号 | 封面 | 地图名称 | 热度 | 备注 | 地图链接 |
```

- **序号**：列表最前方，从 1 递增
- **封面**：`imageUrl`，Markdown 内嵌 `![短名](url)`
- **热度**：取 `heat` 中优先级最高的非零字段（officialFavorites > occupants > planetVisitors），格式 `<icon><数值><单位>`：🔴≥100万 / 🔵≥1万 / ⚪<1万；数值≥1万缩略为「万」（保留 1 位小数），<1万显示原数
- **备注**：`note`（用户备注，无则省略该列）
- **地图链接**：`https://vrchat.com/home/world/{worldId}`
- **封面列省略规则**：封面无数据 或 QQ Bot 场景（QQ 消息无法渲染外链图片）时省略封面列，其余列不变

### chill/放松向地图推荐过滤规则（2026-08-15 用户修正）

用户要「chill 的室内图」时：
- **排除**随机聊天/轮盘配对社交向（如 No Time Two Talk、omegle 式 roulette、大型交流广场）——主题是 social/chat 的不算 chill
- **聚焦** sleep/onsen/温泉/居家/小憩系，看 author_tag 含 chill/sleep/relax/spa/onsen 的图
- 备注列标注**当前人数**（occupants/capacity）——爆满（occupants > capacity 或接近满）的图即使主题 chill 也要提示人多，chill 推荐优先人少的
- 候选补热度：recommend_worlds 输出的 heat 常为 0，用 get_world_name(worldId) 逐个补查 favorites 再按展示格式输出

## 7. 域内陷阱

### 世界改名 → 缓存陈旧

VRChat 世界**可以改名**，`world_cache` 里的旧名会一直赖着（cache-first 永不刷新）。**策略（2026-08-09 改懒刷新）**：去掉 TTL，缓存命中直接返回，只有 `forceRefresh: true` 才走 API（配合 `get_world_history` 手动刷新时变化一目了然）。

**排查流程（用户否认世界名时）**：不要争论，直接 API 验证：

```bash
COOKIE=$(tr -d '\r\n' < <项目目录>/auth_cookie.txt)
curl -s -m 15 "https://api.vrchat.cloud/api/1/worlds/<worldId>" \
  -H "Cookie: auth=$COOKIE" \
  -H "User-Agent: <你的UA>"   # ⚠️ 必须带 UA，否则 WAF 403
```

看 `name` + `updated_at`：`updated_at` 在今天 = 刚改过名。手动修复：`get_world_name` 带 `forceRefresh: true`。
