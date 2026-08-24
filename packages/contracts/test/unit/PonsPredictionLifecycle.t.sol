// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsPrediction} from "../../src/PonsPrediction.sol";
import {PredictionHarness} from "../utils/PredictionHarness.sol";

/// @notice Round creation, scheduling and the state machine's legal transitions.
contract PonsPredictionLifecycleTest is PredictionHarness {
    function setUp() public {
        _deployMarket();
    }

    function test_genesisCreatesOneOpenRound() public view {
        assertEq(market.currentEpoch(), 1);
        Round memory r = _round(1);
        assertEq(r.epoch, 1);
        assertEq(r.startTimestamp, block.timestamp);
        assertEq(r.lockTimestamp, block.timestamp + INTERVAL);
        assertEq(r.closeTimestamp, block.timestamp + 2 * uint256(INTERVAL));
        assertTrue(r.status == RoundStatus.Open);
    }

    function test_genesisIsOperatorGatedAndSingleShot() public {
        vm.expectRevert();
        market.genesisStartRound();

        vm.prank(operator);
        vm.expectRevert(PonsPrediction.AlreadyStarted.selector);
        market.genesisStartRound();
    }

    /// @dev The scheduling invariant every price reading depends on: consecutive rounds
    ///      share a boundary instant, so one oracle reading serves both and no stretch of
    ///      time goes unmeasured.
    function test_closeOfOneRoundIsLockOfTheNext() public {
        for (uint256 i = 0; i < 6; i++) {
            Round memory head = _round(market.currentEpoch());
            _advanceTo(head.lockTimestamp, P0 + i * 1e9);
        }
        for (uint256 e = 1; e < market.currentEpoch(); e++) {
            assertEq(_round(e).closeTimestamp, _round(e + 1).lockTimestamp, "boundary mismatch");
            assertEq(_round(e).lockTimestamp, _round(e + 1).startTimestamp, "overlap mismatch");
        }
    }

    /// @dev A keeper that shows up late must not shift the schedule; the times come from
    ///      stored values, never from the executing block.
    function test_lateExecutionDoesNotDriftTheSchedule() public {
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp + 4000); // very late
        oracle.setPrice(r1.lockTimestamp, P0);
        market.executeRound();

        Round memory r2 = _round(2);
        assertEq(r2.startTimestamp, r1.lockTimestamp, "start drifted");
        assertEq(r2.lockTimestamp, r1.closeTimestamp, "lock drifted");
        assertEq(r2.closeTimestamp, r1.closeTimestamp + INTERVAL, "close drifted");
    }

    function test_rollingWindowKeepsPreviousLiveAndNextPopulated() public {
        Round memory head = _round(1);
        _advanceTo(head.lockTimestamp, P0);
        head = _round(2);
        _advanceTo(head.lockTimestamp, P0 + 1e9);
        head = _round(3);
        _advanceTo(head.lockTimestamp, P0 + 2e9);

        (Round memory prev, Round memory live, Round memory next) = market.getVisibleRounds();
        assertEq(prev.epoch, market.currentEpoch() - 2);
        assertEq(live.epoch, market.currentEpoch() - 1);
        assertEq(next.epoch, market.currentEpoch());
        assertTrue(prev.status == RoundStatus.Settled, "previous should be settled");
        assertTrue(live.status == RoundStatus.Locked, "live should be locked");
        assertTrue(next.status == RoundStatus.Open, "next should be open");
    }

    function test_phaseTracksTheRealSituation() public {
        assertTrue(market.phaseOf(1) == Phase.Open);
        Round memory r1 = _round(1);

        vm.warp(r1.lockTimestamp);
        assertTrue(market.phaseOf(1) == Phase.AwaitingLock, "entries closed but unpriced");

        oracle.setPrice(r1.lockTimestamp, P0);
        market.lockRound(1);
        assertTrue(market.phaseOf(1) == Phase.Live);

        vm.warp(r1.closeTimestamp);
        assertTrue(market.phaseOf(1) == Phase.AwaitingSettle);

        vm.warp(r1.closeTimestamp + BUFFER + 1);
        assertTrue(market.phaseOf(1) == Phase.Cancellable, "stuck past tolerance");

        oracle.setPrice(r1.closeTimestamp, P0 + 1);
        assertTrue(market.phaseOf(1) == Phase.AwaitingSettle, "price arrived, no longer stuck");
        market.settleRound(1);
        assertTrue(market.phaseOf(1) == Phase.Settled);
    }

    /*//////////////////////////////////////////////////////////////
                     ILLEGAL TRANSITIONS
    //////////////////////////////////////////////////////////////*/

    function test_cannotLockBeforeLockTime() public {
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.NotYetLockable.selector, uint256(1)));
        market.lockRound(1);
    }

    function test_cannotLockTwice() public {
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, P0);
        market.lockRound(1);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.RoundNotOpen.selector, uint256(1)));
        market.lockRound(1);
    }

    function test_cannotSettleBeforeLocking() public {
        Round memory r1 = _round(1);
        vm.warp(r1.closeTimestamp);
        oracle.setPrice(r1.closeTimestamp, P0);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.NotYetSettleable.selector, uint256(1)));
        market.settleRound(1);
    }

    function test_cannotSettleTwice() public {
        _settleRoundOne(P0, P0 + 5e9);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.NotYetSettleable.selector, uint256(1)));
        market.settleRound(1);
    }

    /// @dev A settled round is frozen: no later call of any kind may touch its numbers.
    function test_settledRoundIsImmutable() public {
        _bet(alice, 1, true, 1 ether);
        _bet(bob, 1, false, 2 ether);
        _settleRoundOne(P0, P0 + 5e9);
        Round memory before = _round(1);
        RoundTerms memory tBefore = _terms(1);

        // Change everything a privileged party could change, then re-read.
        vm.startPrank(admin);
        market.setInterval(600);
        market.setMaximumRoundPool(1);
        market.proposeBurnFee(500);
        vm.stopPrank();
        vm.warp(block.timestamp + 3 days);
        vm.prank(admin);
        market.commitBurnFee();
        oracle.setPrice(_round(1).closeTimestamp, 1); // rewrite the oracle's answer

        Round memory afterR = _round(1);
        assertEq(afterR.lockPrice, before.lockPrice);
        assertEq(afterR.closePrice, before.closePrice);
        assertEq(afterR.rewardAmount, before.rewardAmount);
        assertEq(afterR.rewardBaseAmount, before.rewardBaseAmount);
        assertTrue(_terms(1).outcome == tBefore.outcome);
        assertEq(_terms(1).burnFeeBps, FEE_BPS, "settled round kept its own fee");
    }

    function test_epochNeverMovesBackwards() public {
        uint256 last;
        for (uint256 i = 0; i < 8; i++) {
            Round memory head = _round(market.currentEpoch());
            _advanceTo(head.lockTimestamp, P0 + i * 1e9);
            assertGe(market.currentEpoch(), last);
            last = market.currentEpoch();
        }
    }

    /// @dev `executeRound` is a convenience, so a call with nothing to do must be a
    ///      no-op rather than a revert; otherwise every quiet keeper tick looks like a fault.
    function test_executeRoundIsANoOpWhenNothingIsDue() public {
        (bool l, bool s, bool st) = market.executeRound();
        assertFalse(l);
        assertFalse(s);
        assertFalse(st);
        assertEq(market.currentEpoch(), 1);
    }

    function test_pendingWorkReportsWhatIsActionable() public {
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp);
        (uint256[] memory lockable,,, bool canStart) = market.pendingWork();
        assertEq(lockable.length, 0, "no price yet, so nothing is lockable");
        assertTrue(canStart, "next round is due regardless of price");

        oracle.setPrice(r1.lockTimestamp, P0);
        (lockable,,,) = market.pendingWork();
        assertEq(lockable.length, 1);
        assertEq(lockable[0], 1);
    }

    /// @dev Round progression must not wait on the oracle, or one quiet stretch of the
    ///      pool would stall the whole product.
    function test_nextRoundOpensEvenWhenThePriceIsUnavailable() public {
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp + 1); // no price published at all
        market.executeRound();

        assertEq(market.currentEpoch(), 2, "next round did not open");
        assertTrue(_round(1).status == RoundStatus.Open, "round 1 still unpriced");
        assertTrue(market.phaseOf(1) == Phase.AwaitingLock);

        // And round 2 takes entries normally while round 1 is still unresolved.
        _bet(alice, 2, true, 1 ether);
        assertEq(_round(2).bullAmount, 1 ether);
    }

    /// @dev A price that arrives late produces exactly the value it always would have.
    function test_lateLockUsesTheScheduledInstantNotTheExecutionTime() public {
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp + 5000);
        oracle.setPrice(r1.lockTimestamp, P0);
        oracle.setPrice(block.timestamp, 999); // a different, tempting "now" price
        market.lockRound(1);
        assertEq(_round(1).lockPrice, P0, "settled on execution-time price");
        assertEq(_terms(1).lockedAt, block.timestamp, "execution time still recorded");
    }

    function _settleRoundOne(uint256 lockPrice, uint256 closePrice) internal {
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, lockPrice);
        market.lockRound(1);
        vm.warp(r1.closeTimestamp);
        oracle.setPrice(r1.closeTimestamp, closePrice);
        market.settleRound(1);
    }
}
