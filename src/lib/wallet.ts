import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

// One wallet per agent (spec 047). The private key lives under ~/.stroodle/wallets, outside the
// project directory, so a prompt-injected agent that can read its own project cannot read it.

export interface Wallet {
  address: `0x${string}`;
  privateKey: `0x${string}`;
}

function walletsDir(): string {
  return join(homedir(), ".stroodle", "wallets");
}

function walletPath(slug: string): string {
  return join(walletsDir(), `${slug.replace(/[^a-z0-9-]/gi, "_")}.json`);
}

export async function loadWallet(slug: string): Promise<Wallet | null> {
  const p = walletPath(slug);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf-8")) as Wallet;
  } catch {
    return null;
  }
}

export async function loadOrCreateWallet(slug: string): Promise<{ wallet: Wallet; created: boolean }> {
  const existing = await loadWallet(slug);
  if (existing) return { wallet: existing, created: false };
  const privateKey = generatePrivateKey();
  const wallet: Wallet = { address: privateKeyToAccount(privateKey).address, privateKey };
  await mkdir(walletsDir(), { recursive: true, mode: 0o700 });
  const p = walletPath(slug);
  await writeFile(p, JSON.stringify(wallet, null, 2) + "\n", { mode: 0o600 });
  await chmod(p, 0o600);
  return { wallet, created: true };
}

// --- daily spend, so a buying agent cannot drain its wallet ---

interface Spend {
  day: string;
  usd: number;
}

function spendPath(slug: string): string {
  return walletPath(slug).replace(/\.json$/, ".spend.json");
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function spentToday(slug: string): Promise<number> {
  try {
    const s = JSON.parse(await readFile(spendPath(slug), "utf-8")) as Spend;
    return s.day === today() ? s.usd : 0;
  } catch {
    return 0;
  }
}

export async function recordSpend(slug: string, usd: number): Promise<void> {
  const total = (await spentToday(slug)) + usd;
  await mkdir(walletsDir(), { recursive: true, mode: 0o700 });
  await writeFile(spendPath(slug), JSON.stringify({ day: today(), usd: total }), { mode: 0o600 });
}
