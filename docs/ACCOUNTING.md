# Accounting

## Payout model

Parimutuel. Stakes pool, the protocol takes a fee, and the remainder is split among the
winning side in proportion to stake.

```
total        = bullAmount + bearAmount
fee          = total × treasuryFeeBps / 10000
rewardAmount = total − fee
payout(user) = userStake × rewardAmount / rewardBaseAmount
```

where `rewardBaseAmount` is the stake on the winning side.

Worked, matching the brief exactly: UP 3 ETH, DOWN 7 ETH, fee 3%, UP wins.
Fee 0.3 ETH, reward pool 9.7 ETH, and a 1 ETH bull stake collects `1 × 9.7 / 3 = 3.2333…`
ETH. Pinned by `test_matchesTheSpecifiedParimutuelExample` and, in TypeScript, by the SDK
test of the same figures.

All integer arithmetic. `estimatePayout` in `@pons/sdk` reproduces the contract's maths in
BigInt — including its flooring — so the UI and the chain never disagree by a wei.

## The fee applies only to a genuine contest

Where either side attracted no stake the round resolves `NoContest`: **no fee, full
refunds**. Same for a tie.

The brief requires this when the *winning* side is empty, to stop the treasury absorbing
the losing pool. The mirror case is treated identically because there was nothing to win,
and charging a rake on a bettor's own stake would penalise them for being right. The
brief's formula applies unchanged whenever both sides have stake.

| Case | Outcome | Fee | Payout |
|---|---|---|---|
| both sides staked, prices differ | `Bull`/`Bear` | yes | brief's formula |
| `closePrice == lockPrice` | `Tie` | none | full refund |
| one side empty | `NoContest` | none | full refund |
| nobody entered | `NoContest` | none | nothing to pay |
| round cancelled | — | none | full refund |

## Rounding

`payout` floors. The sum of payouts can therefore fall a few wei short of `rewardAmount`,
and that dust stays in the contract permanently.

This is the safe direction: the contract can only ever hold *more* than it owes, never
less. It is visible in practice — the local simulation settles a 3.395 ETH reward pool and
pays out 3.394999999999999999 ETH, one wei short.

There is deliberately no dust-sweeping function. It would add an admin-callable path that
touches user-side balances in exchange for wei.

## Liabilities

`totalLiabilities` tracks ETH owed to users: live stakes, unclaimed rewards, unclaimed
refunds.

| Event | Effect |
|---|---|
| entry | `+= msg.value` |
| settlement | `−= fee`, and `treasuryAmount += fee` |
| claim / refund | `−= payout` |
| cancellation | unchanged; stakes stay owed until claimed |

## The solvency invariant

```
address(this).balance >= totalLiabilities + treasuryAmount
```

Exposed on chain as `solvency()`, so monitoring reads exactly what the tests assert
rather than a re-implementation of it.

`>=` rather than `==` for two reasons: floor-division dust accumulates on the solvent
side, and ETH can be forced in with `selfdestruct`, which the contract cannot refuse.
Forced ETH is never counted as a liability and can only make the contract more solvent
(`test_forcedEthDoesNotDisturbAccounting`).

Enforced by `invariant_contractCanAlwaysCoverWhatItOwes` and, independently,
`invariant_ethInEqualsEthOutPlusWhatIsStillHeld`, which reconciles the contract's balance
against a tally the test handler keeps for itself.

## Treasury

Fees are **booked at settlement, not transferred**. `claimTreasury(amount)` is bounded by
`treasuryAmount`, which only ever grows from booked fees, so it cannot reach ETH owed to
users even while user funds sit in the contract
(`test_treasuryCannotOverdrawIntoUserFunds`).

No fee is ever taken from a cancelled, tied or no-contest round.

## Claims

Pull-based. `claim(uint256[] epochs)` collects winnings and refunds together, applies
every storage effect first, and makes a single ETH transfer at the end.

- **Double claim** — `claimed` is set before the transfer; a repeated epoch in one call
  reverts on the second occurrence (`test_duplicateEpochInOneClaimIsRejected`).
- **Reentrancy** — `nonReentrant` plus the `claimed` flag. A reentrant claimer receives
  exactly what it is owed and no more; the test asserts both the attacker's delta and the
  contract's (`test_reentrantClaimGainsNothing`).
- **Griefing** — settlement moves no ETH, so a contract that rejects payment cannot block
  it, nor block anyone else's claim (`test_aRecipientThatRejectsEthCannotBlockOthers`).

## Direct payments

`receive()` reverts. Stakes must arrive through `betBull`/`betBear` so they are recorded
against a round and a wallet. `selfdestruct` can still force ETH in, which is why the
invariant is an inequality.

## Invariants under test

Checked by the stateful suite against a handler that bets, settles, cancels, claims and
withdraws in random order across random time jumps:

- contract balance covers all obligations;
- ETH in == ETH out + ETH still held;
- `bullAmount + bearAmount == totalAmount`;
- `rewardAmount <= totalAmount`;
- schedule boundaries line up, every epoch below the head exists;
- a settled round's outcome is exactly what its two prices imply;
- refund-shaped rounds booked no reward and no fee;
- nobody is owed both winnings and a refund;
- at most one position per wallet per epoch.
