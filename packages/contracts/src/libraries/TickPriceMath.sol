// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {FullMath} from "../vendor/uniswap/FullMath.sol";
import {TickMath} from "../vendor/uniswap/TickMath.sol";

/// @title TickPriceMath
/// @notice Converts a Uniswap V3 tick into a quote-per-base price with pure integer math.
/// @dev Adapted from Uniswap's `OracleLibrary.getQuoteAtTick` (v3-periphery, GPL-2.0-or-later).
///      See THIRD_PARTY_NOTICES.md.
///
///      A note on direction, because getting it backwards silently inverts every
///      round outcome: in Uniswap V3 the tick encodes `token1/token0` in *raw*
///      units, i.e. `1.0001^tick = amount of token1 per 1 token0`. So when the
///      base asset is token1 (as PONS is in the PONS/WETH pool, where WETH is
///      token0), the quoted price is `1 / 1.0001^tick` and is therefore
///      **strictly decreasing in tick**. `quoteAtTick` handles both orderings;
///      `PONS_IS_TOKEN0`-style assumptions appear nowhere in this file.
library TickPriceMath {
    /// @notice Thrown when a pool reports a cumulative tick delta outside the representable tick domain.
    error MeanTickOutOfRange(int56 mean);

    /// @notice Price of `baseAmount` base-token units expressed in quote-token units.
    /// @param tick The tick to evaluate at (spot tick or arithmetic mean tick).
    /// @param baseAmount Amount of base token to quote, in base token's own decimals.
    /// @param baseIsToken0 True when the base token is the pool's token0.
    /// @return quoteAmount Value of `baseAmount` base tokens, in quote token's own decimals.
    function quoteAtTick(int24 tick, uint128 baseAmount, bool baseIsToken0)
        internal
        pure
        returns (uint256 quoteAmount)
    {
        uint160 sqrtRatioX96 = TickMath.getSqrtRatioAtTick(tick);

        // Two branches purely to keep the intermediate ratio inside 256 bits.
        if (sqrtRatioX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtRatioX96) * sqrtRatioX96;
            quoteAmount = baseIsToken0
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(sqrtRatioX96, sqrtRatioX96, 1 << 64);
            quoteAmount = baseIsToken0
                ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
                : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }

    /// @notice Arithmetic mean tick over a window, rounding toward negative infinity.
    /// @dev Truncating division in Solidity rounds toward zero, which for negative
    ///      cumulative deltas would bias the mean *upwards* and make the rounding
    ///      direction depend on the sign of the price. Uniswap's own convention is
    ///      to always round down; we match it so that a tick is a tick regardless of
    ///      which side of 1.0 the pair trades at.
    function meanTick(int56 tickCumulativeDelta, uint32 window) internal pure returns (int24) {
        int56 windowSigned = int56(uint56(window));
        int56 mean = tickCumulativeDelta / windowSigned;
        if (tickCumulativeDelta < 0 && (tickCumulativeDelta % windowSigned != 0)) {
            mean--;
        }
        // An honest pool cannot produce a mean outside the tick domain, so this can
        // only trip on a malformed/hostile pool. Reverting beats a silent int24
        // truncation that would wrap a nonsense tick into a plausible-looking price.
        if (mean < TickMath.MIN_TICK || mean > TickMath.MAX_TICK) revert MeanTickOutOfRange(mean);
        return int24(mean);
    }
}
