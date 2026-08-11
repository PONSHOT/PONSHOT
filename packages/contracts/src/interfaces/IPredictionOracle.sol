// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @title IPredictionOracle
/// @notice Price source abstraction consumed by PonsPrediction.
/// @dev The prediction market never learns which venue backs an oracle. It only
///      needs (a) a spot-ish reading for display/telemetry and (b) the ability to
///      ask for a *manipulation-resistant price as of a specific past instant*.
///
///      (b) is what makes settlement independent of keeper punctuality: the price
///      of a round is a pure function of the round's scheduled timestamps, so a
///      keeper that executes late produces byte-identical results to one that
///      executes on time. Implementations MUST NOT let the answer depend on
///      `block.timestamp`, `block.number`, `msg.sender` or transaction ordering.
interface IPredictionOracle {
    /// @notice Human-readable description of the price feed, e.g. "PONS/WETH UniV3 1% TWAP".
    function description() external view returns (string memory);

    /// @notice Decimals of every price returned by this oracle. Always 18 here.
    function decimals() external pure returns (uint8);

    /// @notice Monotonically increasing identifier for the oracle's *rules*.
    /// @dev Snapshotted into each round so historical rounds can prove which
    ///      pricing rules applied when users entered them.
    function oracleVersion() external view returns (uint64);

    /// @notice Latest available reading, as of the most recent observable instant.
    /// @return price Quote asset units per 1e18 base asset units, 18-decimal fixed point.
    /// @return timestamp The instant `price` refers to.
    function getPrice() external view returns (uint256 price, uint256 timestamp);

    /// @notice Time-weighted price over the window `[targetTimestamp - twapWindow, targetTimestamp]`.
    /// @dev MUST revert if the reading cannot be produced faithfully (window not yet
    ///      elapsed, history evicted, degenerate pool state). Callers are expected to
    ///      wrap this in try/catch and treat a revert as "oracle unavailable".
    /// @param targetTimestamp The instant the window *ends* at. Must be in the past.
    /// @param twapWindow Length of the averaging window in seconds. Must be non-zero.
    /// @return price Quote asset units per 1e18 base asset units, 18-decimal fixed point.
    /// @return meanTick The arithmetic mean tick backing `price`, for auditability.
    function getPriceAt(uint256 targetTimestamp, uint32 twapWindow)
        external
        view
        returns (uint256 price, int24 meanTick);

    /// @notice Non-reverting probe of `getPriceAt` viability.
    /// @dev Lets off-chain agents and the market's own view functions ask
    ///      "could this round settle right now?" without burning a revert.
    function canQuote(uint256 targetTimestamp, uint32 twapWindow) external view returns (bool ok, string memory reason);

    /// @notice Oldest instant this oracle can still answer for.
    /// @dev For a Uniswap V3 TWAP this is bounded by the pool's observation ring buffer.
    function earliestAvailableTimestamp() external view returns (uint256);
}
