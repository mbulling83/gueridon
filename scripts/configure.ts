#!/usr/bin/env npx tsx
/**
 * configure.ts — interactive setup wizard for ~/.config/gueridon/env
 *
 * Usage: npx tsx scripts/configure.ts
 */

import { createInterface } from "node:readline";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ENV_DIR = join(homedir(), ".config", "gueridon");
const ENV_FILE = join(ENV_DIR, "env");

// ---------------------------------------------------------------------------
// Load existing config
// ---------------------------------------------------------------------------

function loadExistingConfig(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const config: Record<string, string> = {};
  const lines = readFileSync(ENV_FILE, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    config[key] = val;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Tailscale hostname detection
// ---------------------------------------------------------------------------

function detectTailscaleHostname(): string | null {
  // Try `tailscale serve status` first — look for https://<hostname> on first line
  try {
    const output = execSync("tailscale serve status 2>/dev/null", {
      encoding: "utf8",
      timeout: 5000,
    });
    const firstLine = output.split("\n")[0] ?? "";
    const match = firstLine.match(/https:\/\/([^\s/]+)/);
    if (match) return match[1]!;
  } catch {
    // ignore
  }

  // Fallback: `tailscale status --json` → .Self.DNSName (strip trailing dot)
  try {
    const output = execSync("tailscale status --json 2>/dev/null", {
      encoding: "utf8",
      timeout: 5000,
    });
    const data = JSON.parse(output) as { Self?: { DNSName?: string } };
    const dns = data?.Self?.DNSName;
    if (dns) return dns.replace(/\.$/, "");
  } catch {
    // ignore
  }

  return null;
}

// ---------------------------------------------------------------------------
// readline helpers
// ---------------------------------------------------------------------------

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim());
    });
  });
}

function isYes(answer: string): boolean {
  return answer.toLowerCase().startsWith("y");
}

function isNo(answer: string): boolean {
  return answer.toLowerCase().startsWith("n");
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\nGuéridon configuration wizard\n");

  const existing = loadExistingConfig();

  // --- Q1: Tailscale hostname ---

  const detectedHostname = detectTailscaleHostname();
  const existingHostname = existing["TAILSCALE_HOSTNAME"];

  let hostnameDefault = detectedHostname ?? existingHostname ?? null;

  let hostnamePrompt: string;
  if (hostnameDefault) {
    hostnamePrompt = `Tailscale hostname [${hostnameDefault}]: `;
  } else {
    hostnamePrompt = `Tailscale hostname: `;
  }

  const hostnameAnswer = await ask(hostnamePrompt);
  const hostname =
    hostnameAnswer !== "" ? hostnameAnswer : (hostnameDefault ?? "");

  if (!hostname) {
    console.error("Error: hostname is required.");
    rl.close();
    process.exit(1);
  }

  // --- Q2: Sharing hostname with another service? ---

  // Default to Y/n if previously shared (TAILSCALE_PORT exists and isn't 443)
  const existingPort = existing["TAILSCALE_PORT"];
  const wasShared =
    existingPort !== undefined && existingPort !== "" && existingPort !== "443";
  const sharingDefault = wasShared ? "Y/n" : "y/N";

  const sharingAnswer = await ask(
    `Sharing this hostname with another service (e.g. Open WebUI)? [${sharingDefault}]: `
  );

  let isShared: boolean;
  if (sharingAnswer === "") {
    // Use default
    isShared = wasShared;
  } else if (isYes(sharingAnswer)) {
    isShared = true;
  } else if (isNo(sharingAnswer)) {
    isShared = false;
  } else {
    // Treat unrecognised input as default
    isShared = wasShared;
  }

  // --- Q3: HTTPS port (only if shared) ---

  let port: string | null = null;

  if (isShared) {
    const portDefault = existingPort && existingPort !== "443" ? existingPort : "8443";
    const portAnswer = await ask(`HTTPS port [${portDefault}]: `);
    port = portAnswer !== "" ? portAnswer : portDefault;
  }

  rl.close();

  // --- Write config ---

  mkdirSync(ENV_DIR, { recursive: true });

  const lines: string[] = [`TAILSCALE_HOSTNAME=${hostname}`];
  if (isShared && port) {
    lines.push(`TAILSCALE_PORT=${port}`);
  }

  writeFileSync(ENV_FILE, lines.join("\n") + "\n", "utf8");

  // --- Report ---

  const url =
    isShared && port
      ? `https://${hostname}:${port}/`
      : `https://${hostname}/`;

  console.log(`\nWritten: ${ENV_FILE}`);
  console.log(`Guéridon URL: ${url}`);
  console.log(`\nNext steps:`);
  console.log(
    `  sudo cp /opt/gueridon/gueridon.service /etc/systemd/system/`
  );
  console.log(
    `  sudo systemctl daemon-reload && sudo systemctl restart gueridon`
  );
  console.log();
}

main().catch((err: unknown) => {
  console.error("configure:", err);
  process.exit(1);
});
