// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsPrediction} from "../../src/PonsPrediction.sol";
import {PredictionHarness} from "../utils/PredictionHarness.sol";

/// @notice Oracle failure, cancellation and refunds — the brief's "critical failure scenario".
contract PonsPredictionFailureTest is PredictionHarness {
    function setUp() public {
        _deployMarket();
    }

    function _claim(address who, uint256 epoch) internal returns (uint256) {
        uint256[] memory e = new uint256[](1);
        e[0] = epoch;
        uint256 before = who.balance;
        vm.prank(who);
        market.claim(e);
        return who.balance - before;
    }

    /// @dev The brief's Round #600 scenario, end to end.
    function test_unavailableOracleLeadsToCancellationAndFullRefunds() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        Round memory r1 = _round(1);

        // Lock time arrives; the oracle can produce nothing.
        vm.warp(r1.lockTimestamp + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                PonsPrediction.PriceUnavailable.selector, uint256(1), r1.lockTimestamp, "TARGET_NOT_SEALED"
            )
        );
        market.lockRound(1);

        // Not cancellable yet: the tolerance is there so a quiet market is not punished.
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.RoundNotCancellable.selector, uint256(1)));
        market.cancelRound(1);

        // Past the tolerance, anyone at all may void it.
        vm.warp(r1.lockTimestamp + BUFFER + 1);
        vm.prank(dora); // not a role holder, not a participant
        market.cancelRound(1);
        assertTrue(_round(1).status == RoundStatus.Cancelled);

        // Everyone recovers 100%, and no fee was taken.
        assertEq(market.refundable(1, alice), 3 ether);
        assertEq(market.refundable(1, bob), 7 ether);
        assertEq(_claim(alice, 1), 3 ether);
        assertEq(_claim(bob, 1), 7 ether);
        assertEq(market.treasuryAmount(), 0, "a cancelled round must never be charged");
        assertEq(market.totalLiabilities(), 0);
        _assertSolvent();
    }

    function test_cancellationAlsoAppliesAfterLockWhenCloseIsUnavailable() public {
        _bet(alice, 1, true, 1 ether);
        _bet(bob, 1, false, 1 ether);
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, P0);
        market.lockRound(1);

        vm.warp(r1.closeTimestamp + BUFFER + 1); // close price never becomes available
        market.cancelRound(1);
        assertTrue(_round(1).status == RoundStatus.Cancelled);
        assertEq(_claim(alice, 1), 1 ether);
        assertEq(_claim(bob, 1), 1 ether);
        _assertSolvent();
    }

    /// @dev A price that turns up during the grace period must settle the round
    ///      normally; lateness alone is never grounds for voiding money.
    function test_aLatePriceStillSettlesRatherThanCancelling() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        Round memory r1 = _round(1);

        vm.warp(r1.lockTimestamp + BUFFER + 5000);
        oracle.setPrice(r1.lockTimestamp, P0);
        oracle.setPrice(r1.closeTimestamp, P0 + 1e9);

        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.RoundNotCancellable.selector, uint256(1)));
        market.cancelRound(1);

        market.lockRound(1);
        market.settleRound(1);
        assertTrue(_terms(1).outcome == Outcome.Bull);
        assertEq(_round(1).lockPrice, P0, "used the scheduled instant despite the delay");
    }

    /// @dev A reverting oracle must degrade the round to refundable, never brick the market.
    function test_aRevertingOracleCannotBrickTheMarket() public {
        _bet(alice, 1, true, 1 ether);
        Round memory r1 = _round(1);
        oracle.setRevertEverything(true);

        vm.warp(r1.lockTimestamp + 1);
        // executeRound must survive an oracle that throws on every call.
        market.executeRound();
        assertEq(market.currentEpoch(), 2, "the schedule kept moving");

        vm.warp(r1.lockTimestamp + BUFFER + 1);
        market.cancelRound(1);
        assertEq(_claim(alice, 1), 1 ether);
        _assertSolvent();
    }

    function test_anOracleThatRevertsInCanQuoteIsTreatedAsUnavailable() public {
        _bet(alice, 1, true, 1 ether);
        Round memory r1 = _round(1);
        oracle.setRevertOnCanQuote(true);
        vm.warp(r1.lockTimestamp + BUFFER + 1);
        assertTrue(market.phaseOf(1) == Phase.Cancellable);
        market.cancelRound(1);
        assertEq(_claim(alice, 1), 1 ether);
    }

    /// @dev A zero price is nonsense as a settlement figure and must be refused.
    function test_azeroPriceIsRejected() public {
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, 0);
        vm.expectRevert();
        market.lockRound(1);
    }

    /// @dev The round's `oracleVersion` is provenance metadata, not a settlement input, so
    ///      a misbehaving oracle must not be able to halt the schedule through it. Before
    ///      this was guarded, an unguarded read reverted `executeRound` wholesale and threw
    ///      away the lock and settle work already done in the same transaction.
    function test_aRevertingOracleStillLetsTheScheduleAdvance() public {
        _bet(alice, 1, true, 1 ether);
        _bet(bob, 1, false, 1 ether);
        Round memory r1 = _round(1);

        // Price round 1 normally, then break the oracle completely.
        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, P0);
        market.lockRound(1);
        vm.warp(r1.closeTimestamp);
        oracle.setPrice(r1.closeTimestamp, P0 + 1e9);
        oracle.setRevertEverything(true);

        // executeRound must still create the next round rather than reverting entirely.
        market.executeRound();
        assertEq(market.currentEpoch(), 2, "schedule stalled on a metadata read");
        assertEq(_terms(2).oracleVersion, 0, "unavailable version should record 0");

        // And with the oracle restored, the settled round pays out as normal.
        oracle.setRevertEverything(false);
        market.settleRound(1);
        assertTrue(_terms(1).outcome == Outcome.Bull);
        assertEq(_claim(alice, 1), _round(1).rewardAmount);
        _assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////
                          EMERGENCY POWERS
    //////////////////////////////////////////////////////////////*/

    /// @dev The decisive limit on admin power: a round whose result is already
    ///      determined cannot be voided, so no role can undo an outcome it dislikes.
    function test_adminCannotVoidARoundThatCanBeSettled() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, P0);
        market.lockRound(1);
        vm.warp(r1.closeTimestamp);
        oracle.setPrice(r1.closeTimestamp, P0 + 1e9); // bulls are winning

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.RoundNotCancellable.selector, uint256(1)));
        market.emergencyCancelRound(1);

        market.settleRound(1);
        assertTrue(_terms(1).outcome == Outcome.Bull, "outcome stands");
    }

    function test_adminCannotVoidASettledRound() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, P0);
        market.lockRound(1);
        vm.warp(r1.closeTimestamp);
        oracle.setPrice(r1.closeTimestamp, P0 + 1e9);
        market.settleRound(1);

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.RoundNotCancellable.selector, uint256(1)));
        market.emergencyCancelRound(1);
    }

    /// @dev What emergency power does exist: voiding a round nobody can have won yet.
    function test_adminMayVoidARoundStillTakingEntries() public {
        _bet(alice, 1, true, 3 ether);
        vm.prank(admin);
        market.emergencyCancelRound(1);
        assertTrue(_round(1).status == RoundStatus.Cancelled);
        assertEq(_claim(alice, 1), 3 ether);
        _assertSolvent();
    }

    function test_adminMayVoidAStuckRoundWithoutWaitingForTheBuffer() public {
        _bet(alice, 1, true, 1 ether);
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp + 1); // stuck, but well inside the tolerance
        vm.prank(admin);
        market.emergencyCancelRound(1);
        assertEq(_claim(alice, 1), 1 ether);
    }

    function test_emergencyCancelIsRoleGated() public {
        vm.prank(dora);
        vm.expectRevert();
        market.emergencyCancelRound(1);
    }
}
