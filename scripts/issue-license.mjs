#!/usr/bin/env node
/**
 * Mints a signed licence key.
 *
 * This is the issuer, and it is the only thing that can create a licence — the
 * desktop app and the landing page only ever verify. Keep the private key out
 * of the repo and off user machines.
 *
 * Usage:
 *   node scripts/issue-license.mjs --email buyer@example.com [--tier premium]
 *                                  [--expires 2027-01-01] [--key path.pem]
 *
 *   node scripts/issue-license.mjs --generate-keypair
 *
 * The public half belongs in DSV_LICENSE_PUBLIC_KEY at build time; see
 * packages/api/src/services/license-keys.ts.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  generateLicenseKeyPair,
  signLicensePayload,
} from "../packages/api/dist/services/license-keys.js";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const name = arg.slice(2);
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) {
    args.set(name, "true");
  } else {
    args.set(name, next);
    i++;
  }
}

if (args.has("generate-keypair")) {
  const { publicKeyPem, privateKeyPem } = generateLicenseKeyPair();
  const out = args.get("out") ?? "license-issuer";
  writeFileSync(`${out}.private.pem`, privateKeyPem, { mode: 0o600 });
  writeFileSync(`${out}.public.pem`, publicKeyPem);
  process.stdout.write(
    `Wrote ${out}.private.pem (keep secret) and ${out}.public.pem\n\n` +
      `Set this at build time so the app trusts it:\n\n` +
      `  DSV_LICENSE_PUBLIC_KEY="${publicKeyPem.trim()}"\n`,
  );
  process.exit(0);
}

const email = args.get("email");
if (!email) {
  process.stderr.write(
    "Usage: node scripts/issue-license.mjs --email <address> [--tier premium] [--expires YYYY-MM-DD] [--key path.pem]\n",
  );
  process.exit(1);
}

const keyPath = args.get("key") ?? ".dev-license-private-key.pem";
let privateKeyPem;
try {
  privateKeyPem = readFileSync(keyPath, "utf8");
} catch {
  process.stderr.write(
    `Couldn't read the signing key at ${keyPath}.\n` +
      `Generate one with: node scripts/issue-license.mjs --generate-keypair\n`,
  );
  process.exit(1);
}

const expires = args.get("expires");
const key = signLicensePayload(
  {
    v: 1,
    email,
    tier: args.get("tier") === "free" ? "free" : "premium",
    expiresAt: expires ? new Date(`${expires}T00:00:00.000Z`).toISOString() : null,
    issuedAt: new Date().toISOString(),
    id: `lic_${randomUUID().slice(0, 8)}`,
  },
  privateKeyPem,
);

process.stdout.write(`${key}\n`);
