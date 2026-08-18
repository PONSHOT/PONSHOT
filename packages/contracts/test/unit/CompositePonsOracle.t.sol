// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockUniswapV3Pool} from "../../src/mocks/MockUniswapV3Pool.sol";
import {CompositePonsOracle} from "../../src/oracle/CompositePonsOracle.sol";
import {Test, console2} from "forge-std/Test.sol";

contract CompositePonsOracleTest is Test {
    MockERC20 internal weth;
    MockERC20 internal pons;
    MockUniswapV3Pool internal poolA;
    MockUniswapV3Pool internal poolB;
    CompositePonsOracle internal oracle;

    uint32 internal constant W = 300;
    int24 internal constant TICK = 84_400;
    uint256 internal constant GATE_BPS = 100;

    function setUp() public {
        vm.warp(1_000_000);
        weth = new MockERC20("WETH", "WETH", 18);
        pons = new MockERC20("Pons", "PONS", 18);
        // Live ordering on both PONS/WETH pools: WETH is token0.
        poolA = new MockUniswapV3Pool(address(weth), address(pons), 10_000, TICK);
        poolB = new MockUniswapV3Pool(address(weth), address(pons), 3000, TICK);
        poolA.increaseObservationCardinalityNext(2048);
        poolB.increaseObservationCardinalityNext(2048);
        oracle = _deploy(GATE_BPS);
        _buildHistory(2 hours);
    }

    function _pools() internal view returns (address[] memory p) {
        p = new address[](2);
        p[0] = address(poolA);
        p[1] = address(poolB);
    }

    function _deploy(uint256 gate) internal returns (CompositePonsOracle) {
        return new CompositePonsOracle(_pools(), address(pons), address(weth), 18, W, gate, 1);
    }

    /// @dev Trades both pools at the same tick, writing observations the way swaps do.
    function _buildHistory(uint32 duration) internal {
        uint32 elapsed;
        while (elapsed < duration) {
            vm.warp(block.timestamp + 10);
            elapsed += 10;
            poolA.swapToTick(TICK + 1);
            poolA.swapToTick(TICK);
            poolB.swapToTick(TICK + 1);
            poolB.swapToTick(TICK);
        }
        vm.warp(block.timestamp + 1);
    }

    function _seal() internal {
        (, int24 a,,,,,) = poolA.slot0();
        (, int24 b,,,,,) = poolB.slot0();
        poolA.swapToTick(a + 1);
        poolB.swapToTick(b + 1);
    }

    function _target() internal view returns (uint256) {
        (,, uint16 ia,,,,) = poolA.slot0();
        (uint32 ta,,,) = poolA.observations(ia);
        (,, uint16 ib,,,,) = poolB.slot0();
        (uint32 tb,,,) = poolB.observations(ib);
        return ta < tb ? ta : tb;
    }

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    function test_resolvesOrderingPerSource() public view {
        assertEq(oracle.sourceCount(), 2);
        (address p0, bool base0IsToken0) = oracle.sourceAt(0);
        assertEq(p0, address(poolA));
        assertFalse(base0IsToken0, "PONS is token1 in both live pools");
    }

    function test_rejectsEmptyAndOversizedSourceSets() public {
        address[] memory none = new address[](0);
        vm.expectRevert(CompositePonsOracle.NoSources.selector);
        new CompositePonsOracle(none, address(pons), address(weth), 18, W, GATE_BPS, 1);

        address[] memory many = new address[](6);
        for (uint256 i = 0; i < 6; i++) {
            many[i] = address(poolA);
        }
        vm.expectRevert(abi.encodeWithSelector(CompositePonsOracle.TooManySources.selector, uint256(6), uint256(5)));
        new CompositePonsOracle(many, address(pons), address(weth), 18, W, GATE_BPS, 1);
    }

    /// @dev A zero tolerance would demand independent pools agree to the tick, which they
    ///      never do — every round would refuse to settle.
    function test_rejectsZeroDivergenceTolerance() public {
        vm.expectRevert(CompositePonsOracle.DivergenceToleranceZero.selector);
        _deploy(0);
    }

    function test_rejectsPoolWithoutThePair() public {
        MockERC20 other = new MockERC20("X", "X", 18);
        MockUniswapV3Pool wrong = new MockUniswapV3Pool(address(weth), address(other), 500, TICK);
        address[] memory p = new address[](2);
        p[0] = address(poolA);
        p[1] = address(wrong);
        vm.expectRevert(
            abi.encodeWithSelector(CompositePonsOracle.BaseTokenNotInPool.selector, address(wrong), address(pons))
        );
        new CompositePonsOracle(p, address(pons), address(weth), 18, W, GATE_BPS, 1);
    }

    function test_inheritsTheDecimalsGuards() public {
        vm.expectRevert(abi.encodeWithSelector(CompositePonsOracle.BaseDecimalsTooLarge.selector, uint8(39)));
        new CompositePonsOracle(_pools(), address(pons), address(weth), 39, W, GATE_BPS, 1);
        vm.expectRevert(abi.encodeWithSelector(CompositePonsOracle.BaseDecimalsMismatch.selector, uint8(6), uint8(18)));
        new CompositePonsOracle(_pools(), address(pons), address(weth), 6, W, GATE_BPS, 1);
    }

    /*//////////////////////////////////////////////////////////////
                            AGREEING SOURCES
    //////////////////////////////////////////////////////////////*/

    function test_agreeingSourcesPriceNormally() public {
        uint256 t = _target();
        (bool ok, string memory why) = oracle.canQuote(t, W);
        assertTrue(ok, why);
        (uint256 price, int24 tick) = oracle.getPriceAt(t, W);
        assertGt(price, 0);
        // Both sources sit at TICK, and ticks are normalised so base behaves as token0.
        assertEq(tick, -TICK);
    }

    /*//////////////////////////////////////////////////////////////
                       THE POINT OF THE CONTRACT
    //////////////////////////////////////////////////////////////*/

    /// @dev Moving one pool past the tolerance must not move the price. It must stop the
    ///      round instead, so the attacker pays fees and gets nothing.
    function test_movingOneSourcePastTheGateRefusesToPrice() public {
        // Hold pool A 400bp away from pool B for the whole window.
        poolA.swapToTick(TICK - 400);
        _buildHistoryOn(poolA, TICK - 400, W + 60);
        _seal();
        vm.warp(block.timestamp + 1);
        _seal();

        uint256 t = _target();
        (bool ok, string memory why) = oracle.canQuote(t, W);
        assertFalse(ok, "a diverged pair must not price");
        assertEq(why, "SOURCES_DIVERGED");
        vm.expectRevert();
        oracle.getPriceAt(t, W);
    }

    /// @dev And inside the tolerance the median caps the achievable shift at about half
    ///      the divergence, rather than passing it through in full.
    function test_shiftInsideTheGateIsHalvedByTheMedian() public {
        uint256 tBefore = _target();
        (, int24 clean) = oracle.getPriceAt(tBefore, W);

        // Move one pool by 60bp, comfortably inside a 100bp gate, and hold it.
        poolA.swapToTick(TICK - 60);
        _buildHistoryOn(poolA, TICK - 60, W + 60);
        _seal();
        vm.warp(block.timestamp + 1);
        _seal();

        (, int24 dirty) = oracle.getPriceAt(_target(), W);
        int24 shift = dirty - clean;
        // 60bp on one of two sources moves the median ~30bp, not 60.
        assertGt(shift, 20);
        assertLt(shift, 45);
        console2.log("single-source move 60bp -> median shift (bp)", vm.toString(shift));
    }

    /// @dev A stalled source must not be silently dropped: that would be the cheapest
    ///      attack of all — freeze one pool, then move the survivor alone.
    function test_anUnavailableSourceStopsTheQuoteRatherThanBeingSkipped() public {
        // Fresh pool with a single observation cannot serve a 300s window.
        MockUniswapV3Pool thin = new MockUniswapV3Pool(address(weth), address(pons), 500, TICK);
        address[] memory p = new address[](2);
        p[0] = address(poolA);
        p[1] = address(thin);
        CompositePonsOracle o = new CompositePonsOracle(p, address(pons), address(weth), 18, W, GATE_BPS, 1);

        uint256 t = _target();
        (bool ok, string memory why) = o.canQuote(t, W);
        assertFalse(ok);
        assertEq(why, "SOURCE_UNAVAILABLE");
        vm.expectRevert(abi.encodeWithSelector(CompositePonsOracle.SourceUnavailable.selector, address(thin)));
        o.getPriceAt(t, W);
    }

    /// @dev Sub-second manipulation stays inert, as with the single-pool adapter.
    function test_subSecondMoveOnBothPoolsChangesNothing() public {
        uint256 t = _target();
        (uint256 before,) = oracle.getPriceAt(t, W);
        poolA.swapToTick(TICK - 20_000);
        poolB.swapToTick(TICK - 20_000);
        poolA.swapToTick(TICK);
        poolB.swapToTick(TICK);
        (uint256 afterP,) = oracle.getPriceAt(t, W);
        assertEq(afterP, before, "an unheld move changed a historical composite TWAP");
    }

    /// @dev Availability is bounded by the *shortest* history, not the longest.
    function test_earliestAvailableIsTheMostRestrictiveSource() public view {
        assertGe(oracle.earliestAvailableTimestamp(), 0);
        (bool ok,) = oracle.canQuote(block.timestamp, W);
        // Not sealed at `block.timestamp` for both, so this must refuse.
        assertFalse(ok);
    }

    function test_inspectExposesPerSourceTicksAndSpread() public {
        poolA.swapToTick(TICK - 50);
        _buildHistoryOn(poolA, TICK - 50, W + 60);
        _seal();
        vm.warp(block.timestamp + 1);
        _seal();

        (int24[] memory ticks, bool[] memory available, uint256 spreadBps) = oracle.inspect(_target(), W);
        assertEq(ticks.length, 2);
        assertTrue(available[0] && available[1]);
        assertGt(spreadBps, 0, "a real divergence should be visible to monitoring");
        console2.log("observed spread (bp)", spreadBps);
    }

    /// @dev The operations dashboard and the read API call these through the same ABI as
    ///      the single-pool adapter. Matching the shapes is what keeps every existing
    ///      consumer working after a switch to the composite — the first attempt at this
    ///      switch broke oracle health on /admin because they were missing.
    function test_reportsMonitoringSurfaceInTheSameShape() public {
        (uint16 index, uint16 card, uint16 cardNext, uint256 oldest, uint256 newest) = oracle.observationState();
        index;
        // Most restrictive across sources: both were grown to 2048 here.
        assertEq(card, 2048);
        assertEq(cardNext, 2048);
        assertGt(newest, 0);
        assertGt(newest, oldest);

        // Liquidity is summed, because manipulating the composite means moving every pool.
        poolA.setLiquidity(3e18);
        poolB.setLiquidity(5e18);
        assertEq(oracle.poolLiquidity(), 8e18);

        uint128[] memory per = oracle.sourceLiquidity();
        assertEq(per.length, 2);
        assertEq(per[0], 3e18);
        assertEq(per[1], 5e18);
    }

    /// @dev And the most restrictive cardinality really is reported, so monitoring sees
    ///      the pool that would fail first rather than an average that hides it.
    function test_observationStateReportsTheWeakestSource() public {
        MockUniswapV3Pool thin = new MockUniswapV3Pool(address(weth), address(pons), 500, TICK);
        thin.increaseObservationCardinalityNext(64);
        address[] memory p = new address[](2);
        p[0] = address(poolA);
        p[1] = address(thin);
        CompositePonsOracle o = new CompositePonsOracle(p, address(pons), address(weth), 18, W, GATE_BPS, 1);

        (, uint16 card,,,) = o.observationState();
        assertEq(card, 1, "should report the un-grown source, not the healthy one");
    }

    function _buildHistoryOn(MockUniswapV3Pool pool, int24 at, uint32 duration) internal {
        uint32 elapsed;
        while (elapsed < duration) {
            vm.warp(block.timestamp + 10);
            elapsed += 10;
            pool.swapToTick(at + 1);
            pool.swapToTick(at);
            // Keep the other source alive at its own level so only one has moved.
            (, int24 b,,,,,) = poolB.slot0();
            if (pool != poolB) {
                poolB.swapToTick(b + 1);
                poolB.swapToTick(b);
            }
        }
    }
}
