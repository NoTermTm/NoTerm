#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const args = {
    latestUrl: "",
    strict: false,
    pubkey: "",
    timeoutMs: 60_000,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--latest-url") {
      args.latestUrl = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (token === "--pubkey") {
      args.pubkey = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (token === "--strict") {
      args.strict = true;
      continue;
    }
    if (token === "--timeout-ms") {
      const value = Number(argv[i + 1] ?? "0");
      if (Number.isFinite(value) && value > 0) args.timeoutMs = value;
      i += 1;
      continue;
    }
  }

  return args;
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
    }
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status} ${resp.statusText} for ${url}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function ensureSemver(version) {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version);
}

function spawnCollect(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function hasMinisign() {
  const result = await spawnCollect("minisign", ["-v"]).catch(() => null);
  return Boolean(result);
}

async function verifyWithMinisign(payloadBuffer, signatureText, pubkey) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "updater-verify-"));
  const payloadPath = path.join(tempDir, "payload.bin");
  const sigPath = path.join(tempDir, "payload.sig");
  try {
    await fs.writeFile(payloadPath, payloadBuffer);
    await fs.writeFile(sigPath, `${signatureText.trim()}\n`, "utf8");
    const result = await spawnCollect("minisign", ["-Vm", payloadPath, "-P", pubkey, "-x", sigPath]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || "minisign verify failed");
    }
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.latestUrl) {
    throw new Error("Missing --latest-url");
  }

  const latestRaw = await fetchText(args.latestUrl, args.timeoutMs);
  let latest;
  try {
    latest = JSON.parse(latestRaw);
  } catch {
    throw new Error("latest.json is not valid JSON");
  }

  if (!latest || typeof latest !== "object") {
    throw new Error("latest.json root must be an object");
  }

  const version = String(latest.version ?? "");
  if (!ensureSemver(version)) {
    throw new Error(`latest.json version must be semver without 'v' prefix, got: ${version}`);
  }

  const platforms = latest.platforms;
  if (!platforms || typeof platforms !== "object" || Object.keys(platforms).length === 0) {
    throw new Error("latest.json platforms is empty");
  }

  const strictEnabled = args.strict;
  const minisignReady = strictEnabled ? await hasMinisign() : false;
  if (strictEnabled && !minisignReady) {
    throw new Error("Strict mode requested, but minisign command is not available");
  }
  if (strictEnabled && !args.pubkey.trim()) {
    throw new Error("Strict mode requested, but --pubkey is empty");
  }

  const entries = Object.entries(platforms);
  for (const [platform, meta] of entries) {
    if (!meta || typeof meta !== "object") {
      throw new Error(`Platform '${platform}' has invalid meta`);
    }
    const url = String(meta.url ?? "");
    const signature = String(meta.signature ?? "").trim();
    if (!url || !/^https?:\/\//.test(url)) {
      throw new Error(`Platform '${platform}' has invalid url: ${url}`);
    }
    if (!signature) {
      throw new Error(`Platform '${platform}' has empty signature`);
    }

    const sigUrl = `${url}.sig`;
    const remoteSig = (await fetchText(sigUrl, args.timeoutMs)).trim();
    if (remoteSig !== signature) {
      throw new Error(
        `Signature mismatch for '${platform}': latest.json != ${sigUrl}`,
      );
    }

    if (strictEnabled) {
      const payload = await fetchBuffer(url, args.timeoutMs);
      await verifyWithMinisign(payload, signature, args.pubkey.trim());
    }

    console.log(`[OK] ${platform}`);
  }

  console.log(`Verification passed for ${entries.length} platform(s).`);
}

main().catch((error) => {
  console.error(`[FAIL] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

