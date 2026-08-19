// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {Oracle} from "../vendor/uniswap/Oracle.sol";
import {TickMath} from "../vendor/uniswap/TickMath.sol";

/// @notice Test double for a Uniswap V3 pool that drives Uniswap's *real* `Oracle`
///         library, so `observe()` behaves exactly as the deployed pool does —
///         including the parts that matter most here: an observation is written only
///         when a swap moves the tick, at most once per second, recording the tick
///         that held *before* the swap.
/// @dev Reproducing those rules faithfully is the point. A hand-rolled mock that
///      wrote an observation per call would quietly hide the seal-lag behaviour the
///      oracle is designed around.
contract MockUniswapV3Pool {
    using Oracle for Oracle.Observation[65_535];

    Oracle.Observation[65_535] public observations;

    address public token0;
    address public token1;
    uint24 public fee;
    int24 public tickSpacing;
    address public factory;
    uint128 public liquidity = 1e18;

    uint160 public sqrtPriceX96;
    int24 public tick;
    uint16 public observationIndex;
    uint16 public observationCardinality;
    uint16 public observationCardinalityNext;
    bool public unlocked = true;

    constructor(address token0_, address token1_, uint24 fee_, int24 initialTick) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        tickSpacing = 200;
        factory = address(this);
        tick = initialTick;
        sqrtPriceX96 = TickMath.getSqrtRatioAtTick(initialTick);
        (observationCardinality, observationCardinalityNext) = observations.initialize(_now());
    }

    /// @dev Reads the chain clock directly. The oracle derives `secondsAgo` values from
    ///      `block.timestamp`, so a mock with its own clock would silently desync from it
    ///      and make every window test meaningless. Tests move time with `vm.warp`.
    function _now() internal view returns (uint32) {
        return uint32(block.timestamp);
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext, 0, unlocked);
    }

    function increaseObservationCardinalityNext(uint16 next) external {
        uint16 old = observationCardinalityNext;
        uint16 grown = observations.grow(old, next);
        observationCardinalityNext = grown;
    }

    /// @notice Moves the tick exactly the way a swap would, writing an observation only
    ///         if the tick actually changes and only once per second.
    function swapToTick(int24 newTick) public {
        if (newTick != tick) {
            (uint16 idx, uint16 card) = observations.write(
                observationIndex, _now(), tick, liquidity, observationCardinality, observationCardinalityNext
            );
            observationIndex = idx;
            observationCardinality = card;
        }
        tick = newTick;
        sqrtPriceX96 = TickMath.getSqrtRatioAtTick(newTick);
    }

    function setLiquidity(uint128 v) external {
        liquidity = v;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        return observations.observe(_now(), secondsAgos, tick, observationIndex, liquidity, observationCardinality);
    }
}
