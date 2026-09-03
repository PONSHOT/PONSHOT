#!/usr/bin/env python3
"""Characterise the PONS/WETH pool's Uniswap V3 observation ring buffer.

Answers the two questions the round schedule and settlement tolerance depend on:

  1. How far back can a TWAP window reach?           -> ring buffer span
  2. How long after an instant passes is it *sealed* -> distribution of gaps
     by an observation?

(2) is the operationally decisive one and is not a function of block time.
Uniswap V3 writes an observation only when a swap *moves the tick*, so the seal
lag is a property of trading behaviour. It bounds how long a round can sit
unresolved, and therefore sets `bufferSeconds`.

Reads the buffer through a deployless `eth_call` (script/tools/ObservationDump.sol)
so the whole audit is ~40 RPC calls rather than 20,000.
"""
import json
import os
import statistics
import subprocess
import sys

RPC = os.environ.get("ROBINHOOD_RPC", "https://rpc.mainnet.chain.robinhood.com")
POOL = sys.argv[1] if len(sys.argv) > 1 else "0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA"
CONTRACTS = os.path.join(os.path.dirname(__file__), "..", "..", "packages", "contracts")
CHUNK = 500


def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, check=True, **kw).stdout.strip()


def _u(word):
    return int(word, 16)


def _i(word, bits):
    v = int(word, 16)
    return v - (1 << 256) if v >= (1 << 255) else v


def fetch(bytecode, start, count):
    """Decode `(int24, uint16, uint16, uint32[], int56[], bool[])` by hand.

    Done in Python rather than through `cast abi-decode` so the tool does not
    depend on that command's output shape, which differs across forge releases.
    """
    arg = sh(["cast", "abi-encode", "f(address,uint256,uint256)", POOL, str(start), str(count)])
    raw = sh(["cast", "call", "--rpc-url", RPC, "--create", bytecode + arg[2:]])[2:]
    w = [raw[i:i + 64] for i in range(0, len(raw), 64)]

    tick = _i(w[0], 24)
    index = _u(w[1])
    cardinality = _u(w[2])

    def read_array(head_word, signed=False):
        off = _u(head_word) // 32
        length = _u(w[off])
        body = w[off + 1: off + 1 + length]
        return [(_i(x, 256) if signed else _u(x)) for x in body]

    ts = read_array(w[3])
    tc = read_array(w[4], signed=True)
    init = [bool(x) for x in read_array(w[5])]
    return tick, index, cardinality, ts, tc, init


bytecode = sh(["forge", "inspect", "ObservationDump", "bytecode"], cwd=CONTRACTS).strip('"')

tick, index, cardinality, *_ = fetch(bytecode, 0, 1)
print(f"pool                {POOL}")
print(f"slot0.tick          {tick}")
print(f"observationIndex    {index}")
print(f"observationCardinality {cardinality}")

obs = {}
for start in range(0, cardinality, CHUNK):
    count = min(CHUNK, cardinality - start)
    _, _, _, ts, tc, init = fetch(bytecode, start, count)
    for k in range(count):
        if init[k]:
            obs[start + k] = (ts[k], tc[k])
    print(f"  fetched {start + count}/{cardinality}", end="\r", flush=True)
print(" " * 40, end="\r")

series = sorted(obs.values())
ts = [s[0] for s in series]
print(f"initialized slots   {len(series)}")
print(f"oldest observation  {ts[0]}")
print(f"newest observation  {ts[-1]}")
span = ts[-1] - ts[0]
print(f"buffer span         {span}s = {span / 3600:.2f}h = {span / 86400:.2f}d")

gaps = sorted(b - a for a, b in zip(ts, ts[1:]) if b > a)
n = len(gaps)


def pct(p):
    return gaps[min(n - 1, int(n * p / 100))]


print(f"\nGaps between consecutive observations (n={n})")
print(f"  mean    {statistics.mean(gaps):9.2f}s")
print(f"  median  {statistics.median(gaps):9.1f}s")
for p in (50, 75, 90, 95, 99, 99.9):
    print(f"  p{p:<6} {pct(p):9d}s")
print(f"  max     {gaps[-1]:9d}s")

# A uniformly chosen instant lands inside a gap with probability proportional to
# that gap's length, so the seal-lag distribution is the *length-weighted* gap
# distribution -- not the plain one. Long gaps dominate the tail.
total = sum(gaps)
acc, ti = 0, 0
targets = [50, 90, 95, 99, 99.9]
marks = {}
for g in gaps:
    acc += g
    while ti < len(targets) and acc >= total * targets[ti] / 100:
        marks[targets[ti]] = g
        ti += 1
print("\nSeal lag: a round boundary is sealed at most this many seconds after it passes")
print("  (length-weighted, i.e. probability an instant falls in a gap of that size)")
for t in targets:
    print(f"  p{t:<6} <= {marks.get(t, gaps[-1]):d}s")
print(f"  worst   <= {gaps[-1]}s   <-- bufferSeconds must exceed this to avoid needless cancellation")

for label, hours in (("last 6h", 6), ("last 24h", 24)):
    recent = [t for t in ts if t >= ts[-1] - hours * 3600]
    if len(recent) > 2:
        rg = sorted(b - a for a, b in zip(recent, recent[1:]) if b > a)
        m = len(rg)
        print(f"\n{label}: n={m} mean={statistics.mean(rg):.1f}s median={statistics.median(rg):.0f}s "
              f"p95={rg[min(m - 1, int(m * .95))]}s p99={rg[min(m - 1, int(m * .99))]}s max={rg[-1]}s")

out = {
    "pool": POOL, "tick": tick, "observationIndex": index, "cardinality": cardinality,
    "initialized": len(series), "oldest": ts[0], "newest": ts[-1], "spanSeconds": span,
    "gapMean": statistics.mean(gaps), "gapMedian": statistics.median(gaps),
    "gapP95": pct(95), "gapP99": pct(99), "gapMax": gaps[-1],
    "sealLagWeighted": {str(k): v for k, v in marks.items()},
}
dest = os.path.join(os.path.dirname(__file__), "observations.report.json")
json.dump(out, open(dest, "w"), indent=2)
print(f"\nwrote {dest}")
