// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsPrediction} from "../../src/PonsPrediction.sol";
import {ReentrantClaimer, RejectingReceiver} from "../../src/mocks/Attackers.sol";
import {PredictionHarness} from "../utils/PredictionHarness.sol";

contract PonsPredictionSettlementTest is PredictionHarness {
    function setUp() public {
        _deployMarket();
    }

    /// @dev Runs round 1 to settlement with the given boundary prices.
    function _run(uint256 lockPrice, uint256 closePrice) internal {
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, lockPrice);
        market.lockRound(1);
        vm.warp(r1.closeTimestamp);
        oracle.setPrice(r1.closeTimestamp, closePrice);
        market.settleRound(1);
    }

    function _claim(address who, uint256 epoch) internal returns (uint256 received) {
        uint256[] memory e = new uint256[](1);
        e[0] = epoch;
        uint256 before = who.balance;
        vm.prank(who);
        market.claim(e);
        received = who.balance - before;
    }

    /*//////////////////////////////////////////////////////////////
                            PAYOUT MATHS
    //////////////////////////////////////////////////////////////*/

    /// @dev The brief's worked example, to the wei: UP 3, DOWN 7, 3% fee, UP wins.
    function test_matchesTheSpecifiedParimutuelExample() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        _run(P0, P0 + 1e9);

        Round memory r = _round(1);
        assertTrue(_terms(1).outcome == Outcome.Bull);
        assertEq(r.rewardBaseAmount, 3 ether, "winning pool");
        assertEq(r.rewardAmount, 9.7 ether, "10 ETH less a 3% fee");
        assertEq(market.treasuryAmount(), 0.3 ether);

        // Sole winner takes the whole distributable pool.
        assertEq(market.claimable(1, alice), 9.7 ether);
        assertEq(market.claimable(1, bob), 0);
        assertEq(_claim(alice, 1), 9.7 ether);
        _assertSolvent();
    }

    function test_bearWinsAndSplitsProportionally() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 6 ether);
        _bet(charlie, 1, false, 2 ether);
        _run(P0, P0 - 1e9);

        assertTrue(_terms(1).outcome == Outcome.Bear);
        uint256 total = 11 ether;
        uint256 fee = (total * FEE_BPS) / 10_000;
        uint256 reward = total - fee;
        assertEq(_claim(bob, 1), (6 ether * reward) / 8 ether);
        assertEq(_claim(charlie, 1), (2 ether * reward) / 8 ether);
        assertEq(market.claimable(1, alice), 0, "loser must get nothing");
        _assertSolvent();
    }

    /// @dev Distribution can never exceed what the round actually holds.
    function test_distributionNeverExceedsTheRoundPool() public {
        _bet(alice, 1, true, 1 ether);
        _bet(bob, 1, true, 0.3333 ether);
        _bet(charlie, 1, true, 0.001 ether);
        _bet(dora, 1, false, 2.7 ether);
        _run(P0, P0 + 1);

        uint256 paid = _claim(alice, 1) + _claim(bob, 1) + _claim(charlie, 1);
        Round memory r = _round(1);
        assertLe(paid, r.rewardAmount, "paid out more than the reward pool");
        assertGe(paid + 3, r.rewardAmount, "rounding dust should be at most a few wei");
        _assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////
                             EDGE CASES
    //////////////////////////////////////////////////////////////*/

    function test_tieRefundsEveryoneAndTakesNoFee() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        _run(P0, P0); // identical close price

        assertTrue(_terms(1).outcome == Outcome.Tie);
        assertEq(market.treasuryAmount(), 0, "no rake on a tie");
        assertEq(market.refundable(1, alice), 3 ether);
        assertEq(market.refundable(1, bob), 7 ether);
        assertEq(market.claimable(1, alice), 0);
        assertEq(_claim(alice, 1), 3 ether);
        assertEq(_claim(bob, 1), 7 ether);
        _assertSolvent();
    }

    /// @dev The brief's explicit requirement: a winning side with no participants must
    ///      not hand the losing pool to the treasury.
    function test_zeroWinningSideRefundsRatherThanEnrichingTheTreasury() public {
        _bet(bob, 1, false, 7 ether); // bears only
        _run(P0, P0 + 1e9); // bulls "win", but there are none

        assertTrue(_terms(1).outcome == Outcome.NoContest);
        assertEq(market.treasuryAmount(), 0, "treasury must not absorb the losing pool");
        assertEq(_claim(bob, 1), 7 ether, "stake returned in full");
        _assertSolvent();
    }

    /// @dev The mirror case: winners with no counterparty won nothing, so rake-free
    ///      refunds are the only outcome that does not charge them for being right.
    function test_zeroLosingSideRefundsWithoutCharging() public {
        _bet(alice, 1, true, 4 ether);
        _run(P0, P0 + 1e9); // bulls win, but nobody took the other side

        assertTrue(_terms(1).outcome == Outcome.NoContest);
        assertEq(market.treasuryAmount(), 0);
        assertEq(_claim(alice, 1), 4 ether, "no rake when nothing was won");
        _assertSolvent();
    }

    function test_emptyRoundSettlesCleanly() public {
        _run(P0, P0 + 1e9);
        Round memory r = _round(1);
        assertEq(r.totalAmount, 0);
        assertTrue(_terms(1).outcome == Outcome.NoContest);
        assertEq(market.treasuryAmount(), 0);
        assertTrue(r.status == RoundStatus.Settled);
    }

    /*//////////////////////////////////////////////////////////////
                                CLAIMS
    //////////////////////////////////////////////////////////////*/

    function test_doubleClaimIsRejected() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        _run(P0, P0 + 1e9);
        _claim(alice, 1);

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.AlreadyClaimed.selector, uint256(1), alice));
        market.claim(e);
    }

    function test_loserCannotClaim() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        _run(P0, P0 + 1e9);

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.NothingToClaim.selector, uint256(1), bob));
        market.claim(e);
    }

    function test_cannotClaimAnUnsettledRound() public {
        _bet(alice, 1, true, 3 ether);
        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.NothingToClaim.selector, uint256(1), alice));
        market.claim(e);
    }

    function test_cannotClaimARoundYouNeverEntered() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        _run(P0, P0 + 1e9);
        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(charlie);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.NothingToClaim.selector, uint256(1), charlie));
        market.claim(e);
    }

    function test_claimAllCollectsAcrossRounds() public {
        _bet(alice, 1, true, 1 ether);
        _bet(bob, 1, false, 1 ether);
        Round memory r1 = _round(1);
        _advanceTo(r1.lockTimestamp, P0);
        _bet(alice, 2, true, 1 ether);
        _bet(bob, 2, false, 1 ether);
        Round memory r2 = _round(2);
        _advanceTo(r2.lockTimestamp, P0 + 1e9); // settles 1 (bull wins), locks 2
        _advanceTo(r2.closeTimestamp, P0 + 2e9); // settles 2 (bull wins)

        uint256[] memory e = new uint256[](2);
        e[0] = 1;
        e[1] = 2;
        uint256 expected = market.claimable(1, alice) + market.claimable(2, alice);
        uint256 before = alice.balance;
        vm.prank(alice);
        market.claim(e);
        assertEq(alice.balance - before, expected);
        _assertSolvent();
    }

    /// @dev A duplicated epoch in one call must not pay twice.
    function test_duplicateEpochInOneClaimIsRejected() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        _run(P0, P0 + 1e9);
        uint256[] memory e = new uint256[](2);
        e[0] = 1;
        e[1] = 1;
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.AlreadyClaimed.selector, uint256(1), alice));
        market.claim(e);
    }

    function test_reentrantClaimGainsNothing() public {
        ReentrantClaimer attacker = new ReentrantClaimer(address(market));
        vm.deal(address(attacker), 10 ether);
        attacker.bet{value: 3 ether}(1, true);
        _bet(bob, 1, false, 7 ether);
        _run(P0, P0 + 1e9);

        uint256 owed = market.claimable(1, address(attacker));
        uint256 attackerBefore = address(attacker).balance;
        uint256 marketBefore = address(market).balance;

        attacker.arm();
        attacker.doClaim();

        assertGe(attacker.reentryAttempts(), 1, "the reentrant path was never exercised");
        assertEq(address(attacker).balance - attackerBefore, owed, "attacker drew more than it was owed");
        assertEq(marketBefore - address(market).balance, owed, "market paid out more than once");
        _assertSolvent();
    }

    /// @dev One participant that refuses ETH must not be able to hold up anybody else,
    ///      nor settlement, because payouts are pull-based.
    function test_aRecipientThatRejectsEthCannotBlockOthers() public {
        RejectingReceiver hostile = new RejectingReceiver(address(market));
        vm.deal(address(hostile), 10 ether);
        hostile.bet{value: 3 ether}(1, true);
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);

        _run(P0, P0 + 1e9); // settlement itself moves no ETH, so it cannot be blocked
        assertTrue(_round(1).status == RoundStatus.Settled);

        vm.expectRevert();
        hostile.doClaim(1);

        uint256 got = _claim(alice, 1);
        assertGt(got, 0, "an honest winner was blocked");
        _assertSolvent();
    }

    /*//////////////////////////////////////////////////////////////
                               TREASURY
    //////////////////////////////////////////////////////////////*/

    function test_treasuryAccrualAndWithdrawal() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        _run(P0, P0 + 1e9);
        assertEq(market.treasuryAmount(), 0.3 ether);

        vm.prank(admin);
        market.claimTreasury(0.1 ether);
        assertEq(treasuryWallet.balance, 0.1 ether);
        assertEq(market.treasuryAmount(), 0.2 ether);
        _assertSolvent();
    }

    /// @dev The treasury is bounded by booked fees, so it can never reach user money
    ///      even while user funds sit in the contract.
    function test_treasuryCannotOverdrawIntoUserFunds() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        _run(P0, P0 + 1e9);

        assertGt(address(market).balance, 9 ether, "user money is sitting here");
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.TreasuryOverdraw.selector, 1 ether, 0.3 ether));
        market.claimTreasury(1 ether);
    }

    function test_treasuryClaimIsAdminOnly() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        _run(P0, P0 + 1e9);
        vm.prank(operator);
        vm.expectRevert();
        market.claimTreasury(0.1 ether);
    }
}
