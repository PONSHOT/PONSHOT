// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsPrediction} from "../../src/PonsPrediction.sol";
import {PredictionHarness} from "../utils/PredictionHarness.sol";

contract PonsPredictionBettingTest is PredictionHarness {
    function setUp() public {
        _deployMarket();
    }

    function test_entriesAccumulatePerSide() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        Round memory r = _round(1);
        assertEq(r.bullAmount, 3 ether);
        assertEq(r.bearAmount, 7 ether);
        assertEq(r.totalAmount, 10 ether);
        assertEq(r.bullAmount + r.bearAmount, r.totalAmount, "sides must sum to total");
        assertEq(market.totalLiabilities(), 10 ether);
        _assertSolvent();
    }

    function test_oneEntryPerWalletPerRound() public {
        _bet(alice, 1, true, 1 ether);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.AlreadyEntered.selector, uint256(1), alice));
        market.betBear{value: 1 ether}(1);

        // Not even on the same side.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.AlreadyEntered.selector, uint256(1), alice));
        market.betBull{value: 1 ether}(1);

        // A different round is fine.
        Round memory r1 = _round(1);
        _advanceTo(r1.lockTimestamp, P0);
        _bet(alice, 2, false, 1 ether);
        assertEq(market.getBet(2, alice).amount, 1 ether);
    }

    function test_rejectsStakeBelowMinimum() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.StakeBelowMinimum.selector, MIN_BET - 1, MIN_BET));
        market.betBull{value: MIN_BET - 1}(1);
    }

    function test_rejectsStakeAboveMaximum() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.StakeAboveMaximum.selector, MAX_BET + 1, MAX_BET));
        market.betBull{value: MAX_BET + 1}(1);
    }

    function test_enforcesMaximumRoundPool() public {
        vm.prank(admin);
        market.setMaximumRoundPool(5 ether);
        _bet(alice, 1, true, 4 ether);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.RoundPoolExceeded.selector, 6 ether, 5 ether));
        market.betBear{value: 2 ether}(1);
        // Exactly at the cap is allowed.
        _bet(bob, 1, false, 1 ether);
        assertEq(_round(1).totalAmount, 5 ether);
    }

    /// @dev Entries stop on the clock, not when a keeper gets around to locking.
    function test_rejectsEntryOnceLockTimeHasPassedEvenIfUnlocked() public {
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp);
        assertTrue(_round(1).status == RoundStatus.Open, "still nominally open");
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.EntriesClosed.selector, uint256(1)));
        market.betBull{value: 1 ether}(1);
    }

    function test_rejectsEntryOnLockedAndSettledAndUnknownRounds() public {
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, P0);
        market.lockRound(1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.RoundNotOpen.selector, uint256(1)));
        market.betBull{value: 1 ether}(1);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.RoundNotFound.selector, uint256(99)));
        market.betBull{value: 1 ether}(99);
    }

    function test_pauseStopsEntriesButNotClaimsOrSettlement() public {
        _bet(alice, 1, true, 1 ether);
        _bet(bob, 1, false, 1 ether);
        Round memory r1 = _round(1);

        vm.prank(admin);
        market.pausePrediction();

        vm.prank(charlie);
        vm.expectRevert();
        market.betBull{value: 1 ether}(1);

        // Settlement and claiming keep working while paused.
        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, P0);
        market.lockRound(1);
        vm.warp(r1.closeTimestamp);
        oracle.setPrice(r1.closeTimestamp, P0 + 1e9);
        market.settleRound(1);

        uint256 owed = market.claimable(1, alice);
        assertGt(owed, 0);
        uint256 before = alice.balance;
        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        market.claim(e);
        assertEq(alice.balance, before + owed);
        _assertSolvent();
    }

    function test_directEthTransfersAreRejected() public {
        vm.prank(alice);
        (bool ok,) = address(market).call{value: 1 ether}("");
        assertFalse(ok, "market accepted untracked ETH");
    }

    function test_userEpochsArePaginated() public {
        _bet(alice, 1, true, 1 ether);
        Round memory head = _round(1);
        _advanceTo(head.lockTimestamp, P0);
        _bet(alice, 2, false, 1 ether);
        head = _round(2);
        _advanceTo(head.lockTimestamp, P0 + 1e9);
        _bet(alice, 3, true, 1 ether);

        (uint256[] memory page, uint256 total) = market.getUserEpochs(alice, 0, 2);
        assertEq(total, 3);
        assertEq(page.length, 2);
        assertEq(page[0], 1);
        assertEq(page[1], 2);

        (page, total) = market.getUserEpochs(alice, 2, 10);
        assertEq(page.length, 1);
        assertEq(page[0], 3);

        (page,) = market.getUserEpochs(alice, 99, 10);
        assertEq(page.length, 0);
    }
}
