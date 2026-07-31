# The PONS market on Robinhood Chain

Everything in this document was read back from chain 4663 before it was written down.
Where the brief stated a value, it is recorded here as *verified* or *corrected*, not
repeated on faith.

Audit performed 2026-09-03 around block 53,290,000–53,342,000.

## Network

| Property | Verified value | How |
|---|---|---|
| Chain ID | `4663` | `cast chain-id` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | live |
| Explorer | `https://robinhoodchain.blockscout.com` | live |
| **Block time** | **≈102.5 ms** | `(t[n] − t[n−20000]) / 20000` |

The block time is not a footnote. At ~10 blocks per second, many blocks share a single
`block.timestamp`, and Uniswap V3's oracle works in whole seconds. That single fact
shapes the whole oracle design — see [ORACLE.md](ORACLE.md).

## Tokens

| Token | Address | Decimals | Supply |
|---|---|---|---|
| PONS | `0x39dBED3a2bd333467115dE45665cC57F813C4571` | 18 | 1e27 (1 billion) |
| WETH | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | 18 | — |

PONS is a `PonsLauncherToken` — an OpenZeppelin v5 ERC-20 with launch protections. Those
protections **have expired**:

| Field | Value |
|---|---|
| `launchBlock` | 25,526,166 |
| `restrictionBlocks` | 366 |
| `restrictionEndBlock` | 25,526,532 |
| `block.number` seen by the EVM | ~25,899,000 |

**Note the block number carefully.** On this chain the `block.number` opcode and the RPC's
`eth_blockNumber` do not agree: `eth_blockNumber` reports ~53,600,000 while a contract
reading `block.number` sees ~25,899,000 (confirmed by calling `getBlockNumber()` on the
deployed Multicall3). `restrictionEndBlock` is compared against the *opcode*, so the
margin is ~372,000 blocks, not the ~27,800,000 an `eth_blockNumber` comparison suggests.
The conclusion is unchanged — the restrictions are expired either way — but anything else
reasoning about block heights on this chain has to pick the right one.

Nothing in this project depends on it: `PonsPrediction` and both oracles use
`block.timestamp` exclusively, and the indexer works in RPC block numbers throughout.

`_update` applies `maxWallet`/`maxTx` only while `block.number <= restrictionEndBlock`, so
PONS today behaves as a plain ERC-20: no transfer tax, no blacklist, no pause, no mint,
no proxy (both EIP-1967 slots are zero). Nothing about the token distorts the pool price
or interferes with settlement.

This matters for the threat model in the opposite direction from how it first appears:
the expired `maxTxLimit` of 22,000,000 PONS would have capped a manipulator's single
swap. It no longer does.

## The settlement pool

`0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA` — Uniswap V3, 1% fee tier.

| Property | Verified value |
|---|---|
| `token0` | **WETH** |
| `token1` | **PONS** |
| `fee` | 10000 (1%) |
| `tickSpacing` | 200 |
| `factory` | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` |
| in-range liquidity | ~1.4e23 |
| pool balances | ~1,200 WETH + ~5.2M PONS |
| `observationCardinality` | **20,000**, fully initialised |
| history span | **4.58 days** |

### PONS is token1, not token0

The brief warned against assuming the ordering, and the warning was warranted. Because
PONS is token1, the quoted PONS/WETH price is **strictly decreasing in tick**: a rising
tick means PONS is getting *cheaper* in WETH.

Getting this backwards would invert every round outcome while leaving the system looking
entirely healthy. It is therefore derived from the pool at construction
(`UniswapV3PonsOracle` resolves `baseIsToken0` by reading `token0()`/`token1()`), asserted
in `ConfigParity.t.sol`, and demonstrated by an actual trade in
`LiveMarketFork.t.sol::test_fork_sellingPonsLowersItsPrice`.

### The pool is canonical Uniswap V3

Confirmed by reproducing its address from the canonical CREATE2 derivation:

```
salt      = keccak256(abi.encode(WETH, PONS, 10000))
predicted = CREATE2(factory, salt, 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54)
          = 0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA   ✓ matches
```

Since the init-code hash matches the official `UniswapV3Pool`, the deployed bytecode is
stock v3-core. The oracle relies on precise `Oracle.write`/`observe` semantics, so this is
load-bearing, not trivia.

Two further checks: `factory.getPool(WETH, PONS, 10000)` returns this address, and PONS's
own `liquidityPool()` returns it too.

### A second pool the brief did not mention

`0xEd50bDeeA8aDC232f159486192a4157281D722ff` — Uniswap V3, **0.3%** fee tier.

| | 1% pool (settlement) | 0.3% pool |
|---|---|---|
| WETH | ~1,200 | ~584 |
| PONS | ~5.2M | ~1.85M |
| `observationCardinality` | 20,000 | 1,400 |

The 0.1% and 0.05% pools exist but hold nothing.

The 1% pool is the right settlement venue: it is materially deeper and it is what the
token itself designates. But the 0.3% pool is a real part of the threat model — PONS
liquidity is *split*, the oracle reads only one venue, and an attacker who moves only the
settlement pool creates an arbitrage gap against the other. That is discussed in
[MANIPULATION_ANALYSIS.md](MANIPULATION_ANALYSIS.md).

## Price

At the time of audit, PONS traded at roughly **2.16e14 wei of WETH per PONS**
(0.000216 WETH). Tick ≈ 84,400.

The brief's illustrative figure (0.000001237 WETH) is about 175× lower. Illustrations are
illustrations; the code reads the pool.

## Reproducing this audit

```bash
export ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com

# Addresses, ordering, fee tier, liquidity, TWAP availability
forge test --mc PonsOracleFork -vv

# Observation buffer: span, gap distribution, seal lag
python3 tools/onchain-audit/observations.py
```

Fork tests that *trade* (`LiveMarketFork`, `ManipulationCost`) read a lot of storage and
will be rate-limited by the public RPC. Point them at a local cache:

```bash
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port 8546 &
ROBINHOOD_RPC=http://127.0.0.1:8546 forge test --mc ManipulationCost -vv
```

> **Note on long-lived forks.** Anvil pins the block it forked at, and Robinhood Chain's
> public node prunes historical state. A fork left running for hours will start failing
> with `metadata is not found, <block>` when a test touches a storage slot it has not
> already cached. That is the node pruning, not a test failure — restart the fork to pick
> up a current block.
