# Security

Please report security problems privately through GitHub: **Security → Report a vulnerability** on https://github.com/yashhonap/warden (do not open a public issue).

Include what you found, how to reproduce it, and which version (`warden --version`). You will get a reply as soon as possible.

Things worth knowing about Warden's design:

- In `ask` mode every file change and every shell command needs approval; `auto-edit` and `yolo` deliberately relax that.
- API keys are read from environment variables or from `~/.warden/credentials.json` (plain text on your machine).
- The supervisor daemon listens on 127.0.0.1 only and rejects other hosts and origins.
