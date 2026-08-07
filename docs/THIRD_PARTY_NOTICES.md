# Third-party notices

## Licensing summary

The contracts in `packages/contracts/src` are **GPL-2.0-or-later**, because they
incorporate Uniswap V3 library code under that licence. The off-chain applications
(`apps/`) and shared packages (`packages/config`, `packages/sdk`) contain no GPL code and
are also released under GPL-2.0-or-later for consistency across the repository.

## Vendored code

### Uniswap V3 Core

- Repository: https://github.com/Uniswap/v3-core
- Branch `0.8`, commit `6562c52e8f75f0c10f9deaf44861847585fc8129`
- Repository licence: BUSL-1.1, whose change date has passed; individual files carry their
  own SPDX identifiers, which are what govern.

Vendored verbatim into `packages/contracts/src/vendor/uniswap/`, with a provenance header
prepended and nothing else changed. `forge fmt` is configured to skip this directory so the
files stay byte-comparable with upstream.

| File | SPDX | Used by |
|---|---|---|
| `TickMath.sol` | GPL-2.0-or-later | `TickPriceMath` — tick ↔ sqrt price |
| `FullMath.sol` | MIT | `TickPriceMath` — 512-bit `mulDiv` |
| `Oracle.sol` | GPL-2.0-or-later | **test mocks only.** Lets `MockUniswapV3Pool` reproduce `observe()` exactly rather than approximating it. Not part of any deployed contract |

Vendored rather than depended on because `forge install` repeatedly resolved the default
(Solidity 0.7) branch over the `0.8` branch, silently breaking the build. Pinning the exact
files with their commit is more honest and more stable.

### Adapted code

`packages/contracts/src/libraries/TickPriceMath.sol` adapts
`OracleLibrary.getQuoteAtTick` and the mean-tick rounding convention from
[Uniswap V3 Periphery](https://github.com/Uniswap/v3-periphery) (GPL-2.0-or-later).

Changes from the original:

- takes an explicit `baseIsToken0` flag instead of comparing token addresses, so the
  ordering is resolved once at construction from the pool itself;
- adds a bounds check on the computed mean tick, so a malformed or hostile pool reverts
  rather than silently truncating a nonsense tick into a plausible-looking price.

### OpenZeppelin Contracts

- https://github.com/OpenZeppelin/openzeppelin-contracts v5.1.0, MIT
- Used: `AccessControl`, `Pausable`, `ReentrancyGuard`

### Foundry / forge-std

- https://github.com/foundry-rs/forge-std, MIT/Apache-2.0. Test and script tooling only.

## Studied but not copied

The brief asked that PancakeSwap Prediction be studied for its rolling-epoch architecture.
It was, and the overlapping previous/live/next structure is conceptually similar. **No
PancakeSwap code was copied**, and the differences are substantive rather than cosmetic:

| | PancakeSwap Prediction | This implementation |
|---|---|---|
| Price source | Chainlink round at execution time | Uniswap V3 TWAP over a window fixed by the schedule |
| Timing dependence | Price is whatever the oracle says when the keeper lands | Price is a pure function of the round's timestamps |
| Lifecycle access | Operator-gated | Permissionless |
| Schedule | Drifts with keeper latency | Derived from stored timestamps; cannot drift |
| Progression | Blocked if the oracle is unavailable | Decoupled; prices attach later |
| Empty side | Fee still taken | No contest, full refund, no fee |
| Per-round terms | Global config applies | Oracle, window and fee snapshotted per round |

PancakeSwap's contracts are MIT-licensed, so reuse would have been permitted. It was not
needed.

## Runtime dependencies

| Package | Licence |
|---|---|
| next, react, react-dom | MIT |
| wagmi, viem | MIT |
| @tanstack/react-query | MIT |
| tailwindcss, postcss, autoprefixer | MIT |
| pg | MIT |
| ioredis | MIT |
| typescript, tsx, vitest | Apache-2.0 / MIT |

wagmi's `coinbaseWallet` connector is deliberately not registered — it pulls in Coinbase's
Base Account SDK, which carries unmet optional dependencies. Coinbase Wallet connects
through `injected()` and WalletConnect regardless.

## Trademarks

"Robinhood" and "Pons" are used only to identify the network and the token. This project
is not operated, endorsed, sponsored by, or affiliated with either. The application's own
name is **Tickwise**.
