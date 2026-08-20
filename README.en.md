# VRChat Assistant (vrchat-assistant)

> Monitor your VRChat friends in real time, and let AI handle socializing, world discovery, media management, and recommendations for you.
> Stack: Node.js + SQLite + WebSocket + MCP

**[中文](./README.md) | English | [日本語](./README.ja.md)**

---

## What is this?

A **persistent background service** that connects to VRChat's WebSocket to capture your friends' online/offline status, world transitions, avatar changes, and status updates in real time, storing everything in a local database. All capabilities are exposed to AI agents (like Hermes) through the **MCP interface**, so AI can handle social interactions, media management, group operations, and smart recommendations for you — no need to touch the VRChat client yourself.

This project is **AI-first**: it is built for AI agents to use and extend. Humans provide requirements and accept results; the AI does the development. See the documentation index below.

## Core Features

- 📡 **Friend Monitoring**: real-time friend activity capture, auto-reconnect, and automatic OTP email login when cookies expire — fully unattended
- 🤖 **Smart Recommendations**: AI friend recommendations (familiarity + favorite-group weights + room context) for rooms worth joining; preferences can be set in natural language and are learned automatically
- 🗺 **World Discovery & Recommendations**: world search (official VRChat / PlanetVRC Japanese directory / multi-source fusion), new-world tracking, X creator world recommendation aggregation
- 💬 **Social Interactions**: boop, room invites, join requests, friend requests/removal, one-click world opening (named-pipe direct send + API fallback), with built-in rate limiting
- 🛍 **Asset Search**: search VRChat assets on BOOTH (pixiv's digital marketplace) — avatars, outfits, 3D models — with popularity ranking, details, local caching, and localized display
- 🖼 **Media Management**: upload, download, and delete for VRC+ Prints albums / Gallery / custom boop emojis
- 👥 **Group Management**: group info, live group room lists, join/leave, announcement peeking, group heat
- 🗄 **Data & Insights**: event history, cross-instance companion queries, online-pattern analysis, weekly gaming reports, nickname mapping, world notes & change history
- 🛡 **Self-Healing Ops**: automatic database backups (24h WAL online backup), Hermes plugin hosting (auto-start + crash recovery)

## Quick Start

**Prerequisites**: Node.js ≥ 18, a VRChat account (with email 2FA enabled), and an IMAP-capable email (to receive OTP codes).

1. Clone the repo, copy `credentials.example.json` to `credentials.json`, and fill in your VRChat account and email IMAP authorization code
2. Start the service: `node start-monitor.js`
3. Verify: `curl http://127.0.0.1:8799/health` returns `Auth: true` and `WS: connected`

> For the full configuration (credentials, environment variables, auto-start, plugin installation), have an AI agent follow [AGENTS.md](./AGENTS.md) — you only need to provide your account and accept the result.

## Documentation Index

> All project documentation is written for **AI agents and developers**. Read what you need after this README:

| Document | Content | When to read |
|----------|---------|--------------|
| [AGENTS.md](./AGENTS.md) | Deployment guide: credentials, environment variables, startup, Hermes plugin, Agent Skill installation, MCP config | Deploying / configuring / first use |
| [skills/](./skills/) | Ready-to-use Agent Skill collection (MCP tool list, query workflows, development guidelines, etc.; install via AGENTS.md) | Before querying / calling tools / developing |
| [DEVELOPMENT.md](./DEVELOPMENT.md) | Development guidelines: cross-platform constraints, PR requirements, data privacy, code style | Modifying code / submitting PRs |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System architecture: data flow, module responsibilities, dependencies | Understanding the codebase |
| [docs/history/](./docs/history/INDEX.md) | Project evolution history: milestone timeline, monthly releases/PRs and their significance | New agents should read first |
| [service-windows/](./service-windows/README.md) | Windows auto-start + crash recovery + daily repair reports (one-click script) | Running persistently on Windows |

**MCP Tools**: the service exposes MCP tools covering friend queries, social interactions, media management, group operations, world recommendations, asset search, and more. **The complete tool list (all tools) is registered in the [skills/vrc-monitor-agent/SKILL.md](./skills/vrc-monitor-agent/SKILL.md) "MCP Tools" section** — agents call tools from there. The other skills provide workflow guidance per capability (without re-listing tools): `booth-query-display` (BOOTH search/display), `vrc-monitor-companion-query` (companion queries), `vrchat-assistant-development` (development guidelines).

## 🧰 Auxiliary Tools (local, optional)

- `open-world.mjs`: create a room and open it in a **running VRChat client** (named-pipe direct send, silent fallback to API invite) — `node open-world.mjs <world ID or name>`
- `prepare_image.py`: pre-upload image processing (emoji squaring / Prints 16:9 / Gallery 4:3)
- `migrate-vrcx0.mjs`: one-click migration of historical data from VRCX — `node migrate-vrcx0.mjs`

## 🛠 Troubleshooting

**Q: WebSocket won't connect?**
A: Network conditions in China may require a proxy. The service auto-falls back to a local proxy (default `127.0.0.1:7892`, overridable via the `VRC_MONITOR_WS_PROXY` env var) after 6s of direct connection failure — no manual intervention needed.

**Q: OTP login keeps failing?**
A: Check that `imap_auth_code` in `credentials.json` is a correct IMAP authorization code (not your login password). The service cools down 120s after auth failures (5min on 401 rate limit) and retries automatically.

**Q: My account uses Authenticator (TOTP) 2FA and can't auto-login?**
A: Auto-login is supported: add `totp_secret` to `credentials.json` (the Authenticator otpauth:// URI or base32 key) and the service generates the code locally via RFC 6238 for startup / runtime-401 / WS-reconnect logins (`auth.totpAutoEnabled: true` in `/health` when enabled). Without it, when `/health` returns `auth.needsTotp: true`, an agent calls the `submit_totp` MCP tool with the current 6-digit code to complete login. Auto-channel priority: email OTP → automatic TOTP → manual `submit_totp`.

**Q: Do I need to handle expired cookies manually?**
A: No. Service startup and WS reconnects automatically go through OTP login, and the valid cookie is persisted to `auth_cookie.txt`. During runtime, when the API returns 401 (cookie expired), the service also auto-triggers re-login — if TOTP is required and `totp_secret` is configured it completes automatically; otherwise it enters `needsTotp` state and you call `submit_totp`, no restart needed.

**Q: How do I know when login fails or manual action is needed?**
A: Optional **login status notifications** (issue #69): copy `notify-config.example.json` to `notify-config.json` and set `enabled: true`. The service proactively notifies the host on entering `needsTotp`, email OTP fetch failure, runtime-401 auto re-auth failure, and auth recovery (no notification on normal auto-login success). `channels` support `desktop` (Linux notify-send / macOS osascript / Windows PowerShell toast) and `webhook` (POST JSON to `webhook_url`). It only notifies after `consecutive_fail_threshold` (default 3) consecutive failures, with `min_interval_sec` (default 300) anti-spam. Desktop notifications require a system notification daemon (Linux dunst/mako); silently degrade without one.

**Q: The database file is too big?**
A: Normal. ~300K events ≈ 300+ MB. better-sqlite3 (WAL mode) reads on demand and never loads the whole DB into memory.

## 💬 Community

QQ Group: **851865556** — join for usage questions, feature suggestions, and feedback.

## ☕ Sponsor

If you find this project useful, feel free to buy me a coffee:

![QR codes](assets/sponsor-qrcodes.png)

**Please fund my tokens** 🙏

## 📄 License

MIT — see [LICENSE](LICENSE).
