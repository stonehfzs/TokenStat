# TokenStat

[简体中文](README.md) · [Download desktop builds](https://github.com/stonehfzs/TokenStat/releases/latest)

TokenStat tracks AI token usage on Windows, macOS, and Linux. It reads supported local logs, groups recorded tokens by day, tool, and model, and exports CSV. The desktop app opens to **Daily**, with hourly activity, model details, API cost estimates, and the 15 highest-usage sessions for the selected day.

## Run TokenStat

The desktop installers bundle Electron. On Linux, give the AppImage execute permission before opening it. If FUSE is unavailable, launch it with `--appimage-extract-and-run`. [Windows installation and login startup](docs/WINDOWS.md)

Run the local service from source with **Node.js 22.15 or later**.

```sh
npm start
```

Open the loopback address printed in the terminal. The default is `http://127.0.0.1:4317`. Set `TOKENSTAT_PORT` to change it.

Install the desktop dependencies before opening the desktop window or building a native package.

```sh
npm ci
npm test
npm run desktop
npm run dist
```

Run `npm run dist` on the target OS to produce an NSIS installer, a DMG, or an AppImage in `dist/`. The CI matrix builds and checks packages on Linux, Windows, and macOS. Closing the desktop window keeps log collection running in the tray. Use **Start at login** to launch in the tray after signing in. It is off by default.

## Usage and imports

| Tool | Local source |
| --- | --- |
| Codex | Session and archived-session JSONL logs under `~/.codex` or `CODEX_HOME`, including Zstandard-compressed archives |
| Google Antigravity | Usage entries in the local Antigravity App, IDE, and CLI transcripts |
| Grok Build | `updates.jsonl` in Grok session and archived-session directories |
| Claude Code | Assistant usage in JSONL project logs, including cache reads and writes |
| Gemini CLI | Local session JSON and JSONL under `~/.gemini/tmp` |
| Cline | Editor task messages and SDK, CLI, or desktop session message files |
| Roo Code | Request usage in local editor task logs |

Under **Sources**, enter the log directory or supported file for a custom location. Date-only imports keep their original calendar day. Timestamped records use the reporting time zone and appear in the hourly view.

Import UTF-8 CSV, JSON, JSONL, or NDJSON. The preview shows new records, duplicates, and model assignments. **Import history** can undo records added by a specific batch.

```csv
date,provider,model,input,output,cached,cache_write,reasoning,total
2026-11-22,gemini,gemini-2.5-pro,1200,300,200,0,55,1500
```

Use `YYYY-MM-DD` or an ISO timestamp with an offset. For an API response without a timestamp, add `date` before importing. Use `request_level=true` only for a record that describes a single request. TokenStat uses that flag when a model has different short- and long-context rates.

## Costs and preferences

**Sources → Preferences and budgets** includes Simplified Chinese and English, USD and CNY cost display, and daily or monthly budgets. Supply a CNY-per-USD rate to display costs in CNY. Pricing and cost budgets use USD internally. The desktop app can notify you at the 80% and 100% budget thresholds.

**Sources → Model rates** lets you override pricing for an exact tool and model ID. API estimates use public standard text rates and account for model-specific context tiers when request-level data is available. The coverage indicator shows how much usage could be priced. Grok Build charges recorded in its logs appear separately. [OpenAI pricing](https://developers.openai.com/api/docs/pricing) · [Gemini pricing](https://aistudio.google.com/docs/pricing) · [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) · [xAI pricing](https://docs.x.ai/developers/pricing)

## Device sync

1. On each device, open **Sources → Device sync** and choose the local path to the same shared folder. This can be a network share or a folder replicated by your preferred sync service.
2. On the first device, enter a device name and choose **Enable and sync** with the key field blank. Enter the generated pairing key on the other devices. **View key** reveals it when you need to pair another computer.
3. Open the device selector to filter usage or compare device totals. **All devices** counts a repeated event once. Use **Remove local copy** to stop receiving a device and remove its synced usage from this computer. **Resume receiving** reverses that setting.

TokenStat writes AES-256-GCM encrypted usage files grouped by UTC month. The manifest identifies the complete set of files for a device revision. When a shared folder is unavailable or still downloading a revision, TokenStat keeps the last complete usage. Pausing sync keeps the device data already received.

The desktop app protects pairing keys with the operating system credential store. Linux desktop sync requires an available, unlocked credential store. Browser mode stores its pairing key in the local application data. Share the key only with computers you want to pair.

## Backups and local storage

Use **Sources → Configuration backup** to export or restore custom log paths, rate overrides, preferences, import history, and imported usage. Restoring merges imported records by identifier, applies the saved settings, and rescans the configured paths. Device sync credentials and received peer snapshots stay with the installation. Keep the exported JSON private because it contains local paths and imported usage.

TokenStat stores normalized usage and scan state in `tokenstat.db` using SQLite WAL. Conversation text remains in the AI tools’ logs. Browser-mode data directories are listed below. Set `TOKENSTAT_DATA_DIR` to override them. The desktop app uses the `data` subdirectory of its Electron user data folder.

| OS | Browser-mode data directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\TokenStat` |
| macOS | `~/Library/Application Support/TokenStat` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/tokenstat` |
