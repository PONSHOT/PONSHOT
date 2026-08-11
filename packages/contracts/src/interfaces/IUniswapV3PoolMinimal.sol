// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @title IUniswapV3PoolMinimal
/// @notice The subset of the Uniswap V3 pool surface the PONS oracle depends on.
/// @dev Deliberately narrow: the oracle only ever *reads*. Keeping our own
///      interface (rather than importing the full v3-core one) keeps the compile
///      surface small and makes the trust boundary obvious at a glance.
interface IUniswapV3PoolMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function liquidity() external view returns (uint128);
    function factory() external view returns (address);

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /// @notice Ring-buffer entry. `initialized` is false for slots never written.
    function observations(uint256 index)
        external
        view
        returns (
            uint32 blockTimestamp,
            int56 tickCumulative,
            uint160 secondsPerLiquidityCumulativeX128,
            bool initialized
        );

    /// @notice Cumulative tick / seconds-per-liquidity as of each `secondsAgos[i]` seconds ago.
    /// @dev Reverts with "OLD" when the requested instant predates the ring buffer.
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    /// @notice Grows the observation ring buffer. Permissionless.
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

interface IUniswapV3FactoryMinimal {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}
