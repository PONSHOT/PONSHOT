// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsAddresses} from "../../src/PonsAddresses.sol";
import {PonsPrediction} from "../../src/PonsPrediction.sol";
import {IPonsPredictionTypes} from "../../src/interfaces/IPonsPrediction.sol";
import {IUniswapV3PoolMinimal} from "../../src/interfaces/IUniswapV3PoolMinimal.sol";
import {PoolSwapper} from "../../src/mocks/PoolSwapper.sol";
import {UniswapV3PonsOracle} from "../../src/oracle/UniswapV3PonsOracle.sol";
import {Test, console2} from "forge-std/Test.sol";

/// @notice A whole round, start to claim, against the **real** PONS/WETH pool on chain
///         4663 — real liquidity, real observation history, real ticks.
/// @dev Mocks can only ever confirm that the code agrees with my model of Uniswap. This
///      is the test that confirms the model. Skipped when no RPC is configured.
///        ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com forge test --mc LiveMarketFork -vv
contract LiveMarketForkTest is Test, IPonsPredictionTypes {
    IUniswapV3PoolMinimal internal pool = IUniswapV3PoolMinimal(PonsAddresses.PONS_WETH_POOL_10000);
    UniswapV3PonsOracle internal oracle;
    PonsPrediction internal market;
    PoolSwapper internal swapper;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal treasuryWallet = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal charlie = makeAddr("charlie");

    uint32 internal constant INTERVAL = 300;
    uint32 internal constant TWAP = 60;
    bool internal forked;

    function setUp() public {
        string memory rpc = vm.envOr("ROBINHOOD_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        try vm.createSelectFork(rpc) {
            forked = true;
        } catch {
            return;
        }

        oracle = new UniswapV3PonsOracle(
            PonsAddresses.PONS_WETH_POOL_10000, PonsAddresses.PONS, PonsAddresses.WETH, 18, TWAP, 1
        );
        market = new PonsPrediction(
            PonsPrediction.InitParams({
                admin: admin,
                operator: operator,
                treasury: treasuryWallet,
                oracle: address(oracle),
                interval: INTERVAL,
                twapWindow: TWAP,
                bufferSeconds: 1800,
                treasuryFeeBps: 300,
                minimumBet: 0.001 ether,
                maximumBet: 1 ether,
                maximumRoundPool: 10 ether
            })
        );

        swapper = new PoolSwapper();
        deal(PonsAddresses.WETH, address(swapper), 500 ether);
        deal(PonsAddresses.PONS, address(swapper), 5_000_000 ether);

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(charlie, 10 ether);
        vm.prank(operator);
        market.genesisStartRound();
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

    /// @dev Trades enough to shift the tick, which is what makes the pool write an
    ///      observation and therefore seal the instants the market needs.
    function _tradeToSeal(bool zeroForOne, uint256 amountIn) internal {
        (, int24 before,,,,,) = pool.slot0();
        swapper.swapExactIn(address(pool), zeroForOne, amountIn);
        (, int24 afterTick,,,,,) = pool.slot0();
        assertTrue(afterTick != before, "swap did not move the tick, so nothing was sealed");
    }

    function _claim(address who, uint256 epoch) internal returns (uint256) {
        uint256[] memory e = new uint256[](1);
        e[0] = epoch;
        uint256 balBefore = who.balance;
        vm.prank(who);
        market.claim(e);
        return who.balance - balBefore;
    }

    /// @dev The brief's required scenario, on the live pool.
    function test_fork_fullRoundAgainstTheRealPonsPool() public onlyForked {
        Round memory r1 = market.getRound(1);

        vm.prank(alice);
        market.betBull{value: 0.1 ether}(1);
        vm.prank(bob);
        market.betBear{value: 0.2 ether}(1);
        vm.prank(charlie);
        market.betBull{value: 0.05 ether}(1);
        assertEq(market.getRound(1).totalAmount, 0.35 ether);

        // --- lock ---
        vm.warp(r1.lockTimestamp + 2);
        // Buying PONS with WETH: token0 in, tick falls, PONS price rises.
        _tradeToSeal(true, 40 ether);
        market.executeRound();

        Round memory locked = market.getRound(1);
        assertTrue(locked.status == RoundStatus.Locked, "round 1 did not lock");
        assertGt(locked.lockPrice, 0);
        assertEq(market.currentEpoch(), 2, "round 2 should be open");
        console2.log("lock price (wei WETH per PONS)", locked.lockPrice);
        console2.log("lock tick", vm.toString(market.getRoundTerms(1).lockTick));

        // --- the market moves during the round ---
        vm.warp(r1.lockTimestamp + 100);
        _tradeToSeal(true, 120 ether); // buy more PONS: price up further
        vm.warp(r1.lockTimestamp + 200);
        _tradeToSeal(true, 60 ether);

        // --- settle ---
        vm.warp(r1.closeTimestamp + 2);
        _tradeToSeal(true, 10 ether);
        market.executeRound();

        Round memory settled = market.getRound(1);
        assertTrue(settled.status == RoundStatus.Settled, "round 1 did not settle");
        console2.log("close price (wei WETH per PONS)", settled.closePrice);
        assertGt(settled.closePrice, settled.lockPrice, "buying PONS should raise its WETH price");
        assertTrue(market.getRoundTerms(1).outcome == Outcome.Bull, "UP must win after PONS appreciated");

        // --- payouts ---
        uint256 fee = (0.35 ether * 300) / 10_000;
        uint256 reward = 0.35 ether - fee;
        assertEq(settled.rewardAmount, reward);
        assertEq(_claim(alice, 1), (0.1 ether * reward) / 0.15 ether);
        assertEq(_claim(charlie, 1), (0.05 ether * reward) / 0.15 ether);
        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(bob);
        vm.expectRevert();
        market.claim(e);

        (uint256 balance, uint256 owed, bool solvent) = market.solvency();
        assertTrue(solvent);
        assertGe(balance, owed);
    }

    /// @dev The direction check, done by actually trading rather than by reasoning:
    ///      selling PONS into the pool must make PONS cheaper in WETH.
    function test_fork_sellingPonsLowersItsPrice() public onlyForked {
        (uint256 before,) = oracle.getSpotPrice();
        swapper.swapExactIn(address(pool), false, 2_000_000 ether); // token1 (PONS) in
        (uint256 afterP,) = oracle.getSpotPrice();
        assertLt(afterP, before, "selling PONS did not lower its price");
        console2.log("PONS price before", before);
        console2.log("PONS price after ", afterP);
    }

    /// @dev Manipulation resistance, measured on real liquidity: a very large swap that
    ///      is not held across a second boundary moves spot enormously and the settled
    ///      TWAP not at all.
    function test_fork_flashMoveOnRealPoolDoesNotMoveTheSettledPrice() public onlyForked {
        vm.warp(block.timestamp + 5);
        _tradeToSeal(true, 5 ether);
        uint256 target = oracle.newestObservationTimestamp();
        (uint256 twapBefore,) = oracle.getPriceAt(target, TWAP);
        (uint256 spotBefore,) = oracle.getSpotPrice();

        // A 400 WETH swap and its reversal, inside the same second.
        swapper.swapExactIn(address(pool), true, 400 ether);
        (uint256 spotPeak,) = oracle.getSpotPrice();
        assertGt(spotPeak, (spotBefore * 12) / 10, "the attack should have moved spot a lot");

        (uint256 twapAfter,) = oracle.getPriceAt(target, TWAP);
        assertEq(twapAfter, twapBefore, "a same-second move changed the settlement TWAP");
        console2.log("spot before   ", spotBefore);
        console2.log("spot at peak  ", spotPeak);
        console2.log("TWAP unchanged", twapAfter);
    }
}
