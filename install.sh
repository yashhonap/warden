#!/bin/sh
# Warden installer for macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/yashhonap/warden/main/install.sh | sh
# What it does, and nothing else: checks for Node.js 22.13+ (and tells you how to get it if missing),
# then installs Warden from npm (package "agent-warden"). It never uses sudo by itself.
# Set WARDEN_PACKAGE to install from somewhere else (e.g. a local .tgz) for testing.
set -e

say() { printf '  %s\n' "$1"; }

echo
say "Installing Warden - a coding agent for any model, in your terminal"
say "https://github.com/yashhonap/warden"
echo

if ! command -v node >/dev/null 2>&1 || ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
  say "Warden needs Node.js 22.13 or newer, and it was not found."
  case "$(uname -s)" in
    Darwin) say "Install it with Homebrew:  brew install node   (or download the LTS from https://nodejs.org)";;
    *)      say "Install the LTS from https://nodejs.org, or with nvm:  https://github.com/nvm-sh/nvm";;
  esac
  say "Then run this command again."
  exit 1
fi
say "Node.js $(node --version) found."

PKG="${WARDEN_PACKAGE:-agent-warden}"
say "Installing $PKG from npm..."
if ! npm install -g "$PKG"; then
  echo
  say "npm could not install Warden (see above)."
  say "If it says EACCES (permission denied), let npm install into your home folder instead:"
  say "  mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global"
  say "  echo 'export PATH=\$HOME/.npm-global/bin:\$PATH' >> ~/.profile && . ~/.profile"
  say "then run this command again."
  exit 1
fi

echo
say "Done! Next: open a new terminal, go to a project folder (cd your/project) and type:  warden"
say "Warden will help you get a free API key the first time."
echo
