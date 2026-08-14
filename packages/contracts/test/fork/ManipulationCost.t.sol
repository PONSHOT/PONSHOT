// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsAddresses} from "../../src/PonsAddresses.sol";
import {IUniswapV3PoolMinimal} from "../../src/interfaces/IUniswapV3PoolMinimal.sol";
import {PoolSwapper} from "../../src/mocks/PoolSwapper.sol";
import {UniswapV3PonsOracle} from "../../src/oracle/UniswapV3PonsOracle.sol";
import {Test, console2} from "forge-std/Test.sol";

interface IERC20Bal {
    function balanceOf(address) external view returns (uint256);
}

/// @notice Measures what it actually costs to move the live PONS/WETH pool, and what
///         that buys an attacker in terms of the settlement TWAP.
///
/// @dev This exists because a manipulation analysis written from a liquidity formula is
///      only as good as its assumptions about the tick distribution. Swapping against
///      the real pool on a fork sidesteps all of that: the numbers below are what the
///      deployed pool actually does. They are the source for the tables in
///      docs/MANIPULATION_ANALYSIS.md.
///
///      Run against a *cached* endpoint (local Anvil fork); crossing ticks reads a lot
///      of storage and public RPCs rate-limit it.
///        ROBINHOOD_RPC=http://127.0.0.1:8546 forge test --mc ManipulationCost -vv
contract ManipulationCostTest is Test {
    IUniswapV3PoolMinimal internal pool = IUniswapV3PoolMinimal(PonsAddresses.PONS_WETH_POOL_10000);
    UniswapV3PonsOracle internal oracle;
    PoolSwapper internal swapper;
    bool internal forked;

    uint32 internal constant W = 60;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {
            return;
        }
        oracle = new UniswapV3PonsOracle(
            PonsAddresses.PONS_WETH_POOL_10000, PonsAddresses.PONS, PonsAddresses.WETH, 18, W, 1
        );
        swapper = new PoolSwapper();
        deal(PonsAddresses.WETH, address(swapper), 100_000 ether);
        deal(PonsAddresses.PONS, address(swapper), 500_000_000 ether);
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

    /// @dev Price impact of buying PONS with increasing amounts of WETH, and the round-trip
    ///      cost of undoing it. The round-trip loss is the attacker's actual bill.
    function test_fork_measurePriceImpactAndRoundTripCost() public onlyForked {
        uint256[7] memory sizes = [uint256(1 ether), 5 ether, 10 ether, 25 ether, 50 ether, 100 ether, 250 ether];

        console2.log("WETH_in | price_move_bps | round_trip_loss_wei | loss_as_pct_of_input_bps");
        for (uint256 i = 0; i < sizes.length; i++) {
            uint256 snap = vm.snapshotState();

            (uint256 before,) = oracle.getSpotPrice();
            uint256 wethBefore = IERC20Bal(PonsAddresses.WETH).balanceOf(address(swapper));
            uint256 ponsStart = IERC20Bal(PonsAddresses.PONS).balanceOf(address(swapper));

            // Buy PONS (token0 in), which pushes the PONS price up.
            swapper.swapExactIn(address(pool), true, sizes[i]);
            (uint256 peak,) = oracle.getSpotPrice();

            // Sell every PONS just acquired straight back.
            uint256 ponsGained = IERC20Bal(PonsAddresses.PONS).balanceOf(address(swapper)) - ponsStart;
            swapper.swapExactIn(address(pool), false, ponsGained);
            uint256 wethAfter = IERC20Bal(PonsAddresses.WETH).balanceOf(address(swapper));

            uint256 moveBps = ((peak - before) * 10_000) / before;
            uint256 loss = wethBefore > wethAfter ? wethBefore - wethAfter : 0;
            uint256 lossBps = (loss * 10_000) / sizes[i];

            console2.log(sizes[i] / 1e18);
            console2.log("   move bps      ", moveBps);
            console2.log("   round trip loss (wei)", loss);
            console2.log("   loss as bps of input ", lossBps);

            vm.revertToState(snap);
        }
    }

    /// @dev The number that actually matters: what a *held* displacement does to the
    ///      settlement TWAP, and therefore what an attacker must pay per basis point of
    ///      TWAP movement.
    function test_fork_costToShiftTheSettlementTwap() public onlyForked {
        // Seal a baseline instant first.
        vm.warp(block.timestamp + 5);
        swapper.swapExactIn(address(pool), true, 1 ether);
        vm.warp(block.timestamp + 5);
        swapper.swapExactIn(address(pool), true, 1 ether);
        uint256 target = block.timestamp;

        uint256[4] memory sizes = [uint256(25 ether), 50 ether, 100 ether, 250 ether];
        uint32[3] memory holdFor = [uint32(5), 15, 30];

        for (uint256 i = 0; i < sizes.length; i++) {
            for (uint256 j = 0; j < holdFor.length; j++) {
                _measureAttack(target, sizes[i], holdFor[j]);
            }
        }
    }

    /// @dev Split out of the loop purely to stay under the stack limit.
    function _measureAttack(uint256 target, uint256 size, uint32 holdSeconds) internal {
        uint256 snap = vm.snapshotState();

        uint256 wethBefore = IERC20Bal(PonsAddresses.WETH).balanceOf(address(swapper));
        // Measured against the balance immediately before this swap, not the starting
        // endowment: earlier setup trades also left PONS behind, and selling those too
        // would credit the attacker with WETH they never spent.
        uint256 ponsBefore = IERC20Bal(PonsAddresses.PONS).balanceOf(address(swapper));

        swapper.swapExactIn(address(pool), true, size);
        // Hold the displaced price across real seconds, then undo it.
        vm.warp(block.timestamp + holdSeconds);
        swapper.swapExactIn(
            address(pool), false, IERC20Bal(PonsAddresses.PONS).balanceOf(address(swapper)) - ponsBefore
        );
        uint256 wethAfter = IERC20Bal(PonsAddresses.WETH).balanceOf(address(swapper));
        uint256 cost = wethBefore > wethAfter ? wethBefore - wethAfter : 0;

        // Seal an instant after the attack, then read the window containing it.
        vm.warp(block.timestamp + 2);
        swapper.swapExactIn(address(pool), true, 0.1 ether);

        (uint256 clean,) = oracle.getPriceAt(target, W);
        (uint256 dirty,) = oracle.getPriceAt(oracle.newestObservationTimestamp(), W);
        uint256 shiftBps = dirty > clean ? ((dirty - clean) * 10_000) / clean : 0;

        console2.log("size WETH", size / 1e18);
        console2.log("  held seconds     ", holdSeconds);
        console2.log("  cost wei         ", cost);
        console2.log("  twap shift bps   ", shiftBps);
        if (shiftBps > 0) console2.log("  cost per bp wei  ", cost / shiftBps);

        vm.revertToState(snap);
    }

    /// @dev The control: the same capital, deployed and withdrawn inside one second,
    ///      must buy exactly nothing.
    function test_fork_unheldDisplacementBuysNothing() public onlyForked {
        vm.warp(block.timestamp + 5);
        swapper.swapExactIn(address(pool), true, 1 ether);
        uint256 target = oracle.newestObservationTimestamp();
        (uint256 before,) = oracle.getPriceAt(target, W);

        // 250 WETH in and straight back out, same second.
        uint256 ponsStart = IERC20Bal(PonsAddresses.PONS).balanceOf(address(swapper));
        swapper.swapExactIn(address(pool), true, 250 ether);
        uint256 gained = IERC20Bal(PonsAddresses.PONS).balanceOf(address(swapper)) - ponsStart;
        swapper.swapExactIn(address(pool), false, gained);

        (uint256 afterP,) = oracle.getPriceAt(target, W);
        assertEq(afterP, before, "an unheld displacement moved the settlement price");
        console2.log("250 WETH round trip inside one second shifted the TWAP by 0 wei");
    }
}
