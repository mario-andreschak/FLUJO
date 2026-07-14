#!/usr/bin/env bash
#
# FLUJO installer / updater for Linux and macOS — the Unix counterpart of
# scripts/install.ps1.
#
# Installs the prerequisites (Git, Node.js + npm, Python 3, uv), clones (or
# updates) FLUJO, builds it, registers a global 'flujo' command (start FLUJO
# from any folder), and optionally starts it. Can also optionally install Ollama
# (the local-model runtime) — FLUJO then talks to it over HTTP.
#
# Run directly:
#
#     bash scripts/install.sh
#
# or as a one-liner straight from GitHub:
#
#     curl -fsSL https://raw.githubusercontent.com/mario-andreschak/FLUJO/main/scripts/install.sh | bash
#
# Prompts read from /dev/tty, so the one-liner stays interactive. With no
# terminal at all (CI, containers) the defaults apply. Environment overrides:
#
#     FLUJO_DIR       install folder                   (default: $HOME/FLUJO)
#     FLUJO_BRANCH    git branch                       (default: main)
#     FLUJO_START     start FLUJO after building       1/true/yes or 0/false/no
#     FLUJO_SHORTCUT  desktop entry, Linux only        1/true/yes or 0/false/no
#     FLUJO_OLLAMA    install Ollama for local models  1/true/yes or 0/false/no

set -euo pipefail

REPO_URL='https://github.com/mario-andreschak/FLUJO/'
BRANCH="${FLUJO_BRANCH:-main}"
# Next.js 15 requires Node >= 18.18; distro repos often ship older.
MIN_NODE_MAJOR=18
MIN_NODE_MINOR=18
BIN_DIR="$HOME/.local/bin"
MANIFEST_DIR="$HOME/.local/share/flujo-cli"

# --- output helpers (color only when stderr is a terminal) -------------------
if [ -t 2 ]; then
  C_STEP=$'\033[36m'; C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_TITLE=$'\033[35m'; C_END=$'\033[0m'
else
  C_STEP=''; C_OK=''; C_WARN=''; C_TITLE=''; C_END=''
fi
step() { printf '\n%s==> %s%s\n' "$C_STEP" "$1" "$C_END" >&2; }
ok()   { printf '%s    %s%s\n'   "$C_OK"   "$1" "$C_END" >&2; }
warn() { printf '%s    %s%s\n'   "$C_WARN" "$1" "$C_END" >&2; }
die()  { printf '\n%sERROR: %s%s\n' "$C_WARN" "$1" "$C_END" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Prompt helpers that work when the script is piped into bash (curl | bash):
# stdin is the script itself there, so prompts must read from /dev/tty. With no
# tty at all the default answer is used.
ask() { # ask "question" "default" -> prints the answer
  local answer=''
  if [ -r /dev/tty ]; then
    printf '%s ' "$1" >&2
    IFS= read -r answer < /dev/tty || answer=''
  fi
  if [ -n "$answer" ]; then printf '%s' "$answer"; else printf '%s' "$2"; fi
}
ask_yn() { # ask_yn "question" -> 0 = yes (the default), 1 = no
  case "$(ask "$1 (Y/n)" y)" in
    [nN]|[nN][oO]) return 1 ;;
    *) return 0 ;;
  esac
}
# Interpret a FLUJO_* env flag: 0 = yes, 1 = no, 2 = unset/unrecognized.
flag() {
  case "${1:-}" in
    1|true|yes) return 0 ;;
    0|false|no) return 1 ;;
    *) return 2 ;;
  esac
}

node_version_ok() {
  have node || return 1
  local v major minor
  v="$(node -v 2>/dev/null)" || return 1
  v="${v#v}"
  IFS=. read -r major minor _ <<EOF
$v
EOF
  [ "${major:-0}" -gt "$MIN_NODE_MAJOR" ] 2>/dev/null && return 0
  [ "${major:-0}" -eq "$MIN_NODE_MAJOR" ] 2>/dev/null && [ "${minor:-0}" -ge "$MIN_NODE_MINOR" ] 2>/dev/null
}

printf '%sFLUJO Installer%s\n' "$C_TITLE" "$C_END" >&2
printf '%s===============%s\n' "$C_TITLE" "$C_END" >&2

OS="$(uname -s)"
case "$OS" in
  Linux|Darwin) ;;
  *) die "Unsupported platform '$OS'. Use scripts/install.ps1 on Windows." ;;
esac

have curl || die "curl is required to bootstrap the prerequisites. Install curl and re-run."

# sudo is only used for package-manager installs; everything else stays in $HOME.
SUDO=''
if [ "$(id -u)" -ne 0 ]; then
  if have sudo; then
    SUDO='sudo'
  else
    warn "Neither running as root nor is sudo available; prerequisite installs may fail."
  fi
fi

# ---------------------------------------------------------------------------
# 1. Gather all the user's choices up front, then run the install in one go.
# ---------------------------------------------------------------------------
INSTALL_DIR="${FLUJO_DIR:-}"
if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="$(ask "Where should FLUJO be installed? (press Enter for: $HOME/FLUJO)" "$HOME/FLUJO")"
fi
INSTALL_DIR="${INSTALL_DIR/#\~/$HOME}"
ok "Installing into: $INSTALL_DIR"

MAKE_SHORTCUT=false
if [ "$OS" = Linux ]; then
  if flag "${FLUJO_SHORTCUT:-}"; then
    MAKE_SHORTCUT=true
  elif [ $? -eq 2 ]; then
    if ask_yn "Create a desktop entry for FLUJO?"; then MAKE_SHORTCUT=true; fi
  fi
fi

START_AFTER=false
if flag "${FLUJO_START:-}"; then
  START_AFTER=true
elif [ $? -eq 2 ]; then
  if ask_yn "Start FLUJO after building?"; then START_AFTER=true; fi
fi

# Ollama is a large, optional download, so it defaults to NO (unlike the prompts
# above): a bare `curl | bash` with no tty must not pull it unattended. Set
# FLUJO_OLLAMA=1 to opt in non-interactively.
INSTALL_OLLAMA=false
if flag "${FLUJO_OLLAMA:-}"; then
  INSTALL_OLLAMA=true
elif [ $? -eq 2 ]; then
  case "$(ask "Install Ollama for local models? (large download, optional) (y/N)" n)" in
    [yY]|[yY][eE][sS]) INSTALL_OLLAMA=true ;;
  esac
fi

# Record what was already on the system BEFORE we touch it, so the uninstall
# manifest can default to removing only what FLUJO installed itself.
PRE_GIT=$(have git && echo true || echo false)
PRE_NODE=$(have node && echo true || echo false)
PRE_PYTHON=$(have python3 && echo true || echo false)
PRE_UV=$(have uv && echo true || echo false)
PRE_CLAUDE=$(have claude && echo true || echo false)
PRE_OLLAMA=$(have ollama && echo true || echo false)

# ---------------------------------------------------------------------------
# 2. Install prerequisites.
# ---------------------------------------------------------------------------
PM=''
if [ "$OS" = Darwin ]; then
  PM='brew'
  if ! have brew; then
    warn "Homebrew was not found; it is needed to install Git/Node.js/Python."
    if ask_yn "Install Homebrew now?"; then
      step "Installing Homebrew"
      if [ -r /dev/tty ]; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" < /dev/tty
      else
        NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
      fi
      # Make brew usable in this session (Apple Silicon vs Intel prefix).
      if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"
      elif [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"
      fi
      have brew || die "Homebrew installation did not complete. Install it from https://brew.sh and re-run."
    else
      die "Homebrew is required on macOS. Install it from https://brew.sh and re-run."
    fi
  fi
else
  if have apt-get; then PM='apt'
  elif have dnf;   then PM='dnf'
  elif have pacman; then PM='pacman'
  elif have zypper; then PM='zypper'
  elif have apk;    then PM='apk'
  elif have yum;    then PM='yum'
  else
    warn "No supported package manager found (apt/dnf/pacman/zypper/apk/yum)."
    warn "Install git, Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}, and python3 yourself, then re-run."
  fi
fi

# Fresh Mint/Ubuntu ISO installs keep the installation CD-ROM as an enabled apt
# source. Once the medium is gone (e.g. a VM after first boot) `apt-get update`
# fails on that entry and, under `set -e`, would abort the whole installer.
# Comment those lines out (non-destructively) before the first update. This also
# protects the NodeSource bootstrap, which runs its own `apt-get update`.
disable_cdrom_apt_source() {
  [ "$PM" = apt ] || return 0
  local f changed=false
  for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list; do
    [ -f "$f" ] || continue
    if grep -Eq '^[[:space:]]*deb[^#]*cdrom:' "$f"; then
      $SUDO sed -i -E 's|^([[:space:]]*deb[^#]*cdrom:)|# disabled-by-FLUJO-installer \1|' "$f"
      changed=true
    fi
  done
  [ "$changed" = true ] && warn "Disabled a CD-ROM apt source that would break 'apt-get update'."
  return 0
}

APT_UPDATED=false
pm_install() {
  case "$PM" in
    apt)
      if [ "$APT_UPDATED" = false ]; then
        disable_cdrom_apt_source
        $SUDO apt-get update || warn "'apt-get update' reported errors (continuing; a broken source may be present)."
        APT_UPDATED=true
      fi
      $SUDO apt-get install -y "$@" ;;
    dnf)    $SUDO dnf install -y "$@" ;;
    yum)    $SUDO yum install -y "$@" ;;
    pacman) $SUDO pacman -S --noconfirm --needed "$@" ;;
    zypper) $SUDO zypper --non-interactive install "$@" ;;
    apk)    $SUDO apk add "$@" ;;
    brew)   brew install "$@" ;;
    *)      return 1 ;;
  esac
}

# Git
if have git; then
  ok "Git already installed ($(command -v git))"
else
  step "Installing Git"
  pm_install git || die "Could not install Git. Install it manually and re-run."
fi

# Node.js (includes npm). Distro repos are often too old for Next.js 15, so
# apt/dnf/yum go through NodeSource; pacman/apk/brew ship current versions.
if node_version_ok; then
  ok "Node.js already installed ($(node -v), $(command -v node))"
else
  if have node; then
    warn "Node.js $(node -v) is older than the required ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}; upgrading."
  fi
  step "Installing Node.js (includes npm)"
  case "$PM" in
    apt)
      disable_cdrom_apt_source
      if curl -fsSL https://deb.nodesource.com/setup_22.x | ${SUDO:+$SUDO -E} bash -; then
        $SUDO apt-get install -y nodejs
      else
        warn "NodeSource setup failed; falling back to the distro nodejs package."
        $SUDO apt-get install -y nodejs npm || true
      fi
      ;;
    dnf|yum)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -
      pm_install nodejs
      ;;
    pacman) pm_install nodejs npm ;;
    apk)    pm_install nodejs npm ;;
    zypper) pm_install nodejs22 npm22 || pm_install nodejs npm ;;
    brew)
      if have node; then brew upgrade node || true; else brew install node; fi
      ;;
    *) die "Cannot install Node.js automatically. Install Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} and re-run." ;;
  esac
  node_version_ok || die "Node.js install finished but 'node' >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is not on PATH. Open a new terminal and re-run."
fi

# Python 3 (many MCP servers need it; uv manages venvs but needs an interpreter).
if have python3; then
  ok "Python 3 already installed ($(command -v python3))"
else
  step "Installing Python 3"
  case "$PM" in
    pacman) pm_install python ;;
    brew)   pm_install python ;;
    *)      pm_install python3 ;;
  esac || warn "Could not install Python 3 automatically; Python-based MCP servers will need it later."
fi

# uv (+uvx) via the official installer — same on every platform, installs to
# ~/.local/bin, no sudo needed. (Matches the Dockerfile.)
if have uv; then
  ok "uv already installed ($(command -v uv))"
else
  step "Installing uv"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
  if have uv; then ok "uv installed."; else warn "uv installed but not yet on PATH; open a new terminal if 'uv' is missing."; fi
fi

# Claude Code CLI (npm global) — needed only by the optional "Claude
# Subscription" model provider. Installed after Node/npm are present.
if have claude; then
  ok "Claude CLI already installed ($(command -v claude))"
else
  step "Installing Claude Code CLI via npm (@anthropic-ai/claude-code)"
  warn "(Only needed for the 'Claude Subscription' model provider; safe to skip otherwise.)"
  if npm install -g @anthropic-ai/claude-code; then
    ok "Claude CLI installed. Authenticate your subscription later with: claude setup-token"
  elif [ -n "$SUDO" ] && $SUDO npm install -g @anthropic-ai/claude-code; then
    ok "Claude CLI installed. Authenticate your subscription later with: claude setup-token"
  else
    warn "Could not install the Claude CLI."
    warn "Install it later (only for Claude Subscription) with: npm install -g @anthropic-ai/claude-code"
  fi
fi
CLAUDE_INSTALLED=$(have claude && echo true || echo false)

# Ollama (optional) — the local-model runtime. Installs the `ollama` daemon and
# starts `ollama serve`; FLUJO then reaches it over HTTP (default
# http://localhost:11434) and its onboarding can pull a model on demand. Only
# installed when the user opted in above.
if [ "$INSTALL_OLLAMA" = true ]; then
  if have ollama; then
    ok "Ollama already installed ($(command -v ollama))"
  else
    step "Installing Ollama (local model runtime)"
    if [ "$OS" = Darwin ]; then
      if have brew; then
        brew install ollama || warn "Could not install Ollama via Homebrew."
        # Homebrew does not auto-start services; launch the daemon as a service so
        # `ollama serve` is running when FLUJO looks for it.
        if brew services start ollama >/dev/null 2>&1; then
          ok "Ollama service started (brew services)."
        else
          warn "Start Ollama later with: brew services start ollama  (or run: ollama serve)"
        fi
      else
        warn "Homebrew not available; install Ollama from https://ollama.com/download"
      fi
    else
      # Linux: the official installer sets up and starts a systemd service, and
      # handles sudo itself, so it is preferred over the distro package managers.
      if curl -fsSL https://ollama.com/install.sh | sh; then
        ok "Ollama installed (systemd service configured)."
      else
        warn "Could not install Ollama automatically; see https://ollama.com/download"
      fi
    fi
    if have ollama; then
      ok "Ollama ready ($(command -v ollama))."
    else
      warn "Ollama installed but not yet on PATH; open a new terminal if 'ollama' is missing."
    fi
  fi
fi

# ---------------------------------------------------------------------------
# 3. Clone or update the repository.
# ---------------------------------------------------------------------------
if [ -d "$INSTALL_DIR/.git" ]; then
  step "Existing FLUJO clone found - updating ($BRANCH)"
  # Hard-reset instead of pull: `npm install`/`npm run build` rewrite
  # package-lock.json, leaving the tree dirty, so `git pull` aborts. This is an
  # install/deploy copy, not a dev checkout, so discarding tracked-file drift is
  # safe; untracked node_modules/.next/user data are preserved by reset --hard.
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
else
  step "Cloning FLUJO into $INSTALL_DIR"
  mkdir -p "$(dirname "$INSTALL_DIR")"
  git clone -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
fi

# ---------------------------------------------------------------------------
# 4. Install dependencies and build.
# ---------------------------------------------------------------------------
cd "$INSTALL_DIR"
step "Installing npm dependencies (npm install)"
# --include=dev: `next build` needs typescript/webpack/postcss (all
# devDependencies), which npm prunes when NODE_ENV=production.
npm install --include=dev

step "Building FLUJO (npm run build)"
npm run build
ok "Build complete."

# ---------------------------------------------------------------------------
# 5. Register the global 'flujo' command.
# ---------------------------------------------------------------------------
mkdir -p "$BIN_DIR"
LAUNCHER="$BIN_DIR/flujo"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
# FLUJO launcher - generated by install.sh
FLUJO_HOME="$INSTALL_DIR"
if [ ! -f "\$FLUJO_HOME/package.json" ]; then
  echo "FLUJO was not found at \$FLUJO_HOME. Please re-run the installer." >&2
  exit 1
fi
cd "\$FLUJO_HOME" || exit 1
echo "Starting FLUJO ... opening http://localhost:4200"
if command -v xdg-open >/dev/null 2>&1; then (xdg-open http://localhost:4200 >/dev/null 2>&1 &)
elif command -v open >/dev/null 2>&1; then (open http://localhost:4200 >/dev/null 2>&1 &)
fi
exec npm start -- "\$@"
EOF
chmod +x "$LAUNCHER"

case ":$PATH:" in
  *":$BIN_DIR:"*)
    ok "'flujo' command installed ($LAUNCHER)."
    ;;
  *)
    # Persist ~/.local/bin on PATH for future shells, once per rc file.
    RC_FILE="$HOME/.bashrc"
    case "${SHELL:-}" in */zsh) RC_FILE="$HOME/.zshrc" ;; esac
    if ! grep -qs 'Added by FLUJO installer' "$RC_FILE"; then
      printf '\n# Added by FLUJO installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$RC_FILE"
    fi
    export PATH="$BIN_DIR:$PATH"
    ok "'flujo' command installed (added $BIN_DIR to your PATH via $RC_FILE)."
    warn "Open a new terminal (or 'source $RC_FILE') before using 'flujo'."
    ;;
esac

# Desktop entry (Linux only; macOS users start FLUJO with the 'flujo' command).
if [ "$MAKE_SHORTCUT" = true ]; then
  APPS_DIR="$HOME/.local/share/applications"
  mkdir -p "$APPS_DIR"
  cat > "$APPS_DIR/flujo.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=FLUJO
Comment=Start FLUJO
Exec=$LAUNCHER
Path=$INSTALL_DIR
Terminal=true
Icon=$INSTALL_DIR/public/favicon.ico
Categories=Development;
EOF
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  ok "Desktop entry created: $APPS_DIR/flujo.desktop"
fi

# ---------------------------------------------------------------------------
# 6. Record what this install did, so a future uninstall can reverse it.
# ---------------------------------------------------------------------------
mkdir -p "$MANIFEST_DIR"
# Ollama is only recorded when the user chose to install it, so a future
# uninstaller offers to remove only what this run actually added. The leading
# comma continues the prerequisites array (the uv entry has none).
OLLAMA_MANIFEST=''
if [ "$INSTALL_OLLAMA" = true ]; then
  OLLAMA_MANIFEST=$(printf ',\n    { "command": "ollama",  "displayName": "Ollama",                  "preexisting": %s }' "$PRE_OLLAMA")
fi
cat > "$MANIFEST_DIR/install-manifest.json" <<EOF
{
  "schema": 1,
  "platform": "$OS",
  "packageManager": "$PM",
  "installDir": "$INSTALL_DIR",
  "binDir": "$BIN_DIR",
  "branch": "$BRANCH",
  "repoUrl": "$REPO_URL",
  "desktopShortcut": $MAKE_SHORTCUT,
  "claudeCli": {
    "installed": $CLAUDE_INSTALLED,
    "preexisting": $PRE_CLAUDE,
    "npmPackage": "@anthropic-ai/claude-code"
  },
  "prerequisites": [
    { "command": "git",     "displayName": "Git",                     "preexisting": $PRE_GIT },
    { "command": "node",    "displayName": "Node.js (includes npm)",  "preexisting": $PRE_NODE },
    { "command": "python3", "displayName": "Python 3",                "preexisting": $PRE_PYTHON },
    { "command": "uv",      "displayName": "uv",                      "preexisting": $PRE_UV }$OLLAMA_MANIFEST
  ]
}
EOF
ok "Uninstall manifest written: $MANIFEST_DIR/install-manifest.json"

# ---------------------------------------------------------------------------
# 7. Done — start now or explain how to.
# ---------------------------------------------------------------------------
if [ "$START_AFTER" = true ]; then
  step "Starting FLUJO (npm start) - open http://localhost:4200"
  exec "$LAUNCHER"
else
  printf '\n%sDone! Start FLUJO from any folder by typing:%s\n' "$C_OK" "$C_END" >&2
  printf '%s    flujo%s\n' "$C_OK" "$C_END" >&2
  printf '%s(in a new terminal). Then open http://localhost:4200%s\n' "$C_OK" "$C_END" >&2
fi
