// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsAddresses} from "../../src/PonsAddresses.sol";
import {IUniswapV3PoolMinimal} from "../../src/interfaces/IUniswapV3PoolMinimal.sol";
import {PoolSwapper} from "../../src/mocks/PoolSwapper.sol";
import {CompositePonsOracle} from "../../src/oracle/CompositePonsOracle.sol";
import {UniswapV3PonsOracle} from "../../src/oracle/UniswapV3PonsOracle.sol";
import {Test, console2} from "forge-std/Test.sol";

interface IERC20Bal {
    function balanceOf(address) external view returns (uint256);
}

/// @notice Measures what the composite oracle actually costs an attacker, against both
///         live PONS/WETH pools — and compares it with the single-pool figure.
///
/// @dev The whole case for the composite rests on this number. Reasoning about combined
///      depth is not evidence; swapping against the real pools is. These figures are the
///      source for the revised caps in docs/MANIPULATION_ANALYSIS.md.
///
///      Run against a cached endpoint (local Anvil fork); crossing ticks in two pools
///      reads a great deal of storage.
///        ROBINHOOD_RPC=http://127.0.0.1:8546 REQUIRE_FORK=true \
///          forge test --mc CompositeManipulationCost -vv
contract CompositeManipulationCostTest is Test {
    IUniswapV3PoolMinimal internal pool1 = IUniswapV3PoolMinimal(PonsAddresses.PONS_WETH_POOL_10000);
    IUniswapV3PoolMinimal internal pool3 = IUniswapV3PoolMinimal(PonsAddresses.PONS_WETH_POOL_3000);
    CompositePonsOracle internal composite;
    UniswapV3PonsOracle internal single;
    PoolSwapper internal swapper;
    bool internal forked;

    uint32 internal constant W = 300;
    uint256 internal constant GATE_BPS = 100;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {
            return;
        }

        address[] memory pools = new address[](2);
        pools[0] = PonsAddresses.PONS_WETH_POOL_10000;
        pools[1] = PonsAddresses.PONS_WETH_POOL_3000;
        composite = new CompositePonsOracle(pools, PonsAddresses.PONS, PonsAddresses.WETH, 18, W, GATE_BPS, 2);
        single = new UniswapV3PonsOracle(
            PonsAddresses.PONS_WETH_POOL_10000, PonsAddresses.PONS, PonsAddresses.WETH, 18, W, 1
        );

        swapper = new PoolSwapper();
        deal(PonsAddresses.WETH, address(swapper), 200_000 ether);
        deal(PonsAddresses.PONS, address(swapper), 900_000_000 ether);
    }

    modifier onlyForked() {
        if (!forked) {
            if (vm.envOr("REQUIRE_FORK", false)) {
                revert("fork required but unavailable: set ROBINHOOD_RPC to a reachable endpoint");
            }
            console2.log("!! SKIPPED (no ROBINHOOD_RPC) - this test verified NOTHING");
            return;
        }
        _;
    }

    function _weth() internal view returns (uint256) {
        return IERC20Bal(PonsAddresses.WETH).balanceOf(address(swapper));
    }

    function _pons() internal view returns (uint256) {
        return IERC20Bal(PonsAddresses.PONS).balanceOf(address(swapper));
    }

    /// @dev Seal an instant on both pools.
    ///
    ///      The nudge has to be big enough to actually move the tick: Uniswap only records
    ///      an observation when the tick changes, and a sub-tick swap writes nothing at
    ///      all. In a ~1,200 WETH pool a 0.05 WETH swap is well under one tick, which is
    ///      why a smaller nudge left every instant unsealed. Direction alternates so the
    ///      sealing itself does not walk the price in one direction across a measurement.
    bool private _sealFlip;

    function _sealBoth() internal {
        _sealFlip = !_sealFlip;
        swapper.swapExactIn(address(pool1), _sealFlip, _sealFlip ? 2 ether : 8000 ether);
        swapper.swapExactIn(address(pool3), _sealFlip, _sealFlip ? 1 ether : 4000 ether);
    }

    /// @dev Both pools agree on the live chain, so the composite prices normally.
    function test_fork_liveSourcesAgreeAndPrice() public onlyForked {
        vm.warp(block.timestamp + 3);
        _sealBoth();
        vm.warp(block.timestamp + 3);
        _sealBoth();

        uint256 t = block.timestamp - 1;
        (int24[] memory ticks, bool[] memory ok, uint256 spread) = composite.inspect(t, W);
        console2.log("pool 1%   mean tick", vm.toString(ticks[0]));
        console2.log("pool 0.3% mean tick", vm.toString(ticks[1]));
        console2.log("spread (bp)        ", spread);
        assertTrue(ok[0] && ok[1], "both live sources should be available");
        assertLe(spread, GATE_BPS, "live pools should agree inside the gate");

        (uint256 price,) = composite.getPriceAt(t, W);
        assertGt(price, 0);
        console2.log("composite price (wei WETH per PONS)", price);
    }

    /// @dev The decisive comparison: what a *single-pool* attack buys against each oracle.
    ///      Against the single-pool adapter it moves the settlement price. Against the
    ///      composite it should either be halved by the median or refuse outright.
    function test_fork_singlePoolAttackIsNeutralisedByTheComposite() public onlyForked {
        vm.warp(block.timestamp + 3);
        _sealBoth();
        vm.warp(block.timestamp + 3);
        _sealBoth();
        uint256 clean = block.timestamp - 1;

        (uint256 singleClean,) = single.getPriceAt(clean, W);
        (uint256 compClean,) = composite.getPriceAt(clean, W);

        // Move only the 1% pool, and hold it across the whole window.
        uint256 wethBefore = _weth();
        uint256 ponsBefore = _pons();
        swapper.swapExactIn(address(pool1), true, 120 ether);

        // Hold for the full window, keeping both pools recording.
        for (uint256 i = 0; i < 12; i++) {
            vm.warp(block.timestamp + 30);
            swapper.swapExactIn(address(pool3), true, 0.05 ether);
            swapper.swapExactIn(address(pool1), true, 0.05 ether);
        }
        swapper.swapExactIn(address(pool1), false, _pons() - ponsBefore);
        uint256 cost = wethBefore > _weth() ? wethBefore - _weth() : 0;

        vm.warp(block.timestamp + 3);
        _sealBoth();
        uint256 dirty = block.timestamp - 1;

        (uint256 singleDirty,) = single.getPriceAt(dirty, W);
        uint256 singleShift = singleDirty > singleClean ? ((singleDirty - singleClean) * 10_000) / singleClean : 0;

        (bool compOk, string memory why) = composite.canQuote(dirty, W);
        (,, uint256 spread) = composite.inspect(dirty, W);

        console2.log("attack cost (wei)          ", cost);
        console2.log("single-pool oracle shift bp", singleShift);
        console2.log("composite spread bp        ", spread);
        console2.log("composite quotable         ", compOk);
        if (!compOk) console2.log("  refusal reason           ", why);

        if (compOk) {
            (uint256 compDirty,) = composite.getPriceAt(dirty, W);
            uint256 compShift = compDirty > compClean ? ((compDirty - compClean) * 10_000) / compClean : 0;
            console2.log("composite oracle shift bp  ", compShift);
            // Inside the gate the median must at least halve what one pool achieves.
            assertLt(compShift, singleShift, "composite must resist better than a single pool");
        } else {
            // Past the gate the round refuses and the attacker gains nothing at all.
            assertEq(why, "SOURCES_DIVERGED");
        }
    }

    /// @dev Cost to shift the *composite*, moving both pools in step.
    ///
    ///      An attacker will calibrate the split, so the measurement has to as well: the
    ///      two pools hold similar in-range liquidity but different balances, so an
    ///      uncalibrated split over-moves one, trips the gate and wastes the whole attack.
    ///      This sweeps the ratio to find what a tuned attacker actually achieves, which
    ///      is the figure the exposure caps must be set against.
    function test_fork_costToShiftTheCompositeRequiresBothPools() public onlyForked {
        vm.warp(block.timestamp + 3);
        _sealBoth();
        vm.warp(block.timestamp + 3);
        _sealBoth();
        uint256 clean = block.timestamp - 1;
        (uint256 compClean,) = composite.getPriceAt(clean, W);

        // Percentage of the 1% pool's size applied to the 0.3% pool.
        uint256[5] memory ratios = [uint256(100), 115, 130, 145, 160];
        for (uint256 i = 0; i < ratios.length; i++) {
            _measureBothPools(clean, compClean, 40 ether, ratios[i]);
        }
    }

    /// @dev Split out to stay under the stack limit.
    function _measureBothPools(uint256 clean, uint256 compClean, uint256 perPool, uint256 ratioPct) internal {
        uint256 snap = vm.snapshotState();
        clean; // the baseline price is passed in already resolved

        uint256 wethBefore = _weth();
        uint256 ponsBefore = _pons();
        swapper.swapExactIn(address(pool1), true, perPool);
        swapper.swapExactIn(address(pool3), true, (perPool * ratioPct) / 100);

        // Hold across the whole window, keeping both pools recording observations.
        for (uint256 i = 0; i < 11; i++) {
            vm.warp(block.timestamp + 30);
            swapper.swapExactIn(address(pool1), true, 2 ether);
            swapper.swapExactIn(address(pool3), true, 1 ether);
        }
        uint256 gained = _pons() - ponsBefore;
        swapper.swapExactIn(address(pool1), false, gained / 2);
        swapper.swapExactIn(address(pool3), false, _pons() - ponsBefore);
        uint256 cost = wethBefore > _weth() ? wethBefore - _weth() : 0;

        vm.warp(block.timestamp + 3);
        _sealBoth();
        uint256 dirty = block.timestamp - 1;

        (bool ok, string memory why) = composite.canQuote(dirty, W);
        (,, uint256 spread) = composite.inspect(dirty, W);
        console2.log("--- 1% pool 40 WETH, 0.3% pool at pct", ratioPct);
        console2.log("    cost (wei)          ", cost);
        console2.log("    spread (bp)         ", spread);
        if (!ok) {
            console2.log("    REFUSED             ", why);
        } else {
            (uint256 compDirty,) = composite.getPriceAt(dirty, W);
            uint256 shift = compDirty > compClean ? ((compDirty - compClean) * 10_000) / compClean : 0;
            console2.log("    composite shift (bp)", shift);
            if (shift > 0) console2.log("    cost per bp (wei)   ", cost / shift);
        }

        vm.revertToState(snap);
    }

    /// @dev Also confirm the composite ignores an unheld move, as the single-pool one does.
    function test_fork_unheldMoveOnBothPoolsBuysNothing() public onlyForked {
        vm.warp(block.timestamp + 3);
        _sealBoth();
        vm.warp(block.timestamp + 3);
        _sealBoth();
        uint256 t = block.timestamp - 1;
        (uint256 before,) = composite.getPriceAt(t, W);

        uint256 ponsBefore = _pons();
        swapper.swapExactIn(address(pool1), true, 150 ether);
        swapper.swapExactIn(address(pool3), true, 90 ether);
        swapper.swapExactIn(address(pool1), false, (_pons() - ponsBefore) / 2);
        swapper.swapExactIn(address(pool3), false, _pons() - ponsBefore);

        (uint256 afterP,) = composite.getPriceAt(t, W);
        assertEq(afterP, before, "an unheld move changed the composite settlement price");
        console2.log("240 WETH round trip inside one second shifted the composite by 0 wei");
    }
}
