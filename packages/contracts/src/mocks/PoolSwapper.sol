// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

interface IUniswapV3PoolSwap {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Test-only swapper used by fork tests to move the *real* PONS pool.
/// @dev Trading for real is the only way to make the live pool write observations, which
///      is what fork tests need in order to exercise the oracle's sealing rule against
///      genuine history rather than a mock's idea of it.
contract PoolSwapper {
    /// @notice Sells `amountIn` of token0 for token1 (pushes the tick down, PONS up).
    function swapExactIn(address pool, bool zeroForOne, uint256 amountIn) external returns (int256, int256) {
        // 4295128740 = MIN_SQRT_RATIO + 1; 1461446703485210103287273052203988822378723970341 = MAX - 1.
        uint160 limit = zeroForOne ? 4_295_128_740 : 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341;
        return IUniswapV3PoolSwap(pool).swap(address(this), zeroForOne, int256(amountIn), limit, abi.encode(pool));
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool, "unexpected callback caller");
        if (amount0Delta > 0) {
            IERC20Min(IUniswapV3PoolSwap(pool).token0()).transfer(pool, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20Min(IUniswapV3PoolSwap(pool).token1()).transfer(pool, uint256(amount1Delta));
        }
    }
}
