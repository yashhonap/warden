# Warden

A coding agent that runs in your terminal and works with **any model**: Gemini (free tier), OpenRouter, Groq, Ollama and LM Studio (local, free), OpenAI, Anthropic, or any OpenAI-compatible server.

You chat with it in your project folder. It reads your code, edits files, runs commands and tests, and asks before it changes anything (unless you tell it not to).

It also includes the original Warden supervisor tools: record and review Claude Code sessions, and run the same task on several models to compare them.

> **Status: early (0.4.0).** Tested live with Gemini 2.5 Flash. Read [What is verified](#what-is-verified).

## Install

Pick one. All three give you the same `warden` command.

**Windows, nothing installed yet** (paste into PowerShell; installs Node.js if needed, then Warden):
```powershell
irm https://raw.githubusercontent.com/yashhonap/warden/main/install.ps1 | iex
```

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/yashhonap/warden/main/install.sh | sh
```

**Already have Node.js 22.13+:**
```bash
npm i -g agent-warden
```

**Or download one file** (Node.js included): `warden-windows-x64.exe`, `warden-macos-arm64` or `warden-linux-x64` from [Releases](https://github.com/yashhonap/warden/releases/latest). Windows may warn that the publisher is unknown (the file is not code-signed); choose "More info", then "Run anyway".

Then open a **new** terminal, go to a project folder and type `warden`. The first time, it walks you through getting a free API key (about two minutes with Google Gemini).

Something not working? Run `warden doctor`: it checks your setup and tells you what to fix. See also [Troubleshooting](docs/TROUBLESHOOTING.md). Update with `warden update`.

From a source checkout, run `npm link` once in the folder, or use `node src/cli.mjs` wherever this README says `warden`.

## Add models (free ones too)

Inside Warden, type `/add`:

```
› /add
   1  ○ OpenRouter     hundreds of models, some free (Nemotron, Qwen, Llama…)
   2  ○ Hugging Face   open models (DeepSeek, Qwen, Nemotron…), free monthly credits
   3  ○ NVIDIA         Nemotron, DeepSeek, Llama…, free credits
   4  ● Google Gemini  free tier
   …  Groq · Cerebras · Mistral · DeepSeek · Ollama · LM Studio · OpenAI · Anthropic
   c  ○ Custom         any OpenAI-compatible server (URL)
```

Pick a source, paste its key (typed hidden), search its models (free ones are listed first and marked), pick one. Warden then sends the model one tiny test to check the key and to find out how it can use tools, and saves it under a short name. Switch any time with `/model`.

- Keys pasted into `/add` are saved in `~/.warden/credentials.json` on your PC (plain text, only your Windows user can read your profile folder). Environment variables, if set, are used first. `/remove <source>` deletes a saved key.
- **Models without tool calling:** many free models cannot call tools natively. Warden then uses its own text format for tool calls, so they can still read and edit files (with the same approvals). If a model cannot manage either, it is marked **chat only**.
- **Free means limited.** Free tiers have small daily quotas (Gemini 2.5 Flash's free tier allowed 20 requests a day when tested). When a quota runs out, Warden says so instead of retrying; switch to another model with `/model`.

You can also set keys yourself as environment variables (`setx GEMINI_API_KEY "your-key"` on Windows, then open a new terminal): `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `HF_TOKEN`, `NVIDIA_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. Ollama and LM Studio need none.

## Use it

```bash
cd your-project
warden
```

Then type what you want, e.g. `the tests in calc_test.py fail, fix them`. Warden shows each step:

```
● Read calc.py
  ⎿ 12 lines
● Edit calc.py
    -     return a - b
    +     return a + b
  ? Allow this change? [y] yes  [a] always allow edit_file this session  [n] no, or type what to do instead
```

Inside the app:

| | |
|---|---|
| `/add` | add a model from any source (see above) |
| `/model` | pick from your saved models by number; `/model <name>` or `/model provider/model` switches directly (becomes your default) |
| `/models openrouter nemotron --free` | browse and search a source's models |
| `/providers` | which sources have a key |
| `/remove <name>` | remove a saved model; `/remove <source>` forgets that source's saved key |
| `/mode` | `ask` (approve edits and commands), `auto-edit` (edits in this folder run without asking), `yolo` (everything runs without asking). Shift+Tab cycles. |
| `/clear` | new conversation |
| `/resume` | continue an earlier conversation |
| `/init` | the model writes a `WARDEN.md` with notes about your project |
| `/usage` | tokens used |
| `!command` | run a shell command yourself; the model sees the output |
| Ctrl+C | interrupt the model; twice at an empty prompt quits |

Other ways to start:

```bash
warden "fix the failing test"              # start with a message
warden --model groq/llama-3.3-70b-versatile
warden --continue                          # pick up the last conversation in this folder
warden -p "summarise this repo"            # answer once and exit (scripts); --json for JSON
```

If a `WARDEN.md`, `AGENTS.md` or `CLAUDE.md` exists in the folder, its contents are given to the model as project instructions.

## Tools the model can use

`read_file`, `write_file`, `edit_file` (exact text replacement), `list_dir`, `glob`, `grep`, and `bash`. On Windows, `bash` uses Git Bash if installed, otherwise PowerShell.

## Safety

- **`ask` mode (default):** every file change and every command needs your approval. Reading files inside the project does not. Reading or writing outside the project always asks, except in `yolo`.
- **`yolo` runs commands without asking.** Use it only in a folder you are happy for the model to change, ideally a git repo with your work committed.
- `-p` mode never prompts: anything that would need approval is denied unless you pass `--mode auto-edit` or `--mode yolo`.
- Keys are read from environment variables only. Conversations are saved as plain text in `~/.warden/sessions/` on your machine.
- Free tiers rate-limit. Warden waits and retries on 429 errors and shows that it is waiting.

## Privacy

- **No telemetry.** Warden does not report anything about you or your usage.
- Your prompts, and the files and command output the model asks for, go **only to the model provider you picked** (Google, OpenRouter, …), under that provider's terms. Free tiers often allow the provider to use your data to improve their models; use a paid tier or a local model (Ollama, LM Studio) for private code.
- Conversations are saved on your computer in `~/.warden/sessions/`. Keys you paste into `/add` are saved in `~/.warden/credentials.json`. Delete those folders to remove everything.
- Once a day Warden asks the npm registry for the latest version number (a plain request to a public URL, nothing about you is sent). Turn it off with the environment variable `WARDEN_NO_UPDATE_CHECK=1` or `"updateCheck": false` in the settings.

## Settings

`~/.warden/config.json`, section `agent` (all optional):

```json
{
  "agent": {
    "model": "gemini/gemini-2.5-flash",
    "mode": "ask",
    "maxSteps": 60,
    "contextTokens": 120000,
    "providers": {
      "deepseek": { "api": "openai", "baseUrl": "https://api.deepseek.com/v1", "keyEnv": ["DEEPSEEK_API_KEY"] }
    }
  }
}
```

Any OpenAI-compatible server can be added under `providers` and used as `name/model`.

## Supervisor tools (from Warden 0.1)

Record Claude Code sessions, review them with other models, and compare models on the same task:

```bash
warden daemon                     # record Claude Code via hooks; dashboard at http://127.0.0.1:7777/
warden review <session-id>        # approval-gated reviewers on any model
warden arena run task.json        # same task, several models or agents, ranked
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for setup, hook configuration and details.

## What is verified

- `npm test` runs offline: a mock model server that streams tool calls, the real tools on a temp project, permissions, rate-limit retries, interrupts, saved sessions, the terminal app driven through a pipe, and the supervisor tests.
- **Live:** Gemini 2.5 Flash through Google's OpenAI-compatible endpoint. It found, read and fixed a bug, streamed its answer, asked for approval, and respected a denial. The `/add` tool test identified it as native tool calling. Its free daily quota (20 requests) ran out during testing, which is how the quota handling was found and fixed.
- **Live model lists:** OpenRouter (466 models, 16 free), Hugging Face (126, free monthly credits rather than free models) and NVIDIA (65 chat models) were listed through Warden's own code without keys.
- **Not tested live:** chatting through OpenRouter, Hugging Face, NVIDIA, Groq, Cerebras, Mistral, DeepSeek, Ollama, LM Studio, OpenAI and Anthropic (no keys or local servers were available). The text tool format was tested against a mock model only. They use the same code path as Gemini (except Anthropic, which has its own).
- The interactive app was tested through a pipe and on Gemini, but not in every terminal. Shift+Tab mode switching depends on your terminal sending the right key code.

## License

MIT, see [LICENSE](LICENSE).
