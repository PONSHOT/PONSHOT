# Tokenomics

Every round's rake is spent buying tokens on the open market and destroying them. None of
it is protocol revenue.

## The split

| Case | Winners | Buyback and burn |
|---|--:|--:|
| Contested round (both sides had stake) | **90%** of the pot | **10%** of the pot |
| No winners — every entry was on the losing side | — | **100%** of the pot |
| No losers — nobody took the other side | full refund | nothing |
| Tie — the price did not move | full refund | nothing |
| Round cancelled (oracle outage past tolerance) | full refund | nothing |

The burn allocation is then split evenly:

| Target | Share |
|---|--:|
| PONS | 50% |
| Project token | 50% |

Both halves are bought with ETH and sent to `0x000000000000000000000000000000000000dEaD`,
which no key controls. Burning by transfer works for any ERC-20, including tokens with no
`burn` function, and anyone can verify the destroyed supply from the token's own balances.

## The two cases that are easy to get backwards

A round can be one-sided in two completely different ways, and they resolve oppositely.

**Every entry was wrong.** Everyone backed UP and the price fell. There is no winning side
to pay, so the whole pot funds the burn. This is the only case where a bettor loses their
entire stake to the protocol, and it requires every single entry in the round to have been
on the losing side. Outcome: `AllLost`.

**Nobody took the other side.** Everyone backed UP and the price rose. They were right,
but there was no counterparty, so nothing was won. Charging 10% here would be a penalty
for being right, so the round refunds in full and books nothing for the burn. Outcome:
`NoContest`.

The contract distinguishes them by which pool is empty *relative to the outcome*, not by
whether a pool is empty at all.

## Why the buyback is not inside settlement

The obvious implementation is a swap at the end of `settleRound`. It is not done that way,
for two reasons specific to this system.

**It would let the market move its own oracle.** The PONS buyback trades in the same pools
the settlement oracle reads. A swap inside settlement would push the price that the *next*
round's lock price is derived from, by an amount that is a deterministic function of how
much was staked. A bettor could size their entry to control the size of the buyback, and
so the push on the pool, and so the next round's price. Every figure in
[MANIPULATION_ANALYSIS.md](MANIPULATION_ANALYSIS.md) assumes the market is not itself a
trader in the pools it settles against.

**It would make settlement fallible.** Settlement is permissionless, which is what
guarantees a dead keeper cannot strand user funds. A swap can revert — thin liquidity, a
price limit, a paused pool — and a revert inside settlement would turn a tokenomics
feature into a liveness failure on a contract holding user stakes.

So settlement only *books* the amount. The flow is:

```
settleRound(epoch)        booked into burnAllocated, no external call
sweepToBurner()           ETH → PonsBuybackBurner, split 50/50 on arrival
buyAndBurn(0, …)          WETH → PONS  → 0x…dEaD
buyAndBurn(1, …)          WETH → SHOT  → 0x…dEaD
```

The keeper sends the sweep immediately after settling, so in wall-clock terms the buyback
happens right after the round ends. The difference from doing it inline is that a failed
buyback costs a retry instead of stalling the market.

## Why every step is permissionless

`sweepToBurner` cannot be aimed anywhere except the configured burner, so there is nothing
to gate; gating it would only add a way for the funds to get stuck behind an operator.

`buyAndBurn` is open for a less obvious reason: **the caller cannot choose the price it
executes at.** The minimum output is derived on chain from the pool's own TWAP over
`twapWindow`, discounted by `maxSlippageBps` (500bp at launch). A caller-supplied
`minAmountOut` is only honoured when it is *stricter*. So the worst a hostile caller can
arrange is a buyback at no worse than the time-weighted average price — which is the
intended behaviour. A per-window spend cap bounds it further.

Two guards worth naming explicitly:

- **A swap callback is authenticated twice**, against `msg.sender` and against the pool
  the contract believes it is currently swapping with. A callback arriving from anywhere
  else reverts.
- **Slippage tolerance is bounded by a constant** (`MAX_SLIPPAGE_BPS = 1000`), so no
  configuration can turn "tolerance" into "permission to buy at any price".

## Before the project token exists

`PROJECT_TOKEN` and `PROJECT_POOL` may be unset at deployment. The project half then
accrues in the burner untouched and becomes spendable once `setTarget` names a real token
and a pool that actually holds it against WETH.

It deliberately does **not** roll into the PONS side. Half the burn quietly becoming a
different token is a change to the tokenomics, and it should be a decision somebody makes,
not a default that fires because a config value was missing.

## Consequences worth stating

**There is no protocol revenue.** All of the rake is burned, so nothing funds operations.
The keeper spends a measured 0.000262 ETH per round on gas, and with this configuration
that has to come from somewhere else. See [issue #2](https://github.com/PONSHOT/PONSHOT/issues/2).

**The fee ceiling is 10% and is a constant.** `MAX_BURN_FEE_BPS` cannot be raised by any
role, so a bettor's guarantee — a contested round always pays back at least 90% of the pot
— is enforced by the contract rather than by governance. The launch value is exactly the
ceiling, which means the fee can only ever move down.

**The burn is not a price guarantee.** A buyback is a market purchase; it removes supply,
and what that does to the price depends on everything else happening in the pool. Nothing
here should be read as promising a price outcome.

## How it surfaces off chain

Nothing below decides anything; every figure is derived from a contract read or an
indexed event.

| Surface | What it shows |
|---|---|
| Entry dialog | The split, stated before staking: winners take 90%, 10% is burned, and the two one-sided rules in plain words |
| Round strip / history | `ALL BURNED` for a no-winner round, distinct from `REFUNDED` |
| Statistics page | Burned supply per token, ETH spent, ETH waiting, rounds with no winners |
| `GET /burn` | The same data as JSON, including whether the project target is configured |

Two details in that table are easy to get wrong and are worth calling out.

**`rewardBaseAmount === 0` does not mean "refunded".** A no-winner round pays nobody and a
refunded round pays nobody, and they look identical in the reward fields. The UI derives
the outcome with `deriveOutcome`, which mirrors `_trySettle`, rather than inferring it —
otherwise a round where everyone lost their stake would be labelled as one where everyone
got it back.

**Burned totals are sums over `BoughtAndBurned` events**, not a counter anything
maintains. Every figure corresponds to a transaction, and can be checked against the
token's own balance at `0x…dEaD`.

## What the keeper does with it

After settling, the keeper calls `sweepToBurner()`, then `buyAndBurn` for each configured
target holding at least `MIN_BUYBACK_WEI` (0.001 ETH by default — below that the gas
costs more than the burn is worth).

It passes `minAmountOut: 0`, which is not a missing slippage guard: the contract derives
the real floor from the pool's TWAP and honours a caller's minimum only when it is
stricter, so zero means "accept the on-chain floor" without a race between reading it and
sending. A failed buyback is logged and retried on the next tick; it can never affect the
lifecycle, and because the call is permissionless nothing is stuck if the keeper stops
running.
