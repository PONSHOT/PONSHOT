// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsPrediction} from "../../src/PonsPrediction.sol";
import {IPonsPredictionTypes} from "../../src/interfaces/IPonsPrediction.sol";
import {ForceFeeder} from "../../src/mocks/Attackers.sol";
import {MockERC20} from "../../src/mocks/MockERC20.sol";
import {MockUniswapV3Pool} from "../../src/mocks/MockUniswapV3Pool.sol";
import {UniswapV3PonsOracle} from "../../src/oracle/UniswapV3PonsOracle.sol";
import {Test, console2} from "forge-std/Test.sol";

/// @notice The brief's required scenarios, driven through the whole real stack:
///         a genuine Uniswap-semantics pool, the production oracle adapter, and the
///         market. Nothing is stubbed, so the token ordering, the tick-to-price
///         direction and the TWAP windows all have to be right for this to pass.
contract EndToEndTest is Test, IPonsPredictionTypes {
    MockERC20 internal weth;
    MockERC20 internal pons;
    MockUniswapV3Pool internal pool;
    UniswapV3PonsOracle internal oracle;
    PonsPrediction internal market;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal treasuryWallet = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal charlie = makeAddr("charlie");

    uint32 internal constant INTERVAL = 300;
    uint32 internal constant TWAP = 60;
    int24 internal constant TICK_START = 84_400;

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new MockERC20("WETH", "WETH", 18);
        pons = new MockERC20("Pons", "PONS", 18);
        // Live ordering on Robinhood Chain: WETH is token0, PONS is token1.
        pool = new MockUniswapV3Pool(address(weth), address(pons), 10_000, TICK_START);
        pool.increaseObservationCardinalityNext(4096);
        oracle = new UniswapV3PonsOracle(address(pool), address(pons), address(weth), 18, TWAP, 1);

        _trade(TICK_START, 2 hours); // build enough history for any window we use

        market = new PonsPrediction(
            PonsPrediction.InitParams({
                admin: admin,
                operator: operator,
                treasury: treasuryWallet,
                oracle: address(oracle),
                interval: INTERVAL,
                twapWindow: TWAP,
                bufferSeconds: 900,
                treasuryFeeBps: 300,
                minimumBet: 0.001 ether,
                maximumBet: 100 ether,
                maximumRoundPool: 1000 ether
            })
        );
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(charlie, 100 ether);
        vm.prank(operator);
        market.genesisStartRound();
    }

    /// @dev Trades at `tick` for `duration`, writing observations the way real swaps do.
    function _trade(int24 tick, uint32 duration) internal {
        uint32 elapsed;
        while (elapsed < duration) {
            vm.warp(block.timestamp + 15);
            elapsed += 15;
            pool.swapToTick(tick + 1);
            pool.swapToTick(tick);
        }
        vm.warp(block.timestamp + 1);
    }

    /// @dev Runs the market forward to `instant`, trading at `tick` along the way, then
    ///      lets anyone push the state machine — exactly what the keeper does.
    function _runTo(uint256 instant, int24 tick) internal {
        while (block.timestamp < instant + 20) {
            vm.warp(block.timestamp + 15);
            pool.swapToTick(tick + 1);
            pool.swapToTick(tick);
        }
        market.executeRound();
    }

    function _claim(address who, uint256 epoch) internal returns (uint256) {
        uint256[] memory e = new uint256[](1);
        e[0] = epoch;
        uint256 before = who.balance;
        vm.prank(who);
        market.claim(e);
        return who.balance - before;
    }

    /// @dev The brief's headline scenario, start to finish.
    function test_requiredScenario_threeBettorsOneRoundFullSettlement() public {
        Round memory r1 = market.getRound(1);

        // Alice UP 0.10, Bob DOWN 0.20, Charlie UP 0.05.
        vm.prank(alice);
        market.betBull{value: 0.1 ether}(1);
        vm.prank(bob);
        market.betBear{value: 0.2 ether}(1);
        vm.prank(charlie);
        market.betBull{value: 0.05 ether}(1);

        assertEq(market.getRound(1).totalAmount, 0.35 ether);
        assertEq(market.getRound(1).bullAmount, 0.15 ether);
        assertEq(market.getRound(1).bearAmount, 0.2 ether);

        // Lock. Round 2 opens; round 1 goes live.
        _runTo(r1.lockTimestamp, TICK_START);
        assertTrue(market.getRound(1).status == RoundStatus.Locked, "round 1 should be live");
        assertEq(market.currentEpoch(), 2, "round 2 should be open");
        uint256 lockPrice = market.getRound(1).lockPrice;
        assertGt(lockPrice, 0);

        // PONS appreciates: PONS is token1, so a *falling* tick is a *rising* price.
        _trade(TICK_START - 500, 200);

        // Settle. Round 3 opens, round 2 goes live.
        _runTo(r1.closeTimestamp, TICK_START - 500);
        Round memory settled = market.getRound(1);
        assertTrue(settled.status == RoundStatus.Settled);
        assertGt(settled.closePrice, lockPrice, "PONS should have finished higher");
        assertTrue(market.getRoundTerms(1).outcome == Outcome.Bull, "UP must win");

        console2.log("lock  price (wei WETH per PONS)", lockPrice);
        console2.log("close price (wei WETH per PONS)", settled.closePrice);

        // Payouts follow the parimutuel formula exactly.
        uint256 fee = (0.35 ether * 300) / 10_000;
        uint256 reward = 0.35 ether - fee;
        assertEq(settled.rewardAmount, reward);
        assertEq(market.treasuryAmount(), fee);
        assertEq(market.claimable(1, alice), (0.1 ether * reward) / 0.15 ether);
        assertEq(market.claimable(1, charlie), (0.05 ether * reward) / 0.15 ether);
        assertEq(market.claimable(1, bob), 0, "Bob must not be able to claim");

        assertEq(_claim(alice, 1), (0.1 ether * reward) / 0.15 ether);
        assertEq(_claim(charlie, 1), (0.05 ether * reward) / 0.15 ether);

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(bob);
        vm.expectRevert();
        market.claim(e);

        // Rolling structure holds: 2 is live, 3 is taking entries.
        assertTrue(market.getRound(2).status == RoundStatus.Locked, "round 2 should be live");
        assertTrue(market.getRound(3).status == RoundStatus.Open, "round 3 should be open");
        vm.prank(alice);
        market.betBull{value: 0.01 ether}(3);

        // A second settlement attempt cannot touch round 1.
        vm.expectRevert();
        market.settleRound(1);

        // Nor can an administrator.
        vm.prank(admin);
        vm.expectRevert();
        market.emergencyCancelRound(1);

        (uint256 balance, uint256 owed, bool solvent) = market.solvency();
        assertTrue(solvent);
        assertGe(balance, owed);
    }

    /// @dev The brief's critical failure scenario: the oracle goes dark, and everyone
    ///      gets their stake back without an administrator lifting a finger.
    function test_requiredScenario_oracleOutageEndsInPermissionlessRefunds() public {
        Round memory r1 = market.getRound(1);
        vm.prank(alice);
        market.betBull{value: 1 ether}(1);
        vm.prank(bob);
        market.betBear{value: 2 ether}(1);

        // Lock time passes with the pool completely idle, so nothing seals the instant.
        vm.warp(r1.lockTimestamp + 1);
        (bool ok, string memory reason) = oracle.canQuote(r1.lockTimestamp, TWAP);
        assertFalse(ok, "instant should be unsealed");
        assertEq(reason, "TARGET_NOT_SEALED");

        vm.expectRevert();
        market.lockRound(1);

        // The schedule still advances, so the product keeps running.
        market.executeRound();
        assertEq(market.currentEpoch(), 2);

        // Once the tolerance expires, any address at all may void the round.
        vm.warp(r1.lockTimestamp + 900 + 1);
        address nobody = makeAddr("nobody");
        vm.prank(nobody);
        market.cancelRound(1);
        assertTrue(market.getRound(1).status == RoundStatus.Cancelled);

        assertEq(_claim(alice, 1), 1 ether, "Alice must recover 100%");
        assertEq(_claim(bob, 1), 2 ether, "Bob must recover 100%");
        assertEq(market.treasuryAmount(), 0, "no fee on a cancelled round");
    }

    /// @dev A quiet pool delays only the *result*, never the schedule, and the price the
    ///      round eventually gets is the one it was always going to get.
    function test_aQuietPoolDelaysTheResultButNotTheProduct() public {
        Round memory r1 = market.getRound(1);
        vm.prank(alice);
        market.betBull{value: 1 ether}(1);
        vm.prank(bob);
        market.betBear{value: 1 ether}(1);

        vm.warp(r1.lockTimestamp + 400); // silent through lock time and beyond
        market.executeRound();
        assertEq(market.currentEpoch(), 2, "next round opened anyway");
        assertTrue(market.getRound(1).status == RoundStatus.Open);

        // A trade finally seals the instant; the price is the historical one.
        pool.swapToTick(TICK_START - 10);
        market.lockRound(1);
        (uint256 expected,) = oracle.getPriceAt(r1.lockTimestamp, TWAP);
        assertEq(market.getRound(1).lockPrice, expected);
        assertEq(market.getRoundTerms(1).lockedAt, block.timestamp, "lateness is recorded, not hidden");
    }

    /// @dev Forced ETH cannot corrupt the accounting; it can only make the contract
    ///      more solvent than it needs to be.
    function test_forcedEthDoesNotDisturbAccounting() public {
        vm.prank(alice);
        market.betBull{value: 1 ether}(1);
        uint256 liabilitiesBefore = market.totalLiabilities();

        vm.deal(address(this), 5 ether);
        new ForceFeeder{value: 5 ether}(payable(address(market)));

        assertEq(market.totalLiabilities(), liabilitiesBefore, "forced ETH was counted as a liability");
        assertGt(address(market).balance, market.totalLiabilities());
        (,, bool solvent) = market.solvency();
        assertTrue(solvent);
    }

    /// @dev Ten rounds back to back, each priced off the shared boundary instant.
    function test_manyConsecutiveRoundsStayConsistent() public {
        int24 tick = TICK_START;
        for (uint256 i = 0; i < 10; i++) {
            Round memory head = market.getRound(market.currentEpoch());
            tick = tick + int24(int256(i % 2 == 0 ? int256(-120) : int256(200)));
            _runTo(head.lockTimestamp, tick);
        }

        uint256 settledCount;
        for (uint256 e = 1; e <= market.currentEpoch(); e++) {
            Round memory r = market.getRound(e);
            if (r.status == RoundStatus.Settled) {
                settledCount++;
                // The shared boundary: this round's close is the next round's lock, and
                // both were priced from the same instant, so they must be identical.
                Round memory nxt = market.getRound(e + 1);
                if (nxt.lockPrice != 0) {
                    assertEq(r.closePrice, nxt.lockPrice, "boundary priced twice differently");
                }
            }
        }
        assertGt(settledCount, 5, "expected several rounds to have settled");
    }
}
