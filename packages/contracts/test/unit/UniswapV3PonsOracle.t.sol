// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {TickPriceMath} from "../../src/libraries/TickPriceMath.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockUniswapV3Pool} from "../../src/mocks/MockUniswapV3Pool.sol";
import {UniswapV3PonsOracle} from "../../src/oracle/UniswapV3PonsOracle.sol";
import {TickMath} from "../../src/vendor/uniswap/TickMath.sol";
import {Test, console2} from "forge-std/Test.sol";

contract UniswapV3PonsOracleTest is Test {
    MockERC20 internal weth;
    MockERC20 internal pons;
    MockUniswapV3Pool internal pool;
    UniswapV3PonsOracle internal oracle;

    uint32 internal constant W = 60;
    int24 internal constant START_TICK = 84_400; // roughly the live PONS/WETH tick

    function setUp() public {
        vm.warp(1_000_000);
        weth = new MockERC20("WETH", "WETH", 18);
        pons = new MockERC20("Pons", "PONS", 18);
        // Live ordering: WETH is token0, PONS is token1.
        pool = new MockUniswapV3Pool(address(weth), address(pons), 10_000, START_TICK);
        pool.increaseObservationCardinalityNext(1024);
        oracle = _deploy(address(pool), address(pons), address(weth), 18, W);
        _buildHistory(2 hours, START_TICK);
    }

    function _deploy(address pool_, address base, address quote, uint8 dec, uint32 window)
        internal
        returns (UniswapV3PonsOracle)
    {
        return new UniswapV3PonsOracle(pool_, base, quote, dec, window, 1);
    }

    /// @dev Lays down a stretch of history at a constant tick by trading in a way that
    ///      actually writes observations (tick must change to write one).
    function _buildHistory(uint32 duration, int24 atTick) internal {
        uint32 elapsed;
        while (elapsed < duration) {
            vm.warp(block.timestamp + 10);
            elapsed += 10;
            // Nudge one tick away and back so an observation gets written.
            pool.swapToTick(atTick + 1);
            pool.swapToTick(atTick);
        }
        vm.warp(block.timestamp + 1);
    }

    /*//////////////////////////////////////////////////////////////
                       CONSTRUCTION / ORDERING
    //////////////////////////////////////////////////////////////*/

    function test_resolvesTokenOrderingFromPool_baseIsToken1() public view {
        assertFalse(oracle.baseIsToken0(), "PONS is token1 here");
        assertEq(oracle.baseToken(), address(pons));
        assertEq(oracle.quoteToken(), address(weth));
    }

    function test_resolvesTokenOrderingFromPool_baseIsToken0() public {
        // Same pair, opposite ordering. Nothing but the pool decides which is which.
        MockUniswapV3Pool flipped = new MockUniswapV3Pool(address(pons), address(weth), 10_000, START_TICK);
        UniswapV3PonsOracle o = _deploy(address(flipped), address(pons), address(weth), 18, W);
        assertTrue(o.baseIsToken0(), "PONS is token0 here");
    }

    function test_revertsWhenBaseTokenNotInPool() public {
        MockERC20 stranger = new MockERC20("X", "X", 18);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3PonsOracle.BaseTokenNotInPool.selector, address(stranger)));
        _deploy(address(pool), address(stranger), address(weth), 18, W);
    }

    function test_revertsWhenQuoteTokenNotInPool() public {
        MockERC20 stranger = new MockERC20("X", "X", 18);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3PonsOracle.QuoteTokenNotInPool.selector, address(stranger)));
        _deploy(address(pool), address(pons), address(stranger), 18, W);
    }

    function test_revertsOnZeroWindowAndOverlongWindow() public {
        vm.expectRevert(UniswapV3PonsOracle.ZeroWindow.selector);
        _deploy(address(pool), address(pons), address(weth), 18, 0);
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3PonsOracle.WindowTooLong.selector, uint32(8 days), uint32(7 days))
        );
        _deploy(address(pool), address(pons), address(weth), 18, 8 days);
    }

    /// @dev `10 ** decimals` is narrowed to uint128. Anything above 38 fits uint256 but
    ///      not uint128, so an unchecked cast would truncate silently and every price the
    ///      oracle returned would be wrong by an invisible factor.
    function test_rejectsBaseDecimalsThatWouldTruncate() public {
        MockERC20 wide = new MockERC20("Wide", "WIDE", 39);
        MockUniswapV3Pool p39 = new MockUniswapV3Pool(address(weth), address(wide), 10_000, 0);
        vm.expectRevert(abi.encodeWithSelector(UniswapV3PonsOracle.BaseDecimalsTooLarge.selector, uint8(39)));
        new UniswapV3PonsOracle(address(p39), address(wide), address(weth), 39, W, 1);

        // 38 is the boundary and must still be accepted.
        MockERC20 edge = new MockERC20("Edge", "EDGE", 38);
        MockUniswapV3Pool p38 = new MockUniswapV3Pool(address(weth), address(edge), 10_000, 0);
        UniswapV3PonsOracle ok = new UniswapV3PonsOracle(address(p38), address(edge), address(weth), 38, W, 1);
        assertEq(ok.baseUnit(), uint128(10 ** 38));
    }

    /// @dev A deploy script checking the decimals is not a guarantee; the contract is.
    function test_rejectsDeclaredDecimalsThatContradictTheToken() public {
        vm.expectRevert(abi.encodeWithSelector(UniswapV3PonsOracle.BaseDecimalsMismatch.selector, uint8(6), uint8(18)));
        _deployWithDecimals(6);
    }

    function test_acceptsMatchingDecimals() public {
        UniswapV3PonsOracle o = _deployWithDecimals(18);
        assertEq(o.baseUnit(), 1e18);
    }

    function _deployWithDecimals(uint8 declared) internal returns (UniswapV3PonsOracle) {
        return new UniswapV3PonsOracle(address(pool), address(pons), address(weth), declared, W, 1);
    }

    /*//////////////////////////////////////////////////////////////
                        PRICE DIRECTION & MATH
    //////////////////////////////////////////////////////////////*/

    /// @dev The single most consequential property in the system: with PONS as token1,
    ///      a *rising* tick means PONS is getting *cheaper* in WETH. Inverting this
    ///      would flip every round outcome while leaving all the plumbing looking fine.
    function test_priceDecreasesAsTickRises_whenBaseIsToken1() public view {
        uint256 lo = TickPriceMath.quoteAtTick(START_TICK - 100, 1e18, false);
        uint256 mid = TickPriceMath.quoteAtTick(START_TICK, 1e18, false);
        uint256 hi = TickPriceMath.quoteAtTick(START_TICK + 100, 1e18, false);
        assertGt(lo, mid, "lower tick must be a higher PONS price");
        assertGt(mid, hi, "higher tick must be a lower PONS price");
    }

    function test_priceIncreasesAsTickRises_whenBaseIsToken0() public pure {
        uint256 lo = TickPriceMath.quoteAtTick(-100, 1e18, true);
        uint256 mid = TickPriceMath.quoteAtTick(0, 1e18, true);
        uint256 hi = TickPriceMath.quoteAtTick(100, 1e18, true);
        assertLt(lo, mid);
        assertLt(mid, hi);
    }

    function test_tickZeroIsParityForEqualDecimals() public pure {
        assertEq(TickPriceMath.quoteAtTick(0, 1e18, true), 1e18);
        assertEq(TickPriceMath.quoteAtTick(0, 1e18, false), 1e18);
    }

    function test_handlesNegativeTicks() public pure {
        uint256 p = TickPriceMath.quoteAtTick(-84_400, 1e18, false);
        assertGt(p, 1e18, "negative tick with base=token1 means base is worth more than quote");
    }

    function test_handlesExtremeTicksWithoutOverflow() public pure {
        // Both branches of the 192/128-bit split get exercised at the domain edges.
        assertGt(TickPriceMath.quoteAtTick(TickMath.MAX_TICK, 1e18, true), 0);
        assertGt(TickPriceMath.quoteAtTick(TickMath.MIN_TICK, 1e18, false), 0);
        assertEq(TickPriceMath.quoteAtTick(TickMath.MAX_TICK, 1e18, false), 0, "underflows to zero, as expected");
    }

    function test_decimalsAreAccountedFor() public {
        // A 6-decimal base token must quote 1e6 base units, not 1e18.
        MockERC20 usdcLike = new MockERC20("Six", "SIX", 6);
        MockUniswapV3Pool p6 = new MockUniswapV3Pool(address(weth), address(usdcLike), 10_000, 0);
        UniswapV3PonsOracle o = _deploy(address(p6), address(usdcLike), address(weth), 6, W);
        assertEq(o.baseUnit(), 1e6);
        (uint256 price,) = o.getSpotPrice();
        // tick 0 => 1 base unit == 1 quote unit in raw terms => 1e6 base = 1e6 quote wei.
        assertEq(price, 1e6);
    }

    function test_meanTickRoundsTowardNegativeInfinity() public pure {
        // -5/2 truncates to -2 in Solidity; Uniswap's convention is -3.
        assertEq(TickPriceMath.meanTick(-5, 2), int24(-3));
        assertEq(TickPriceMath.meanTick(5, 2), int24(2));
        assertEq(TickPriceMath.meanTick(-4, 2), int24(-2));
    }

    /*//////////////////////////////////////////////////////////////
                              TWAP WINDOW
    //////////////////////////////////////////////////////////////*/

    function test_twapOverFlatHistoryEqualsSpot() public view {
        uint256 target = oracle.newestObservationTimestamp();
        (uint256 twap, int24 mt) = oracle.getPriceAt(target, W);
        (uint256 spot,) = oracle.getSpotPrice();
        assertEq(mt, START_TICK, "flat history must average to the flat tick");
        assertEq(twap, spot, "flat TWAP must equal spot");
    }

    /// @dev A move held for half the window should shift the mean tick by half the move.
    function test_twapWeightsByTimeHeld() public {
        int24 moved = START_TICK + 600;
        vm.warp(block.timestamp + 30);
        pool.swapToTick(moved); // records the old tick for the 30s just elapsed
        vm.warp(block.timestamp + 30);
        pool.swapToTick(START_TICK); // seals the 30s at the moved tick
        vm.warp(block.timestamp + 1);

        uint256 target = oracle.newestObservationTimestamp();
        (, int24 mt) = oracle.getPriceAt(target, W);
        // 30s at START_TICK + 30s at START_TICK+600 => +300.
        assertEq(mt, START_TICK + 300, "mean tick must be time-weighted");
    }

    /// @dev The manipulation the TWAP exists to defeat: a large move that is not held.
    ///      Uniswap records at most one observation per second, using the *pre*-swap
    ///      tick, so a move and its reversal inside one second contribute nothing.
    function test_subSecondManipulationDoesNotMoveTwap() public {
        uint256 target = oracle.newestObservationTimestamp();
        (uint256 before, int24 tickBefore) = oracle.getPriceAt(target, W);

        // No vm.warp between these: same second.
        pool.swapToTick(START_TICK - 20_000); // huge move
        pool.swapToTick(START_TICK); // reversed

        (uint256 afterP, int24 tickAfter) = oracle.getPriceAt(target, W);
        assertEq(afterP, before, "flash move changed a historical TWAP");
        assertEq(tickAfter, tickBefore);
    }

    /// @dev And the corollary: a historical reading must not drift as time passes,
    ///      which is what makes permissionless settlement safe.
    function test_historicalReadingIsStableOverTime() public {
        uint256 target = oracle.newestObservationTimestamp();
        (uint256 first,) = oracle.getPriceAt(target, W);

        for (uint256 i = 0; i < 20; i++) {
            vm.warp(block.timestamp + 37);
            pool.swapToTick(START_TICK + int24(int256(i)) * 50);
        }

        (uint256 later,) = oracle.getPriceAt(target, W);
        assertEq(later, first, "a past window's value changed after the fact");
    }

    function test_spotDivergesFromTwapUnderAMove() public {
        pool.swapToTick(START_TICK - 5000);
        vm.warp(block.timestamp + 5);
        pool.swapToTick(START_TICK - 5000);
        uint256 target = oracle.newestObservationTimestamp();
        (uint256 twap,) = oracle.getPriceAt(target, W);
        (uint256 spot,) = oracle.getSpotPrice();
        assertGt(spot, twap, "spot should lead the average after an upward price move");
    }

    /*//////////////////////////////////////////////////////////////
                           AVAILABILITY RULES
    //////////////////////////////////////////////////////////////*/

    function test_rejectsFutureTarget() public {
        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3PonsOracle.TargetInFuture.selector, block.timestamp + 1, block.timestamp)
        );
        oracle.getPriceAt(block.timestamp + 1, W);
        (bool ok, string memory reason) = oracle.canQuote(block.timestamp + 1, W);
        assertFalse(ok);
        assertEq(reason, "TARGET_IN_FUTURE");
    }

    /// @dev The sealing rule. Until the pool has an observation at or after the target,
    ///      `observe()` would answer by extrapolating with the *live* tick, making the
    ///      reading depend on when it is taken. Refusing keeps settlement deterministic.
    function test_refusesUnsealedTargetAndAcceptsItOnceSealed() public {
        uint256 target = block.timestamp + 30;
        vm.warp(target + 5); // target is in the past, but no trade has happened since

        assertLt(oracle.newestObservationTimestamp(), target, "precondition: unsealed");
        (bool ok, string memory reason) = oracle.canQuote(target, W);
        assertFalse(ok, "unsealed target accepted");
        assertEq(reason, "TARGET_NOT_SEALED");

        // A trade after the target seals it.
        pool.swapToTick(START_TICK + 7);
        assertGe(oracle.newestObservationTimestamp(), target);
        (ok,) = oracle.canQuote(target, W);
        assertTrue(ok, "sealed target still refused");
        (uint256 price,) = oracle.getPriceAt(target, W);
        assertGt(price, 0);
    }

    /// @dev And crucially: waiting longer must not change the answer.
    function test_sealedReadingIsIndependentOfWhoWaitsHowLong() public {
        uint256 target = block.timestamp;
        vm.warp(block.timestamp + 20);
        pool.swapToTick(START_TICK + 3); // seals `target`
        (uint256 early,) = oracle.getPriceAt(target, W);

        vm.warp(block.timestamp + 3000);
        pool.swapToTick(START_TICK - 4000); // market moves a lot afterwards
        vm.warp(block.timestamp + 600);
        pool.swapToTick(START_TICK);

        (uint256 late,) = oracle.getPriceAt(target, W);
        assertEq(late, early, "settling later produced a different price");
    }

    function test_rejectsWindowReachingBeforeRingBuffer() public {
        uint256 target = oracle.newestObservationTimestamp();
        uint256 earliest = oracle.earliestAvailableTimestamp();
        uint32 tooLong = uint32(target - earliest) + 60;
        (bool ok, string memory reason) = oracle.canQuote(target, tooLong);
        assertFalse(ok);
        assertEq(reason, "HISTORY_EVICTED");
        vm.expectRevert();
        oracle.getPriceAt(target, tooLong);
    }

    /// @dev A pool whose buffer was never grown holds one slot, so any real window is
    ///      unserviceable. The adapter must say so rather than return a bad number.
    function test_detectsInsufficientObservationHistory() public {
        MockUniswapV3Pool fresh = new MockUniswapV3Pool(address(weth), address(pons), 10_000, START_TICK);
        UniswapV3PonsOracle o = _deploy(address(fresh), address(pons), address(weth), 18, W);
        (, uint16 card,,,) = o.observationState();
        assertEq(card, 1, "fresh pool has cardinality 1");

        vm.warp(block.timestamp + 10);
        fresh.swapToTick(START_TICK + 1);
        uint256 target = o.newestObservationTimestamp();

        (bool ok, string memory reason) = o.canQuote(target, W);
        assertFalse(ok, "unserviceable window reported as fine");
        assertEq(reason, "HISTORY_EVICTED");
    }

    function test_windowStartUnderflowIsRejected() public {
        vm.warp(100);
        (bool ok, string memory reason) = oracle.canQuote(50, 60);
        assertFalse(ok);
        assertEq(reason, "WINDOW_START_UNDERFLOW");
    }

    function test_getPriceUsesNewestSealedInstant() public view {
        (uint256 price, uint256 ts) = oracle.getPrice();
        assertEq(ts, oracle.newestObservationTimestamp());
        assertGt(price, 0);
    }

    function test_descriptionNamesThePair() public view {
        assertEq(oracle.description(), "UniswapV3 TWAP PONS/WETH fee=10000 window=60s");
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_quoteIsMonotonicInTick(int24 a, int24 b) public pure {
        a = int24(bound(a, TickMath.MIN_TICK + 1, TickMath.MAX_TICK - 1));
        b = int24(bound(b, TickMath.MIN_TICK + 1, TickMath.MAX_TICK - 1));
        vm.assume(a < b);
        uint256 pa = TickPriceMath.quoteAtTick(a, 1e18, false);
        uint256 pb = TickPriceMath.quoteAtTick(b, 1e18, false);
        assertGe(pa, pb, "base=token1 price must be non-increasing in tick");
    }

    function testFuzz_quoteScalesLinearlyInBaseAmount(int24 t, uint64 amount) public pure {
        t = int24(bound(t, -200_000, 200_000));
        vm.assume(amount > 0);
        uint256 one = TickPriceMath.quoteAtTick(t, 1e18, false);
        uint256 many = TickPriceMath.quoteAtTick(t, uint128(amount) * 1e18, false);
        // Floor division makes this an inequality, not an equality.
        assertGe(many + uint256(amount), one * amount);
        assertLe(many, one * amount + uint256(amount));
    }

    function testFuzz_meanTickMatchesUniswapConvention(int56 delta, uint32 window) public pure {
        window = uint32(bound(window, 1, 7 days));
        delta = int56(bound(delta, -int256(uint256(window)) * 887_272, int256(uint256(window)) * 887_272));
        int24 got = TickPriceMath.meanTick(delta, window);
        int56 w = int56(uint56(window));
        int56 expected = delta / w;
        if (delta < 0 && delta % w != 0) expected--;
        assertEq(got, int24(expected));
    }
}
