# Development notes

Phase-by-phase build log, test notes and what was (and was not) verified live. The user-facing docs are in the main README.

# Warden (Phase 1: observe and record)

Zero dependencies. Needs Node 22.5+ (uses built-in `node:sqlite`).

    node src/cli.mjs daemon        # records events to ~/.warden/warden.db (override: WARDEN_HOME)
    node src/cli.mjs watch         # live feed
    node src/cli.mjs sessions      # list recorded sessions
    node src/cli.mjs replay <id>   # replay a session's events (id prefix ok)
    node src/cli.mjs diff <id>     # git status + diff captured when the session stopped

On Stop, the daemon snapshots `git status`, `git diff HEAD` and a copy of the transcript JSONL.

## Hook (per project, .claude/settings.local.json)
Use this command for UserPromptSubmit, PreToolUse (matcher "*"), PostToolUse (matcher "*") and Stop:

    curl -s --connect-timeout 0.2 -m 0.5 -X POST -H "content-type: application/json" --data-binary @- http://127.0.0.1:7777/event; exit 0

About 120 ms per hook (vs about 250 ms for the Node hook) and silent if the daemon is down.

## Phase 2: approval-gated reviewers

    node src/cli.mjs review <id> [--roles correctness,test-gap,security] [--yes]
    node src/cli.mjs reviews <id>      # past reports

`review` shows what will be sent (redacted), the estimated cost and your daily spend, and asks y/N. Declining sends nothing.
When a session stops, the daemon only broadcasts a `ReviewProposal` line in `warden watch`. It never starts a review itself.

Roles: correctness, test-gap, security, scope-creep. Reviewers have no tools (they only read the redacted context), run in a hook-free temp dir, and findings from all roles are merged by file:line.

Config (`~/.warden/config.json`, all optional): `mode` (ask | observe), `provider` (claude-cli | anthropic), `model`, `roles`, `maxUsdPerRun`, `maxUsdPerDay`, `maxDiffChars`.

Providers: `claude-cli` uses your Claude Code login (no API key); `anthropic` needs ANTHROPIC_API_KEY (untested so far).
The claude-cli reviewer runs with a custom system prompt and without your MCP servers, skills and settings. That cut a 3-reviewer run from about $1.40 to about $0.06.

## Phase 3: multiple providers

Built in: `claude-cli`, `anthropic`, `openai`, `openrouter` (hundreds of models), `gemini`, `ollama` (local, free).
Keys come from env vars only (ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY or GOOGLE_API_KEY). Gemini's key goes in a header, never the URL.

    node src/cli.mjs review <id> --with gemini:<model>,openai:<model>    # every role on every model (cross-check)
    node src/cli.mjs review <id> --roles security --with ollama:<model>

Or pin roles to models in `~/.warden/config.json`:

    { "reviewers": [ {"role":"correctness","provider":"gemini","model":"<model>"},
                     {"role":"security","provider":"openai","model":"<model>"} ],
      "prices": { "gemini/<model>": {"in": 0.0, "out": 0.0} },
      "providers": { "lmstudio": {"kind":"openai","baseUrl":"http://127.0.0.1:1234/v1","free":true} } }

- The approval screen lists each reviewer and the host the redacted context goes to.
- There is no built-in price table (prices go stale). Without a `prices` entry a model's cost shows as unknown and is not counted toward the daily cap. Output is capped by `maxOutputTokens`.
- A failing provider is isolated: the other reviewers still report.

Offline test (mock servers for every API shape, no keys needed): `node test/providers.mock.mjs`

## Phase 4: Arena (same task, several models)

    node src/cli.mjs arena run examples/fix-slugify.json     # shows the plan, asks y/N
    node src/cli.mjs arena board [taskId]                    # cross-run leaderboard
    node src/cli.mjs arena show <runId>      node src/cli.mjs arena diff <runId> <subject>
    node src/cli.mjs arena rate <runId> <subject> up|down    # your own vote

A task file has `prompt`, `repo`, optional `base`, `checks` (commands that must exit 0, e.g. `npm test`) and `subjects`:
- `claude-code` subjects run Claude Code headless with `--model` (opus, sonnet, haiku or a full id), limited to Read/Edit/Write/Glob/Grep plus Bash for the check commands only, capped by `maxUsdPerSubject`.
- `command` subjects run any other harness (`gemini -p "$WARDEN_PROMPT"`, `opencode run`, ...). The prompt comes via stdin and the `WARDEN_PROMPT` env var, never pasted into the command line.

Every subject runs in its own `git worktree` from the same base commit, in parallel. Your checkout is never touched and worktrees are removed afterwards.
Measured per subject: checks pass/fail, wall time, cost, tokens, turns, files and lines changed. Then a blind judge panel (anonymous letters, shuffled, each judge run twice with the order reversed). Judges that are also contestants are excluded and same-vendor overlap is flagged.
Rank order, with no hidden weights: finished OK, all checks pass, judge score, lower cost, lower time.

Limits: only Claude Code and command subjects exist so far (no raw-API-model loop yet); `command` subjects run arbitrary shell commands from the task file; one run is an anecdote, so the board warns until you have 5+.
Offline test with real worktrees and a mock judge: `node test/arena.mock.mjs`

## Phase 5: dashboard

Start the daemon, then open http://127.0.0.1:7777/

- **Sessions:** live event feed (SSE), session list with review verdicts, per-session review reports, the git diff captured at stop, and the full event timeline.
- **Arena:** leaderboard, run list, per-run results with judge notes, diffs and your Good/Bad rating.
- It is read-mostly. Starting a review or arena run still happens in the terminal, so a web page can never spend money or send your code anywhere.

Safety for a daemon that holds your code: it only answers loopback Host headers (stops DNS rebinding) and rejects any browser request whose Origin isn't itself (other websites can't read or write it). The page is served with a per-request-nonce CSP and built with `textContent` only, so hostile text in transcripts or diffs renders as plain text.

No build step: it is one HTML file (`src/dashboard/index.html`). `node test/seed-demo.mjs` fills a throwaway WARDEN_HOME with clearly-labelled fake data (including hostile strings) to look at.

## Phase 6: other harnesses as Arena subjects

    node src/cli.mjs harnesses     # which agent CLIs are available here, and how well each adapter is verified

Subject `kind`s: `claude-code`, `opencode`, `pi`, `codex`, `command`. Example subjects:

    { "name": "oc",  "kind": "opencode", "model": "provider/model" }
    { "name": "pi1", "kind": "pi",       "model": "provider/model", "tools": ["read","edit","write"] }
    { "name": "cx",  "kind": "codex",    "model": "<model>" }
    { "name": "gem", "kind": "command",  "cmd": "<your gemini/antigravity command using $WARDEN_PROMPT>" }

All adapters pass the prompt as one argv element, never through a shell (a test feeds quotes, `&`, `$(...)`, newlines and checks it arrives intact). On Windows the npm `.cmd` shims are resolved to the real exe/js they launch.
`extraArgs` lets you append flags; the approval screen shows each adapter's risk note, extra args and verification status.

What is and isn't verified:
- **opencode** (v2.2.4) and **pi** (0.87.1): flags read from the installed `--help`, but never run for real. Cost and tokens stay unknown for them, and unknown cost loses cost tiebreaks (checks and judge score still rank first).
- **codex**: flags and `--json` event schema from OpenAI's docs only; not installed here. Token totals come from `turn.completed` usage. The model flag (`--model`) is from third-party docs.
- **gemini**: no adapter. Its docs page says Gemini CLI was replaced by Antigravity CLI (June 2026) and the model/approval flags could not be confirmed. Use a `command` subject.
- opencode runs with `--auto` (all tool permissions auto-approved, including shell, no sandbox); pi is limited to read/edit/write; codex uses `--sandbox workspace-write`.

Offline test with fake CLIs and a real worktree run: `node test/harnesses.mock.mjs`

### Live probe result (opencode 2.2.4 and pi 0.87.1, both using OPENAI_API_KEY)
Both CLIs started, accepted the adapter's flags, resolved `openai/gpt-4.1-mini`, reached OpenAI, and exited non-zero with "no credits remaining" on the account. So process launch, argv handling, exit-code capture, error reporting and worktree cleanup are confirmed on the real tools. What is NOT confirmed: that either one completes the task, and what cost/token data their output contains (the run never got that far). Top up the OpenAI account (or point the subjects at another provider) and run `node src/cli.mjs arena run examples/probe-harnesses.json` to finish the probe.
Subjects that error are no longer judged (no judge spend) and show `-` instead of a rank; judging is skipped when fewer than 2 subjects finish.

### Live probe, round 2 (pi + Gemini)
`examples/probe-pi-gemini.json` ran `pi` on `google/gemini-2.5-flash-lite` and `google/gemini-2.5-flash` with a free Gemini key (set as the `GEMINI_API_KEY` env var, never pasted into chat or files). Both runs completed through the adapter (worktree, check command, diff stats, blind judge), so the **pi adapter is now verified live**.
- pi now runs in `--mode json`, and tokens, turns and cost are parsed from the `message_end` events as observed in a real run. The cost is pi's own list-price estimate, not a bill (free-tier calls actually cost nothing).
- Two runs of the same pair gave different outcomes: flash passed the checks in the first and failed them in the second. One run proves nothing; this is why the leaderboard warns until 5+ runs.
- **opencode** did not see the Gemini key (it only listed OpenAI, which has no credits, and its own `opencode` provider). It was not run with Gemini. To try it: `opencode auth login` (this stores credentials in opencode's own config, so it's your call) or add OpenAI credits.

## Website

`site/Warden Landing Page.html` is the landing page exported from your Claude Design project, unmodified.
Preview it locally: `node site/serve.mjs` then open http://127.0.0.1:4173/ (a separate server from the Warden daemon, which holds your code).
The page loads React 18.3.1 from unpkg and fonts from Google Fonts, so it needs internet. To publish, upload the HTML file as `index.html` to any static host.
Edits made to your design export (the unmodified original is in `site-original/`): the install box and its copy button now say `npm i -g warden-agent` (`warden` on npm belongs to someone else), every GitHub/Docs/footer link points at https://github.com/yashhonap/warden (Docs goes to its README), and footer links with no real destination (Roadmap, Contributing, Security, License, Discord, X, RSS) were removed.
Still true before you launch: that repo must exist, `warden-agent` must be published to npm, and the footer still says "Open source under MIT" while the project has no LICENSE file yet.

## Phase 8: Warden becomes a terminal coding agent (0.2.0)

Restructure: the supervisor code moved to `src/supervisor/` unchanged (its tests still pass). New code:
- `src/agent/providers.mjs`: two wire protocols. OpenAI-compatible streaming chat with tool calls (Gemini via `generativelanguage.googleapis.com/v1beta/openai`, OpenRouter, Groq, Ollama, LM Studio, OpenAI, custom) and Anthropic Messages. Retries 429/5xx with Retry-After.
- `src/agent/tools.mjs`: read_file, write_file, edit_file (exact replace, keeps CRLF), list_dir, glob, grep, bash (Git Bash on Windows when present, else PowerShell). Permission modes ask / auto-edit / yolo.
- `src/agent/loop.mjs`: agent loop. Every tool call always gets a result (also when interrupted), old tool output is trimmed past the context budget, max steps per message.
- `src/agent/session.mjs`: JSONL conversations in `~/.warden/sessions`.
- `src/tui/`: the terminal app (streaming Markdown, tool blocks with diffs, approvals, slash commands, Ctrl+C interrupt, Shift+Tab mode, paste handling, piped input).
- `src/cli.mjs`: `warden` opens the agent; supervisor subcommands still work.

Live tests (Gemini 2.5 Flash, free key): headless `-p` in auto-edit mode fixed a planted bug (list, read, edit) and its shell command was denied as designed; the interactive app in ask mode streamed, showed the diff, asked, and respected "n". A run in yolo mode was not done in testing.

## Website copy for 0.2.0

`site/Warden Landing Page.html` keeps the Claude Design layout, styling and animations; only text changed (the untouched original export is in `site-original/`). It now presents Warden as a terminal coding agent for any model: hero, the word-reveal statement, the pinned Ask / Approve / Done story (terminal mock with `/model`, approval prompt, the three permission modes), provider chips, safety cards (approval, modes, free models, keys), the arena section labelled as an example run, and the install CTA ("Open a terminal. Type warden."). Checked in the browser at 1440px and 375px: no leftover supervisor copy, no truncated labels, no horizontal scroll.

## 0.3.0: /add and free models

- `src/agent/catalog.mjs`: sources (OpenRouter, Hugging Face, NVIDIA, Gemini, Groq, Cerebras, Mistral, DeepSeek, Ollama, LM Studio, OpenAI, Anthropic) with key URLs and model-list parsers. OpenRouter, Hugging Face and NVIDIA publish model lists without a key (checked live); OpenRouter marks free models by $0 pricing, Hugging Face per provider (`is_free`, `supports_tools`).
- `src/agent/credentials.mjs`: keys from `/add` in `~/.warden/credentials.json`; environment variables take priority.
- `src/agent/models.mjs`: saved models (`agent.models` in config) and `probeToolSupport`: native tool call, else the text format, else chat only. A bad key or unknown model is reported as an error, not as missing tool support.
- `src/agent/texttools.mjs`: `<tool_call>{json}</tool_call>` format for models without native tools, results as `<tool_result>`, tags hidden from the stream. The loop switches a model to it automatically if the provider rejects the `tools` parameter.
- `/add` wizard, `/model` picker, `/models <source> [search] [--free]`, `/providers`, `/remove`.
- Piped input: questions now wait for the next line (found by the test: lines after `/add` were being treated as chat messages, including a pasted key).
- 429 handling: Google's `retryDelay` is honoured; a daily or long quota fails immediately with a hint instead of retrying (found live when Gemini's 20-requests-a-day free quota ran out).
