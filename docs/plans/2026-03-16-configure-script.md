# Configure Script Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `npm run configure` — an interactive terminal script that asks for Tailscale hostname and port, then writes `~/.config/gueridon/env` so machine-specific config never touches the committed service file.

**Architecture:** `scripts/configure.ts` uses Node.js `readline` to ask questions one at a time, auto-detects defaults from `tailscale` CLI output, writes key=value pairs to `~/.config/gueridon/env`. The service file gets an `EnvironmentFile=` line pointing there; its hardcoded `TAILSCALE_HOSTNAME`/`TAILSCALE_PORT` lines are removed.

**Tech Stack:** Node.js readline (stdlib), tsx, systemd `EnvironmentFile=` with `%h` specifier.

---

### Task 1: Update gueridon.service — swap env vars for EnvironmentFile

**Files:**
- Modify: `gueridon.service`

No tests needed — purely declarative config.

**Step 1: Edit the service file**

Remove the two env lines added in the previous session and add an `EnvironmentFile` line. The `%h` specifier resolves to the home directory of the `User=` account at service start — no hardcoded paths.

The `[Service]` block should look like this after the edit:

```ini
[Service]
Type=simple
User=modha
WorkingDirectory=/opt/gueridon
Environment=HOME=/home/modha
Environment=PATH=/home/modha/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=ENABLE_CLAUDEAI_MCP_SERVERS=false
EnvironmentFile=-%h/.config/gueridon/env
ExecStart=/opt/gueridon/node_modules/.bin/tsx server/bridge.ts
KillMode=control-group
Restart=always
RestartSec=3
```

The `-` prefix on `EnvironmentFile` means systemd silently ignores a missing file — safe before `configure` has been run.

**Step 2: Commit**

```bash
git add gueridon.service
git commit -m "Use EnvironmentFile for machine-specific config — keep service template clean"
```

---

### Task 2: Create scripts/configure.ts

**Files:**
- Create: `scripts/configure.ts`

No unit tests — the script is interactive I/O glue with no extractable logic worth mocking. Verify manually.

**Step 1: Write the script**

```typescript
#!/usr/bin/env tsx
/**
 * configure.ts — interactive setup for ~/.config/gueridon/env
 *
 * Asks: Tailscale hostname, shared hostname? (y/n), HTTPS port.
 * Writes key=value pairs to ~/.config/gueridon/env.
 * Service file reads it via EnvironmentFile=-%h/.config/gueridon/env.
 */

import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ENV_DIR = join(homedir(), ".config", "gueridon");
const ENV_FILE = join(ENV_DIR, "env");

// -- Helpers --

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (ans) => resolve(ans.trim())));
}

function detectHostname(): string | null {
  try {
    const out = execSync("tailscale serve status 2>/dev/null", { encoding: "utf-8" });
    const match = out.match(/https:\/\/([^\s/:]+)/);
    return match ? match[1] : null;
  } catch {
    try {
      const out = execSync("tailscale status --json 2>/dev/null", { encoding: "utf-8" });
      const data = JSON.parse(out);
      const dns = data?.Self?.DNSName as string | undefined;
      return dns ? dns.replace(/\.$/, "") : null;
    } catch {
      return null;
    }
  }
}

function loadExisting(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const result: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, "utf-8").split("\n")) {
    const [k, ...rest] = line.split("=");
    if (k && rest.length) result[k.trim()] = rest.join("=").trim();
  }
  return result;
}

// -- Main --

async function main() {
  console.log("\nGuéridon configure\n");

  const existing = loadExisting();
  const detectedHost = detectHostname();

  // Q1: Tailscale hostname
  const defaultHost = existing.TAILSCALE_HOSTNAME || detectedHost || "";
  const hostPrompt = defaultHost
    ? `Tailscale hostname [${defaultHost}]: `
    : "Tailscale hostname (e.g. tube.atlas-cloud.ts.net): ";
  const hostnameInput = await ask(hostPrompt);
  const hostname = hostnameInput || defaultHost;

  if (!hostname) {
    console.error("Hostname is required.");
    process.exit(1);
  }

  // Q2: Shared hostname?
  const currentlyShared = existing.TAILSCALE_PORT && existing.TAILSCALE_PORT !== "443";
  const sharedDefault = currentlyShared ? "Y/n" : "y/N";
  const sharedInput = await ask(`Sharing this hostname with another service (e.g. Open WebUI)? [${sharedDefault}]: `);
  const shared =
    sharedInput === ""
      ? !!currentlyShared
      : sharedInput.toLowerCase().startsWith("y");

  // Q3: Port (only if shared)
  let port = "443";
  if (shared) {
    const defaultPort = (currentlyShared && existing.TAILSCALE_PORT) || "8443";
    const portInput = await ask(`HTTPS port for Guéridon [${defaultPort}]: `);
    port = portInput || defaultPort;
  }

  rl.close();

  // Write env file
  mkdirSync(ENV_DIR, { recursive: true });
  const lines = [`TAILSCALE_HOSTNAME=${hostname}`];
  if (shared) lines.push(`TAILSCALE_PORT=${port}`);
  writeFileSync(ENV_FILE, lines.join("\n") + "\n");

  const url = shared
    ? `https://${hostname}:${port}/`
    : `https://${hostname}/`;

  console.log(`\nWritten to ${ENV_FILE}`);
  console.log(`Guéridon URL: ${url}`);
  console.log(`\nNext steps:`);
  console.log(`  sudo cp /opt/gueridon/gueridon.service /etc/systemd/system/`);
  console.log(`  sudo systemctl daemon-reload && sudo systemctl restart gueridon`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**Step 2: Verify manually**

```bash
npx tsx scripts/configure.ts
# Walk through the prompts, confirm ~/.config/gueridon/env is written correctly
cat ~/.config/gueridon/env
# Expected: TAILSCALE_HOSTNAME=... (and TAILSCALE_PORT=... if shared)
```

**Step 3: Commit**

```bash
git add scripts/configure.ts
git commit -m "Add configure script — interactive setup for ~/.config/gueridon/env"
```

---

### Task 3: Add npm script to package.json

**Files:**
- Modify: `package.json`

**Step 1: Add the configure script entry**

In the `"scripts"` block, add alongside `start` and `test`:

```json
"configure": "tsx scripts/configure.ts"
```

**Step 2: Verify**

```bash
npm run configure -- --help 2>&1 || true
# Should launch the script (it will hang waiting for input — Ctrl+C is fine)
```

**Step 3: Commit**

```bash
git add package.json
git commit -m "Add npm run configure"
```

---

### Task 4: Update docs/deploy-guide.md

**Files:**
- Modify: `docs/deploy-guide.md`

**Step 1: Replace step 6 manual instructions**

Find the section:

```markdown
Edit the service file to set your hostname (and port, if using a dedicated port) before installing:
```bash
nano /opt/gueridon/gueridon.service
# Set: Environment=TAILSCALE_HOSTNAME=your-machine.your-tailnet.ts.net
# Set: Environment=TAILSCALE_PORT=8443   (omit if using default port 443)
` `` `
```

Replace with:

```markdown
Run the interactive configure script to set your hostname and port. It auto-detects the hostname from `tailscale serve status` and writes `~/.config/gueridon/env`:

` ```bash`
npm run configure
` ``` `
```

**Step 2: Commit**

```bash
git add docs/deploy-guide.md
git commit -m "docs: replace manual service file editing with npm run configure"
```
