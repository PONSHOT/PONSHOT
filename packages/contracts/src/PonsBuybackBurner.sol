// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {TickPriceMath} from "./libraries/TickPriceMath.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IWETH9 {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IUniswapV3PoolMin {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

/// @title PonsBuybackBurner
/// @notice Converts protocol ETH into token buybacks and burns them.
///
/// @dev ## Why the market does not swap inside settlement
///
/// The obvious implementation of "buy back right after the round ends" is a swap in
/// `settleRound`. That must not be done here, for two reasons specific to this system.
///
/// 1. **It would let the market manipulate its own oracle.** The buyback buys PONS in
///    the same pools the settlement oracle reads. A swap inside settlement would move
///    the price that the *next* round's lock price is derived from, by an amount that
///    is a deterministic function of how much was staked. A bettor could size their
///    entry to control the size of the buyback, and therefore the push on the pool,
///    and therefore the next round's price. Every measurement in
///    `docs/MANIPULATION_ANALYSIS.md` assumes the market is not itself a trader.
///
/// 2. **It would make settlement fallible.** Settlement is permissionless and must stay
///    that way; it is what guarantees that a dead keeper cannot strand user funds. A
///    swap can revert — thin liquidity, a price limit, a paused pool — and a revert in
///    settlement turns a tokenomics feature into a liveness failure on a contract
///    holding user stakes.
///
/// So the market only *books* the burn allocation. This contract receives it and swaps
/// in a separate transaction, which the keeper sends immediately after settling. The
/// wall-clock result is "right after the round ends"; the difference is that a failed
/// buyback costs a retry instead of stalling the market.
///
/// ## Why a permissionless buyback is safe
///
/// `buyAndBurn` may be called by anyone, because the caller cannot choose the price it
/// executes at: the minimum output is derived on chain from the pool's own TWAP over
/// `twapWindow`, and a caller-supplied `minAmountOut` may only be *stricter*. Combined
/// with the per-window spend cap, the worst a hostile caller can do is buy the token at
/// no worse than the time-weighted average, which is the intended behaviour anyway.
contract PonsBuybackBurner is AccessControl, ReentrancyGuard {
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    /// @dev Standard unrecoverable address. Burning by transfer works for any ERC-20,
    ///      including tokens with no `burn` function, and is externally verifiable.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant MAX_BPS = 10_000;
    uint32 public constant MIN_TWAP_WINDOW = 60;
    uint32 public constant MAX_TWAP_WINDOW = 1 days;
    /// @dev A floor no looser than this keeps "slippage tolerance" from becoming
    ///      "permission to buy at any price the caller can arrange".
    uint16 public constant MAX_SLIPPAGE_BPS = 1000;

    struct Target {
        address token;
        address pool;
        bool wethIsToken0;
        uint16 shareBps;
        uint16 maxSlippageBps;
        uint32 twapWindow;
    }

    address public immutable weth;

    Target[2] private _targets;

    /// @notice ETH received and earmarked per target, not yet spent.
    uint256[2] public allocated;
    /// @notice Cumulative ETH spent and tokens burned per target, for reporting.
    uint256[2] public totalSpent;
    uint256[2] public totalBurned;

    /// @notice Spend cap, applied to the sum across targets.
    uint256 public maxSpendPerWindow;
    uint32 public rateWindow;
    uint256 private _windowStart;
    uint256 private _spentInWindow;

    address private _expectedPool;

    event Funded(uint256 amount, uint256 toPons, uint256 toProject);
    event BoughtAndBurned(uint8 indexed index, address indexed token, uint256 ethIn, uint256 burned, uint256 floor);
    event TargetConfigured(uint8 indexed index, address token, address pool, uint16 shareBps);
    event RateLimitUpdated(uint256 maxSpendPerWindow, uint32 rateWindow);

    error BadShares(uint256 total);
    error TargetNotConfigured(uint8 index);
    error NothingAllocated(uint8 index);
    error WindowOutOfRange(uint32 window);
    error SlippageTooLoose(uint16 bps);
    error RateLimited(uint256 requested, uint256 remaining);
    error BelowFloor(uint256 got, uint256 floor);
    error UnexpectedCallback(address caller);
    error PoolTokenMismatch();
    error ZeroAddress();

    constructor(address weth_, address admin, Target memory pons, Target memory project) {
        if (weth_ == address(0) || admin == address(0)) revert ZeroAddress();
        weth = weth_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CONFIG_ROLE, admin);

        if (uint256(pons.shareBps) + project.shareBps != MAX_BPS) {
            revert BadShares(uint256(pons.shareBps) + project.shareBps);
        }
        _setTarget(0, pons);
        _setTarget(1, project);

        maxSpendPerWindow = type(uint256).max;
        rateWindow = 1 hours;
    }

    /// @notice Receives the burn allocation booked by the market.
    /// @dev Splits on arrival so the shares in force are the ones configured when the
    ///      money was earned, not when it happens to be spent.
    receive() external payable {
        uint256 toPons = (msg.value * _targets[0].shareBps) / MAX_BPS;
        // Remainder to the first target rather than left unassignable as dust.
        uint256 toProject = msg.value - toPons;
        allocated[0] += toPons;
        allocated[1] += toProject;
        emit Funded(msg.value, toPons, toProject);
    }

    /// @notice Buys the target token with its allocated ETH and burns everything bought.
    /// @param index 0 for PONS, 1 for the project token.
    /// @param amountIn ETH to spend, or zero for the whole allocation.
    /// @param minAmountOut Caller's own floor; ignored unless stricter than the TWAP floor.
    function buyAndBurn(uint8 index, uint256 amountIn, uint256 minAmountOut)
        external
        nonReentrant
        returns (uint256 burned)
    {
        Target memory t = _targets[index];
        if (t.token == address(0) || t.pool == address(0)) revert TargetNotConfigured(index);

        uint256 available = allocated[index];
        if (amountIn == 0) amountIn = available;
        if (amountIn == 0 || amountIn > available) revert NothingAllocated(index);

        _consumeRateLimit(amountIn);

        uint256 floor = _twapFloor(t, amountIn);
        uint256 required = minAmountOut > floor ? minAmountOut : floor;

        allocated[index] = available - amountIn;

        IWETH9(weth).deposit{value: amountIn}();

        uint256 before = IERC20Min(t.token).balanceOf(address(this));
        _expectedPool = t.pool;
        IUniswapV3PoolMin(t.pool)
            .swap(
                address(this),
                t.wethIsToken0,
                int256(amountIn),
                t.wethIsToken0 ? 4_295_128_740 : 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_341,
                abi.encode(t.pool)
            );
        _expectedPool = address(0);

        burned = IERC20Min(t.token).balanceOf(address(this)) - before;
        if (burned < required) revert BelowFloor(burned, required);

        totalSpent[index] += amountIn;
        totalBurned[index] += burned;
        IERC20Min(t.token).transfer(BURN_ADDRESS, burned);
        emit BoughtAndBurned(index, t.token, amountIn, burned, required);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address pool = abi.decode(data, (address));
        if (msg.sender != pool || pool != _expectedPool) revert UnexpectedCallback(msg.sender);
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        IWETH9(weth).transfer(pool, owed);
    }

    /// @dev The floor is the pool's own time-weighted price, discounted by the configured
    ///      tolerance. Deriving it on chain is what makes the entry point safe to expose.
    function _twapFloor(Target memory t, uint256 amountIn) private view returns (uint256) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = t.twapWindow;
        ago[1] = 0;
        (int56[] memory cum,) = IUniswapV3PoolMin(t.pool).observe(ago);
        int24 mean = TickPriceMath.meanTick(cum[1] - cum[0], t.twapWindow);
        uint256 quote = TickPriceMath.quoteAtTick(mean, uint128(amountIn), t.wethIsToken0);
        return (quote * (MAX_BPS - t.maxSlippageBps)) / MAX_BPS;
    }

    function _consumeRateLimit(uint256 amount) private {
        if (block.timestamp >= _windowStart + rateWindow) {
            _windowStart = block.timestamp;
            _spentInWindow = 0;
        }
        uint256 remaining = maxSpendPerWindow - _spentInWindow;
        if (amount > remaining) revert RateLimited(amount, remaining);
        _spentInWindow += amount;
    }

    function _setTarget(uint8 index, Target memory t) private {
        if (t.twapWindow < MIN_TWAP_WINDOW || t.twapWindow > MAX_TWAP_WINDOW) {
            revert WindowOutOfRange(t.twapWindow);
        }
        if (t.maxSlippageBps > MAX_SLIPPAGE_BPS) revert SlippageTooLoose(t.maxSlippageBps);
        if (t.pool != address(0)) {
            address t0 = IUniswapV3PoolMin(t.pool).token0();
            address t1 = IUniswapV3PoolMin(t.pool).token1();
            bool ok = (t0 == weth && t1 == t.token) || (t1 == weth && t0 == t.token);
            if (!ok) revert PoolTokenMismatch();
            t.wethIsToken0 = (t0 == weth);
        }
        _targets[index] = t;
        emit TargetConfigured(index, t.token, t.pool, t.shareBps);
    }

    /// @notice Configures a target. Shares are not settable here; they are fixed at
    ///         construction so the split cannot be changed out from under money already
    ///         earned but not yet spent.
    function setTarget(uint8 index, address token, address pool, uint16 maxSlippageBps, uint32 twapWindow)
        external
        onlyRole(CONFIG_ROLE)
    {
        Target memory t = _targets[index];
        t.token = token;
        t.pool = pool;
        t.maxSlippageBps = maxSlippageBps;
        t.twapWindow = twapWindow;
        _setTarget(index, t);
    }

    function setRateLimit(uint256 maxSpend, uint32 window) external onlyRole(CONFIG_ROLE) {
        maxSpendPerWindow = maxSpend;
        rateWindow = window;
        emit RateLimitUpdated(maxSpend, window);
    }

    function target(uint8 index) external view returns (Target memory) {
        return _targets[index];
    }
}
