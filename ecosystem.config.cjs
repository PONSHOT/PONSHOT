/**
 * pm2 process set for a continuously-running demo of the PONS prediction market.
 *
 * There is no production deployment on Robinhood Chain, so the site runs against a local
 * Anvil with the mock PONS/WETH pool. Two details make that survivable rather than a toy:
 *
 *  - Anvil is given `--state`, so a restart reloads the deployed contracts instead of
 *    silently coming back as an empty chain the frontend still points at.
 *  - A trader process moves the pool's tick. Uniswap only records an observation when a
 *    swap moves the tick, so without it every round would sit at "awaiting lock" forever
 *    and the site would look broken while being perfectly correct.
 *
 * Start with: pm2 start ecosystem.config.cjs
 */
const {resolve} = require("node:path");

const ROOT = __dirname;
const RPC = "http://127.0.0.1:8545";
const CHAIN_ID = "31337";
const DEPLOYMENTS = resolve(ROOT, "deployments/31337.json");
const DATABASE_URL = "postgres://pons:pons@127.0.0.1:55432/pons";

// Anvil's first well-known account. Local demo chain only — never reuse anywhere real.
const DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const common = {
  cwd: ROOT,
  autorestart: true,
  max_restarts: 20,
  // 78 is EX_CONFIG: the process refused to run because of how it was configured, not
  // because of a transient fault. Restarting cannot fix that, and looping on it buries
  // the one log line that explains the problem.
  stop_exit_codes: [78],
  restart_delay: 3000,
  merge_logs: true,
  time: true,
};

/**
 * Per-app log paths.
 *
 * pm2 does not expand `%NAME%` in `out_file`/`error_file`, so using it silently sends
 * every app's output to one shared pair of files — which makes `pm2 logs <app>` show
 * other apps' lines and is genuinely confusing during an incident.
 */
const logs = (name) => ({
  out_file: resolve(ROOT, `.pm2-logs/${name}.out.log`),
  error_file: resolve(ROOT, `.pm2-logs/${name}.err.log`),
});

module.exports = {
  apps: [
    {
      ...common,
      name: "pons-chain",
      ...logs("pons-chain"),
      script: "anvil",
      // --block-time 1 keeps the chain clock moving in real time, which rounds need.
      // --state persists the whole chain across restarts.
      args: [
        "--port", "8545",
        "--chain-id", CHAIN_ID,
        "--block-time", "1",
        "--gas-limit", "60000000",
        "--state", resolve(ROOT, ".dev/anvil-state.json"),
        "--silent",
      ].join(" "),
      interpreter: "none",
    },
    {
      ...common,
      name: "pons-keeper",
      ...logs("pons-keeper"),
      script: "npx",
      args: "tsx src/index.ts",
      cwd: resolve(ROOT, "apps/keeper"),
      env: {
        KEEPER_PRIVATE_KEY: DEV_KEY,
        CHAIN_ID,
        RPC_URLS: RPC,
        DEPLOYMENTS_PATH: DEPLOYMENTS,
        POLL_INTERVAL_MS: "3000",
        CONFIRMATIONS: "1",
        HEALTH_PORT: "8787",
        LOG_LEVEL: "info",
      },
    },
    {
      ...common,
      name: "pons-trader",
      ...logs("pons-trader"),
      script: "npx",
      args: "tsx scripts/local-trader.ts",
      env: {
        CHAIN_ID,
        RPC_URL: RPC,
        TICK_STEP: "25",
        // 0 = do not warp; Anvil's own --block-time advances the clock.
        WARP_SECONDS: "0",
        TRADE_INTERVAL_MS: "4000",
        // Demo entries from Anvil's development accounts. A market with empty pools is
        // correct but looks dead, and this is a demo chain — never set this against a
        // network where the stakes are real.
        DEMO_BETS: "true",
      },
    },
    {
      ...common,
      name: "pons-indexer",
      ...logs("pons-indexer"),
      script: "npx",
      args: "tsx src/index.ts",
      cwd: resolve(ROOT, "apps/indexer"),
      env: {
        CHAIN_ID,
        RPC_URLS: RPC,
        DATABASE_URL,
        DEPLOYMENTS_PATH: DEPLOYMENTS,
        CONFIRMATIONS: "2",
        POLL_INTERVAL_MS: "2000",
        HEALTH_PORT: "8788",
        LOG_LEVEL: "info",
        // Demo only. This chain is torn down and redeployed regularly, so each new market
        // legitimately supersedes the last. NEVER set this for a real deployment: it
        // discards the indexed history of whatever market was there before.
        INDEXER_RESET: "true",
      },
    },
    {
      ...common,
      name: "pons-api",
      ...logs("pons-api"),
      script: "npx",
      args: "tsx src/index.ts",
      cwd: resolve(ROOT, "apps/api"),
      env: {
        CHAIN_ID,
        RPC_URLS: RPC,
        DATABASE_URL,
        DEPLOYMENTS_PATH: DEPLOYMENTS,
        PORT: "8789",
        CORS_ORIGIN: "*",
      },
    },
    {
      ...common,
      name: "pons-web",
      ...logs("pons-web"),
      script: "npx",
      args: "next start -p 8894",
      cwd: resolve(ROOT, "apps/web"),
      env: {NODE_ENV: "production", PORT: "8894"},
    },
  ],
};
