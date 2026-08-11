// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {MockToken} from "./MockToken.sol";

interface ISwapCallback {
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @notice Swappable pool stand-in with a settable execution rate and a flat TWAP tick.
/// @dev The point of separating the two is that a real pool's TWAP and its *executed*
///      price differ, and the burner's whole safety argument rests on comparing them.
///      A mock where the swap price is forced to equal the observed tick could not
///      express the case the floor exists to reject.
contract MockSwapPool {
    address public immutable token0;
    address public immutable token1;

    int24 public tick;
    /// @notice Output per 1e18 of input, in output-token units.
    uint256 public rate = 1e18;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function setTick(int24 t) external {
        tick = t;
    }

    function setRate(uint256 r) external {
        rate = r;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory liq)
    {
        tickCumulatives = new int56[](secondsAgos.length);
        liq = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; i++) {
            tickCumulatives[i] = int56(tick) * int56(uint56(uint32(block.timestamp) - secondsAgos[i]));
        }
    }

    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1)
    {
        uint256 amountIn = uint256(amountSpecified);
        uint256 amountOut = (amountIn * rate) / 1e18;
        address outToken = zeroForOne ? token1 : token0;
        MockToken(outToken).transfer(recipient, amountOut);
        (amount0, amount1) =
            zeroForOne ? (int256(amountIn), -int256(amountOut)) : (-int256(amountOut), int256(amountIn));
        ISwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data);
    }
}
