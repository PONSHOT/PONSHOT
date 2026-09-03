// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsAddresses} from "../../src/PonsAddresses.sol";
import {IPredictionOracle} from "../../src/interfaces/IPredictionOracle.sol";
import {IUniswapV3FactoryMinimal, IUniswapV3PoolMinimal} from "../../src/interfaces/IUniswapV3PoolMinimal.sol";
import {TickPriceMath} from "../../src/libraries/TickPriceMath.sol";
import {UniswapV3PonsOracle} from "../../src/oracle/UniswapV3PonsOracle.sol";
import {Test, console2} from "forge-std/Test.sol";

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
}

/// @notice Fork tests that hold the *spec's* claims about PONS up against chain 4663.
/// @dev Skipped automatically when no Robinhood RPC is configured, so CI without
///      network access still goes green. Run with:
///        ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com forge test --mc PonsOracleFork -vv
contract PonsOracleForkTest is Test {
    IUniswapV3PoolMinimal internal pool = IUniswapV3PoolMinimal(PonsAddresses.PONS_WETH_POOL_10000);
    UniswapV3PonsOracle internal oracle;

    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {
            return;
        }
        oracle = new UniswapV3PonsOracle({
            pool_: PonsAddresses.PONS_WETH_POOL_10000,
            baseToken_: PonsAddresses.PONS,
            quoteToken_: PonsAddresses.WETH,
            baseDecimals_: PonsAddresses.PONS_DECIMALS,
            defaultTwapWindow_: 60,
            oracleVersion_: 1
        });
    }

    modifier onlyForked() {
        if (!forked) {
            // A skipped fork test otherwise reports PASS, so a green run can mean
            // "verified nothing". CI without network access must still pass, so the skip
            // stays -- but REQUIRE_FORK=true turns it into a failure for the pre-launch
            // check, where a silent skip is exactly what you must not accept.
            if (vm.envOr("REQUIRE_FORK", false)) {
                revert("fork required but unavailable: set ROBINHOOD_RPC to a reachable endpoint");
            }
            console2.log("!! SKIPPED (no ROBINHOOD_RPC) - this test verified NOTHING");
            return;
        }
        _;
    }

    /// @dev Phase 1 of the brief: prove the handed-down constants, do not assume them.
    function test_fork_verifiesEveryDeclaredAddress() public onlyForked {
        assertEq(block.chainid, PonsAddresses.CHAIN_ID, "chain id");

        assertGt(PonsAddresses.PONS.code.length, 0, "PONS has no code");
        assertGt(PonsAddresses.WETH.code.length, 0, "WETH has no code");
        assertGt(PonsAddresses.PONS_WETH_POOL_10000.code.length, 0, "pool has no code");

        assertEq(IERC20Meta(PonsAddresses.PONS).decimals(), 18, "PONS decimals");
        assertEq(IERC20Meta(PonsAddresses.WETH).decimals(), 18, "WETH decimals");
        assertEq(IERC20Meta(PonsAddresses.PONS).symbol(), "PONS", "PONS symbol");

        // The ordering the brief explicitly warned not to assume.
        assertEq(pool.token0(), PonsAddresses.WETH, "token0 must be WETH");
        assertEq(pool.token1(), PonsAddresses.PONS, "token1 must be PONS");
        assertFalse(oracle.baseIsToken0(), "PONS is token1, so base is not token0");

        assertEq(pool.fee(), PonsAddresses.POOL_FEE, "fee tier");
        assertEq(pool.tickSpacing(), PonsAddresses.POOL_TICK_SPACING, "tick spacing");
        assertEq(pool.factory(), PonsAddresses.UNISWAP_V3_FACTORY, "factory");

        // The pool is the one the factory registers for this exact triple.
        assertEq(
            IUniswapV3FactoryMinimal(PonsAddresses.UNISWAP_V3_FACTORY)
                .getPool(PonsAddresses.WETH, PonsAddresses.PONS, PonsAddresses.POOL_FEE),
            PonsAddresses.PONS_WETH_POOL_10000,
            "factory does not register this pool"
        );
    }

    function test_fork_poolHasUsableLiquidityAndHistory() public onlyForked {
        assertGt(pool.liquidity(), 0, "no in-range liquidity");

        (uint16 index, uint16 cardinality, uint16 cardinalityNext, uint256 oldest, uint256 newest) =
            oracle.observationState();
        console2.log("observationIndex      ", index);
        console2.log("cardinality           ", cardinality);
        console2.log("cardinalityNext       ", cardinalityNext);
        console2.log("oldest observation    ", oldest);
        console2.log("newest observation    ", newest);
        console2.log("history span (seconds)", newest - oldest);

        assertGt(cardinality, 1, "buffer never grown - TWAP unusable");
        // A 5-minute round needs, worst case, a window reaching back one interval plus
        // the TWAP length. Insist on materially more than that.
        assertGt(newest - oldest, 1 hours, "history too short for the intended windows");
    }

    /// @dev The conversion is the part most likely to be silently wrong, so it is
    ///      cross-checked against an independently derived figure rather than itself.
    ///
    ///      Note what the correct assertion is here. `sqrtPriceX96` carries the exact
    ///      pool price; `slot0.tick` is its floor on the 1.0001 ladder, so a
    ///      tick-derived price is quantised to one tick (1 bp) and will *not* equal
    ///      the sqrtP-derived price. The meaningful invariant is a bracket: since PONS
    ///      is token1, quoted price is strictly *decreasing* in tick, so the exact
    ///      price must sit in (price(tick+1), price(tick)]. Asserting the bracket
    ///      pins both the magnitude and the direction, which a loose tolerance would not.
    function test_fork_priceMatchesIndependentlyDerivedSpot() public onlyForked {
        (uint256 spot, int24 tick) = oracle.getSpotPrice();
        (uint160 sqrtPriceX96, int24 slot0Tick,,,,,) = pool.slot0();
        assertEq(tick, slot0Tick, "tick mismatch");

        console2.log("slot0 tick            ", vm.toString(tick));
        console2.log("spot WETH per PONS wei", spot);

        // Recompute from sqrtPriceX96 by a different route: price(token1 per token0)
        // = (sqrtP/2^96)^2, and we want its reciprocal scaled to 1e18.
        uint256 num = 1e18 * (uint256(1) << 96) * (uint256(1) << 96);
        uint256 exact = num / (uint256(sqrtPriceX96) * uint256(sqrtPriceX96));
        console2.log("sqrtP-derived price   ", exact);

        uint256 priceAtNextTick = TickPriceMath.quoteAtTick(tick + 1, oracle.baseUnit(), oracle.baseIsToken0());
        assertLt(priceAtNextTick, spot, "price must decrease as tick rises when base is token1");
        assertLe(exact, spot, "exact price above price(tick)");
        assertGt(exact, priceAtNextTick, "exact price at or below price(tick+1)");

        // And the quantisation is at most one tick, i.e. ~1 bp.
        assertApproxEqRel(spot, exact, 0.0002e18, "quantisation exceeds one tick");

        // Sanity band: PONS should be worth a small but non-dust amount of WETH.
        assertGt(spot, 1e6, "price implausibly small");
        assertLt(spot, 1e18, "PONS priced above 1 WETH - check ordering");
    }

    function test_fork_twapIsAvailableAcrossCandidateWindows() public onlyForked {
        uint256 target = oracle.newestObservationTimestamp();
        uint32[5] memory windows = [uint32(30), 60, 120, 300, 600];

        (uint256 spot,) = oracle.getSpotPrice();
        for (uint256 i = 0; i < windows.length; i++) {
            (bool ok, string memory reason) = oracle.canQuote(target, windows[i]);
            assertTrue(ok, string.concat("window unavailable: ", reason));

            (uint256 p, int24 mt) = oracle.getPriceAt(target, windows[i]);
            console2.log("window", windows[i]);
            console2.log("  meanTick", vm.toString(mt));
            console2.log("  price   ", p);
            assertGt(p, 0, "zero TWAP price");
            // Over quiet windows the TWAP should sit near spot; a wild divergence
            // would mean the window maths is wrong, not that the market moved.
            assertApproxEqRel(p, spot, 0.25e18, "TWAP implausibly far from spot");
        }
    }

    /// @dev The sealing rule, exercised against real history rather than a mock.
    function test_fork_refusesUnsealedAndFutureInstants() public onlyForked {
        uint256 newest = oracle.newestObservationTimestamp();

        // An instant newer than the newest observation is not yet sealed.
        if (newest < block.timestamp) {
            (bool ok, string memory reason) = oracle.canQuote(block.timestamp, 60);
            assertFalse(ok, "unsealed instant was accepted");
            assertEq(reason, "TARGET_NOT_SEALED", reason);
            vm.expectRevert(
                abi.encodeWithSelector(UniswapV3PonsOracle.TargetNotSealed.selector, block.timestamp, newest)
            );
            oracle.getPriceAt(block.timestamp, 60);
        }

        vm.expectRevert(
            abi.encodeWithSelector(UniswapV3PonsOracle.TargetInFuture.selector, block.timestamp + 1, block.timestamp)
        );
        oracle.getPriceAt(block.timestamp + 1, 60);
    }

    function test_fork_rejectsWindowOlderThanRingBuffer() public onlyForked {
        uint256 target = oracle.newestObservationTimestamp();
        uint256 earliest = oracle.earliestAvailableTimestamp();
        uint32 tooLong = uint32(target - earliest) + 1 days;

        (bool ok, string memory reason) = oracle.canQuote(target, tooLong);
        assertFalse(ok, "evicted window accepted");
        assertEq(reason, "HISTORY_EVICTED", reason);
    }

    /// @dev Records the live market snapshot the analysis docs are written against.
    function test_fork_logMarketSnapshot() public onlyForked {
        console2.log("=== PONS market snapshot ===");
        console2.log("block           ", block.number);
        console2.log("timestamp       ", block.timestamp);
        console2.log("pool WETH balance", IERC20Meta(PonsAddresses.WETH).balanceOf(address(pool)));
        console2.log("pool PONS balance", IERC20Meta(PonsAddresses.PONS).balanceOf(address(pool)));
        console2.log("in-range liquidity", pool.liquidity());
        (uint256 p, uint256 t) = oracle.getPrice();
        console2.log("getPrice()      ", p);
        console2.log("  as of         ", t);
        console2.log("description     ", oracle.description());
    }
}
