# deployments/

`script/Deploy.s.sol` writes `<chainId>.json` here after a successful broadcast. Apps
read these files; addresses are never hand-copied into application code.

## Live

`4663.json` — **deployed to Robinhood Chain 2026-09-03**, block 53,636,175.

| | |
|---|---|
| market | `0xC463621052E57Cfa2F8CDA86ee337d8d9aD4dBD0` |
| oracle | `0x5aBD0f26f1A5e7B24E1bb4De50513a31D3cb0D33` (composite, both PONS/WETH pools) |
| admin / treasury | `0x45f65631CCBF99fdbE0919BBDdb87c92B252D04F` (EOA — see below) |
| keeper | `0x090632dAa00F601eCB764FE3A371aD5A3b93D344` (OPERATOR_ROLE only) |
| rounds | 15 minutes, 300s TWAP, 1800s tolerance, 3% fee |
| caps | 0.001–0.5 ETH per entry, 2 ETH per round |

Two things about this deployment that a reader should not have to discover:

- **The admin is an externally owned account, not a multisig.** The deploy preflight
  refuses that by default; it was waived with `ALLOW_EOA_ADMIN=true` because no multisig
  was available. The role can withdraw accrued fees and configure *future* rounds — it
  cannot touch user stakes, change a recorded outcome, or claim on anyone's behalf.
  Moving it to a multisig is one `grantRole`/`revokeRole` pair.
- **It has not been audited.** `docs/SECURITY.md` lists the defects found in review and
  why the exposure caps are set where they are.

`fork-runs/4663.fork-dry-run.json` is a dry run against a local fork, kept as a record.
Those addresses do not exist on the network.
