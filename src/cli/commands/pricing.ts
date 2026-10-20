import { Command } from "commander";
import { RegistryAPI } from "../../lib/api.js";
import { loadConfig, saveConfig } from "../../lib/config.js";
import { loadOrCreateWallet, spentToday } from "../../lib/wallet.js";

async function requireConfig() {
  const config = await loadConfig(process.cwd());
  if (!config?.agent_id || !config.agent_key) {
    console.error("  No agent in this directory. Run `stroodle init` first.");
    process.exit(1);
  }
  return config;
}

export const pricingCommand = new Command("pricing")
  .description("Charge for your agent (x402, USDC on Base Sepolia testnet) and set what it may spend");

pricingCommand
  .command("show")
  .description("Show price, wallet and budget")
  .action(async () => {
    const config = await requireConfig();
    const { wallet } = await loadOrCreateWallet(config.slug!);
    console.log(`\n  price:   ${config.pricing ? `$${config.pricing.price_usd} per task` : "free"}`);
    console.log(`  wallet:  ${wallet.address}`);
    const b = config.budget ?? { per_task_usd: 0, per_day_usd: 0 };
    console.log(`  budget:  $${b.per_task_usd} per task, $${b.per_day_usd} per day (spent today: $${(await spentToday(config.slug!)).toFixed(4)})\n`);
  });

pricingCommand
  .command("set <usd>")
  .description("Charge this much per task, e.g. 0.001")
  .action(async (usd: string) => {
    const config = await requireConfig();
    const { wallet, created } = await loadOrCreateWallet(config.slug!);
    const api = new RegistryAPI(config.registry_url, config.agent_key);
    try {
      await api.setPricing(config.agent_id!, wallet.address, usd.replace(/^\$/, ""));
    } catch (err) {
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    config.pricing = { price_usd: usd.replace(/^\$/, "") };
    await saveConfig(config, process.cwd());
    console.log(`\n  Charging $${config.pricing.price_usd} per task, paid to ${wallet.address}${created ? " (new wallet)" : ""}.\n`);
  });

pricingCommand
  .command("off")
  .description("Make the agent free again")
  .action(async () => {
    const config = await requireConfig();
    const api = new RegistryAPI(config.registry_url, config.agent_key);
    await api.setPricing(config.agent_id!, null, null);
    delete config.pricing;
    await saveConfig(config, process.cwd());
    console.log("\n  The agent is free.\n");
  });

pricingCommand
  .command("budget")
  .description("What this agent may spend when it buys from other agents")
  .requiredOption("--per-task <usd>", "Most it pays for one task")
  .requiredOption("--per-day <usd>", "Most it pays per day")
  .action(async (opts: { perTask: string; perDay: string }) => {
    const config = await requireConfig();
    config.budget = { per_task_usd: Number(opts.perTask), per_day_usd: Number(opts.perDay) };
    await saveConfig(config, process.cwd());
    console.log(`\n  Budget: $${opts.perTask} per task, $${opts.perDay} per day.\n`);
  });

export const walletCommand = new Command("wallet")
  .description("Show this agent's wallet address and its testnet USDC balance")
  .action(async () => {
    const config = await requireConfig();
    const { wallet } = await loadOrCreateWallet(config.slug!);
    console.log(`\n  address: ${wallet.address}`);
    try {
      const { createPublicClient, http, erc20Abi } = await import("viem");
      const { baseSepolia } = await import("viem/chains");
      const client = createPublicClient({ chain: baseSepolia, transport: http() });
      const balance = await client.readContract({
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [wallet.address],
      });
      console.log(`  USDC (Base Sepolia): ${(Number(balance) / 1e6).toFixed(6)}`);
    } catch {
      console.log("  USDC balance: could not be read");
    }
    console.log("  Fund it with testnet USDC from the Circle or Coinbase CDP faucet. USDC only, no ETH needed.\n");
  });
