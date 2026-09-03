#!/usr/bin/env python3
"""Measure how far the two PONS/WETH pools naturally disagree.

A composite oracle that requires the pools to agree is only as good as its tolerance.
Set too wide, an attacker can move one pool inside the tolerance and still shift the
result; set too tight, ordinary market noise refuses to settle rounds. Neither can be
chosen without knowing the real distribution, so this samples matching TWAP windows from
both pools and reports it.
"""
import json, os, subprocess, statistics, sys

RPC = os.environ.get("ROBINHOOD_RPC", "https://rpc.mainnet.chain.robinhood.com")
POOL_1PCT = "0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA"
POOL_03PCT = "0xEd50bDeeA8aDC232f159486192a4157281D722ff"
WINDOW = int(sys.argv[1]) if len(sys.argv) > 1 else 300


def sh(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.strip()


def mean_tick(pool, ago_end, window):
    """Arithmetic mean tick over [now-ago_end-window, now-ago_end]."""
    raw = sh(["cast", "call", pool, "observe(uint32[])(int56[],uint160[])",
              f"[{ago_end + window},{ago_end}]", "--rpc-url", RPC])
    first = raw.splitlines()[0].strip()[1:-1]
    a, b = [int(x.strip().split()[0]) for x in first.split(",")]
    delta = b - a
    m = delta // window
    if delta < 0 and delta % window != 0:
        m -= 1
    return m


# Sample matching windows stepping back through history. The 0.3% pool holds ~2.4h, so
# stay inside that; asking for more would simply revert.
samples = []
for ago in range(5, 7200, 120):
    try:
        t1 = mean_tick(POOL_1PCT, ago, WINDOW)
        t3 = mean_tick(POOL_03PCT, ago, WINDOW)
    except subprocess.CalledProcessError:
        continue
    # One tick is 1 basis point, so a tick difference is a bp difference directly.
    samples.append(abs(t1 - t3))

if not samples:
    print("no comparable samples")
    raise SystemExit(1)

samples.sort()
n = len(samples)
pct = lambda p: samples[min(n - 1, int(n * p / 100))]
print(f"window {WINDOW}s, {n} matched samples across ~2h of history")
print(f"  divergence |tick1% - tick0.3%| in basis points")
print(f"    mean   {statistics.mean(samples):7.1f}")
print(f"    median {statistics.median(samples):7.1f}")
for p in (50, 75, 90, 95, 99):
    print(f"    p{p:<5} {pct(p):7d}")
print(f"    max    {samples[-1]:7d}")
print()
print("  A gate must sit above the natural max or it refuses honest rounds.")
for gate in (50, 100, 150, 200, 300):
    trips = sum(1 for s in samples if s > gate)
    print(f"    gate {gate:>4} bps -> would have refused {trips}/{n} rounds "
          f"({100*trips/n:.1f}%); caps single-pool shift at ~{gate//2} bps")
json.dump({"window": WINDOW, "n": n, "max": samples[-1], "p99": pct(99),
           "median": statistics.median(samples)},
          open(os.path.join(os.path.dirname(__file__), "divergence.report.json"), "w"), indent=2)
