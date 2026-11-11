# Troubleshooting

Start with:

```
warden doctor
```

It checks Node.js, your settings folder, your model and key, and your connection, and says what to fix. Add `--chat` to also send one tiny test message to your model (this uses one request of your quota). Its output contains no keys, so you can paste it when asking for help.

## "running scripts is disabled on this system" (Windows PowerShell)

PowerShell blocks the small script npm installs for the `warden` command. Either type `warden.cmd` instead of `warden`, or allow scripts for your user once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

(This changes a Windows security setting for your account. `warden.cmd` avoids it.)

## "warden is not recognized" / "command not found"

Open a **new** terminal window after installing. If it still fails:

- npm install: run `npm prefix -g` and make sure that folder (on Windows) or its `bin` folder (macOS/Linux) is on your PATH.
- macOS/Linux, "EACCES" during install: npm cannot write to its global folder. Run `mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global`, add `~/.npm-global/bin` to your PATH, and install again.

## "no API key for …"

Run `warden` and type `/add`, pick the source, paste the key. Or set it yourself as an environment variable (Windows: `setx GEMINI_API_KEY "your-key"`, then open a new terminal). `/providers` shows which sources have a key.

## 429 / "quota used up"

Free tiers allow a limited number of requests (for example per day). Switch to another model with `/model` (other models usually have their own quota), `/add` a different free source, or wait for the quota to reset.

## 401 / 403

The key is wrong, expired, or not allowed to use that model. `/add` the source again and paste a fresh key.

## 404 "model not found"

The model id changed or was retired (free models change often). `/models <source>` shows what exists now; `/add` picks a new one.

## The model says it cannot read files / "chat only"

Some models cannot call tools at all. `/model` marks them "chat only". Pick another model with `/add`; ones marked `tools` in the list work best.

## Company network / proxy

Node.js uses the `HTTPS_PROXY` environment variable. Set it to your proxy address, open a new terminal and try `warden doctor` again.

## Windows says the downloaded warden.exe is from an unknown publisher

The standalone file is not code-signed. Choose "More info", then "Run anyway", or install with `npm i -g agent-warden` instead.

## Still stuck

Open an issue at https://github.com/yashhonap/warden/issues and paste the output of `warden doctor`.
