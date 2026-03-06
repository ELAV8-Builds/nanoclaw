# TASK: Build Sovereign Stack Tauri App

> **Priority**: High
> **Type**: Full application build
> **Estimated effort**: 15-18 days across 4 phases
> **Tech stack**: Tauri 2.0 (Rust backend) + React + TypeScript + Tailwind CSS
> **Repo to create**: `sovereign-stack-app` (under the org that has NanoClaw)

---

## Summary

Build a native macOS app that replaces the manual 12-phase, ~100-command Sovereign Stack setup process with a visual setup wizard and ongoing service control panel. The app uses Tauri 2.0 (Rust backend, React frontend) and embeds a .pkg installer for the one-time root operations (user creation, OS hardening). Ships as a signed, notarized DMG.

This is the Sovereign Stack building a Tauri version of its own installer and dashboard -- the stack building its own front door.

---

## What Ships

```
Sovereign Stack.dmg
  └── Sovereign Stack.app (Tauri, ~5MB)
        ├── Setup Wizard (13-step guided install)
        ├── Control Panel Dashboard (7 services, logs, config)
        ├── Embedded .pkg (root ops: user creation, OS hardening)
        └── Helix Server (Docker Compose stack, self-hosted, replaces desktop app)
```

---

## Architecture

### Two-Layer Design

1. **Tauri App** (runs as admin user, no root): Handles everything that doesn't need root -- Homebrew, dependencies, repo cloning, service config, LaunchAgent management, Helix server management, ongoing dashboard.
2. **Embedded .pkg** (runs once with admin prompt via macOS Installer.app): Handles root-only operations -- creating the `sovereign` user, OS hardening (firewall, pmset, mDNS), directory structure with correct ownership.
3. **Helix Server** (Docker Compose stack): The open source Helix control plane + supporting services, managed by the Tauri app. Replaces the proprietary Helix desktop app. Same API, same sandboxes, no separate app to run.

### Tech Stack

- **App shell**: Tauri 2.0 (Rust backend, ~3-5MB binary vs Electron's ~150MB)
- **Frontend**: React 19 + TypeScript + Tailwind CSS + Vite
- **Privileged installer**: .pkg built with `pkgbuild` + `productbuild`
- **Service management**: Rust backend shells out to `launchctl`, reads logs, checks ports
- **Helix server**: Docker Compose stack (control plane, postgres, typesense, chrome, searxng) managed by the app
- **Secrets**: macOS Keychain via `security` CLI (not .env files on disk)
- **Auto-update**: Tauri updater plugin with GitHub Releases backend

### Project Structure

```
sovereign-stack-app/
  src-tauri/
    src/
      lib.rs                 # Tauri plugin registration + command exports
      main.rs                # Tauri app entry point
      commands/
        mod.rs
        preflight.rs         # macOS version, arch, disk space, Xcode CLT
        setup.rs             # Homebrew, deps, repo clone, config
        services.rs          # launchctl start/stop/status, port checks
        config.rs            # Read/write config, Keychain access
        system.rs            # .pkg invocation, privilege escalation
        docker.rs            # Docker readiness, container management
        ollama.rs            # Model list, pull with progress, status
        helix.rs             # Helix server: compose up/down, health, sandbox status
    resources/
      sovereign-setup.pkg   # Built by build-pkg.sh
      helix/
        docker-compose.yaml  # Helix server stack
        .env.template        # Template for Helix env vars
    Cargo.toml
    tauri.conf.json
    build.rs
    icons/
  src/
    main.tsx                 # React entry
    App.tsx                  # Router (wizard vs dashboard)
    theme/
      tokens.ts              # CSS variables from design system
      globals.css            # Base styles, Inter + JetBrains Mono
    pages/
      SetupWizard.tsx        # Multi-step wizard container
      Dashboard.tsx          # Service grid + controls
      Logs.tsx               # Real-time log viewer
      Settings.tsx           # Config editor
    components/
      ServiceCard.tsx        # Status card (green/red/yellow)
      WizardStep.tsx         # Step container with progress
      Terminal.tsx           # Embedded terminal output display
      ProgressBar.tsx        # For Ollama pulls, installs
      KeyInput.tsx           # Secure API key input
      LogViewer.tsx          # Scrolling log tail
      Sidebar.tsx            # Navigation
      StatusBadge.tsx        # Service status indicator
    hooks/
      useServiceStatus.ts    # Poll service health
      useCommand.ts          # Invoke Tauri commands
      useLogs.ts             # Stream log files
    lib/
      tauri.ts               # Typed Tauri invoke wrappers
      services.ts            # Service definitions (name, port, health URL)
  package.json
  tsconfig.json
  vite.config.ts
  tailwind.config.ts
  postcss.config.js
  index.html
  pkg-scripts/
    postinstall.sh           # Root operations (user create, OS harden)
    preinstall.sh            # Pre-checks
  build-pkg.sh               # Builds sovereign-setup.pkg
  build-dmg.sh               # Full build pipeline
```

---

## Design System

Use the Sovereign Stack design system (dark theme, electric blue accents):

```css
:root {
  --bg-deepest: #050508;
  --bg-deep: #0a0a0f;
  --bg-surface: #12121a;
  --bg-card: #1a1a24;
  --bg-card-hover: #22222e;
  --border: #2a2a3a;
  --border-glow: #3b82f620;
  --text-primary: #ffffff;
  --text-secondary: #a0a0b0;
  --text-muted: #64748b;
  --accent-blue: #00d4ff;
  --accent-blue-dim: #00d4ff40;
  --accent-indigo: #3b82f6;
  --accent-red: #ef4444;
  --accent-green: #22d3ee;
  --accent-purple: #8b5cf6;
  --accent-amber: #f59e0b;
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', monospace;
}
```

Visual style: glassmorphism nav/sidebar (`backdrop-filter: blur(20px)`), cards with subtle border glow on hover, dark backgrounds with blue accent highlights.

---

## Phase 1: Foundation (3-4 days)

### 1a. Scaffold Tauri 2.0 project

```bash
cargo install tauri-cli --version "^2"
npm create tauri-app@latest sovereign-stack-app -- --template react-ts --manager npm
cd sovereign-stack-app
npm install
npm install -D tailwindcss @tailwindcss/vite
```

### 1b. Configure tauri.conf.json

- `identifier`: `com.sovereign.stack`
- `bundle.macOS.dmg`: custom background, icon positions
- `bundle.resources`: `["resources/sovereign-setup.pkg"]`
- `security.csp`: restrict to localhost origins
- `app.windows[0]`: 1200x800, titled "Sovereign Stack", dark title bar

### 1c. Rust command layer

Each command is a `#[tauri::command]` that shells out to existing patterns:

**preflight.rs**:
- `check_macos_version() -> Result<String, String>` -- `sw_vers -productVersion`
- `check_architecture() -> Result<String, String>` -- `uname -m`
- `check_disk_space() -> Result<u64, String>` -- `df -g /`
- `check_xcode_clt() -> Result<bool, String>` -- `xcode-select -p`
- `check_homebrew() -> Result<bool, String>` -- `which brew`

**system.rs**:
- `run_pkg_installer(pkg_path: String) -> Result<(), String>` -- `open <pkg>` triggers macOS Installer.app

**setup.rs**:
- `install_homebrew() -> Result<(), String>` -- runs the Homebrew install script
- `install_brew_package(name: String) -> Result<String, String>` -- `brew install <name>`
- `clone_repo(url: String, dest: String) -> Result<(), String>` -- `git clone`
- `run_npm_build(dir: String) -> Result<(), String>` -- `cd <dir> && npm run build`

**services.rs**:
- `check_port(port: u16) -> Result<bool, String>` -- `lsof -i :<port> -P -n | grep LISTEN`
- `launchctl_load(plist: String) -> Result<(), String>`
- `launchctl_unload(plist: String) -> Result<(), String>`
- `get_service_status(name: String) -> Result<ServiceStatus, String>` -- combines port check + HTTP health

**config.rs**:
- `read_env_file(path: String) -> Result<HashMap<String, String>, String>`
- `write_env_value(path: String, key: String, value: String) -> Result<(), String>`
- `keychain_store(service: String, key: String, value: String) -> Result<(), String>` -- `security add-generic-password`
- `keychain_read(service: String, key: String) -> Result<String, String>` -- `security find-generic-password`

**docker.rs**:
- `is_docker_running() -> Result<bool, String>` -- `docker info`
- `start_container(name: String) -> Result<(), String>` -- `docker start <name>`
- `docker_compose_up(dir: String) -> Result<(), String>`

**ollama.rs**:
- `list_models() -> Result<Vec<Model>, String>` -- `ollama list`
- `pull_model(name: String) -> Result<(), String>` -- `ollama pull <name>` with progress events via Tauri channels

Example Rust pattern:

```rust
use std::process::Command;

#[tauri::command]
async fn check_port(port: u16) -> Result<bool, String> {
    let output = Command::new("lsof")
        .args(["-i", &format!(":{}", port), "-P", "-n"])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).contains("LISTEN"))
}
```

### 1d. Build the .pkg installer

**pkg-scripts/postinstall.sh** (runs as root via macOS Installer.app):

```bash
#!/bin/bash
set -e

# Create sovereign user (standard, no admin)
sysadminctl -addUser sovereign -fullName "Sovereign" -password "" -home /Users/sovereign

# Lock down home directory
chmod 700 /Users/sovereign

# Create directory structure
STACK="/Users/sovereign/sovereign-stack"
mkdir -p "$STACK"/{nanoclaw,memu,memu-server,anythingllm,logs,bin}
mkdir -p "$STACK/nanoclaw/groups"/{global,main,overlord,strategist,architect,toolsmith,researcher,radar,builder,reviewer,devops}
chown -R sovereign:staff "$STACK"
chmod -R g+rwX "$STACK/nanoclaw/groups"
chmod g+s "$STACK/nanoclaw/groups"

# Bridge directory (both users can read/write)
mkdir -p /Users/Shared/sovereign-deploy
chmod 777 /Users/Shared/sovereign-deploy

# OS hardening
/usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on
/usr/libexec/ApplicationFirewall/socketfilterfw --setstealthmode on
pmset -a sleep 0 displaysleep 30 disksleep 0 autorestart 1
defaults write /Library/Preferences/com.apple.mDNSResponder.plist NoMulticastAdvertisements -bool YES
killall -HUP mDNSResponder
```

Build commands:

```bash
pkgbuild --nopayload --scripts pkg-scripts/ \
  --identifier com.sovereign.setup --version 1.0 \
  sovereign-setup-component.pkg

productbuild --package sovereign-setup-component.pkg \
  src-tauri/resources/sovereign-setup.pkg
```

---

## Phase 2: Setup Wizard UI (4-5 days)

### 12 Wizard Steps

| Step | What Happens | Execution Context |
|------|-------------|-------------------|
| 1. Welcome + Pre-flight | Check macOS >= 13, Apple Silicon, 50GB free, no existing sovereign user | App |
| 2. System Setup | Trigger .pkg install (admin prompt), creates sovereign user + OS hardening | .pkg (root) |
| 3. Install Homebrew | Run Homebrew installer script | App |
| 4. Install Dependencies | `brew install` Node 22, Python 3.12, Docker Desktop, Ollama, git, age, gh | App |
| 5. Pull Ollama Models | `ollama pull` with progress bars for qwen3:32b, qwen2.5-coder:32b, nomic-embed-text | App |
| 6. Clone Repositories | Clone NanoClaw + memU into sovereign's stack via /Users/Shared/ bridge | App |
| 7. Configure Services | API key input (Anthropic, GitHub), LiteLLM config, NanoClaw .env | App |
| 8. Install LaunchAgents | Template plists, inject env vars via plutil, copy to ~/Library/LaunchAgents/ | App |
| 9. Start Services | `launchctl load` all 5 plists, verify ports come up | App |
| 10. Verify | Health check all 6 services, show green/red status grid | App |
| 11. Seed Tasks | Run create-scheduled-tasks.sh (morning briefing, weekly review, heartbeat, radar) | App |
| 12. Complete | Show dashboard, link to Slack/Helix setup docs for manual steps | App |

### Key Components

- **WizardStep.tsx**: Step indicator (1-12), title, description, action area, "Next" disabled until complete
- **Terminal.tsx**: Real-time command output streamed from Rust via Tauri events
- **ProgressBar.tsx**: For Ollama model pulls (parse percentage from output)
- **KeyInput.tsx**: Password-style input with "Test" button (validates against API)

### State Management

```typescript
type WizardState = {
  currentStep: number;
  completedSteps: Set<number>;
  config: {
    anthropicKey: string;
    githubToken: string;
    litellmMasterKey: string;
    ollamaModels: string[];
  };
  serviceStatus: Record<string, 'unknown' | 'running' | 'stopped' | 'error'>;
};
```

---

## Phase 3: Control Panel Dashboard (3-4 days)

### Service Definitions

```typescript
const SERVICES = [
  { name: 'Ollama',      port: 11434, healthUrl: '/api/tags',          plist: 'com.sovereign.ollama' },
  { name: 'LiteLLM',     port: 4000,  healthUrl: '/health/liveliness', plist: 'com.sovereign.litellm' },
  { name: 'memU',        port: 8090,  healthUrl: '/health',            plist: 'com.sovereign.memu' },
  { name: 'AnythingLLM', port: 3001,  healthUrl: '/api/v1/auth',       plist: 'com.sovereign.anythingllm' },
  { name: 'NanoClaw',    port: null,  process: 'dist/index.js',        plist: 'com.sovereign.nanoclaw' },
  { name: 'Helix',       port: 65178, healthUrl: '/api/v1/status',     plist: null },
];
```

### Dashboard Features

- **Service cards**: Poll every 5s. Green/red/yellow. Click to expand with start/stop/restart.
- **Log viewer**: Tail `/Users/sovereign/sovereign-stack/logs/*.log` via Tauri fs plugin.
- **Config editor**: Read/write .env files, LiteLLM config. API keys via Keychain.
- **Deploy button**: Replaces manual deploy.sh + install.sh two-terminal dance.
- **Agent status**: Show NanoClaw groups, last message timestamps from SQLite.

### Layout

Sidebar navigation (Dashboard, Services, Logs, Settings, Agents) + main content area. Sidebar uses glassmorphism. Cards in a responsive grid.

---

## Phase 4: Polish + Distribution (3-4 days)

- Code signing with Developer ID Application + Installer certificates
- Notarization via `xcrun notarytool submit` + `xcrun stapler staple`
- DMG customization (background image, icon layout)
- Auto-update via Tauri updater plugin with GitHub Releases
- Error handling, retry logic, edge cases

---

## Key Constraints

1. **Two-user permission model**: App runs as admin (barney2-equivalent). Uses `/Users/Shared/sovereign-deploy/` bridge to write files sovereign will own. Never writes directly to `/Users/sovereign/`.
2. **No root after .pkg**: The .pkg runs once. After that, the app never needs root again.
3. **Secrets in Keychain**: Not .env files. App reads from Keychain, injects into plists via `plutil -replace`.
4. **Shell wrappers, not reinvention**: Rust backend calls the same commands from existing start-all.sh, deploy.sh, etc.
5. **LaunchAgent plists are templates**: Replace hardcoded paths with variables rendered at install time.
6. **Docker Desktop can't be silently installed**: Wizard downloads and prompts manual install. Same for Helix.
7. **Ollama models (20GB+) download during setup**: Progress bars make this tolerable.

---

## Existing Reusable Assets

These scripts already work and should be wrapped, not rewritten:

| Script | Lines | What It Does |
|--------|-------|-------------|
| `deploy.sh` | 276 | Staging -> /Users/Shared/ pipeline, plutil secret injection |
| `start-all.sh` | 117 | Port checks, service startup, Docker management |
| `start-nanoclaw.sh` | 11 | OOM-tuned Node startup (NODE_OPTIONS=--max-old-space-size=4096) |
| `bin/start-memu-launchd.sh` | 26 | Docker readiness polling (120s timeout) |
| `create-scheduled-tasks.sh` | 128 | SQLite task seeding (4 scheduled tasks) |
| 5 LaunchAgent plists | ~30 each | Ollama, LiteLLM, NanoClaw, AnythingLLM, memU |

---

## Parallelizable Work Streams

These can be developed concurrently by different agents:

1. **Rust command layer** (preflight, setup, services, config, docker, ollama) -- independent modules
2. **React UI** (wizard steps, dashboard, logs, settings) -- can mock Tauri commands
3. **.pkg installer** (postinstall script, build pipeline) -- standalone
4. **Design system** (Tailwind config, component library) -- standalone
5. **Build pipeline** (build-pkg.sh, build-dmg.sh, signing/notarization) -- depends on 1-3

---

## Success Criteria

1. Fresh macOS machine: download DMG, drag to /Applications, launch
2. Setup wizard completes all 12 steps with no terminal needed
3. All 6 services running and green on dashboard
4. Can start/stop/restart any service from dashboard
5. Can view live logs from dashboard
6. Can edit API keys and config from Settings
7. App is code-signed and notarized (Gatekeeper passes)
8. Auto-update works via GitHub Releases
