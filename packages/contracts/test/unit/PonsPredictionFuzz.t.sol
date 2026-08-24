// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PredictionHarness} from "../utils/PredictionHarness.sol";

contract PonsPredictionFuzzTest is PredictionHarness {
    function setUp() public {
        _deployMarket();
    }

    function _settle(uint256 lockPrice, uint256 closePrice) internal {
        Round memory r1 = _round(1);
        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, lockPrice);
        market.lockRound(1);
        vm.warp(r1.closeTimestamp);
        oracle.setPrice(r1.closeTimestamp, closePrice);
        market.settleRound(1);
    }

    function _claim(address who) internal returns (uint256) {
        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        uint256 before = who.balance;
        vm.prank(who);
        market.claim(e);
        return who.balance - before;
    }

    /// @dev The headline safety property: whatever the stakes, whatever the prices,
    ///      the contract never pays out more than the round took in.
    function testFuzz_payoutsNeverExceedTheRoundPool(
        uint96 aBull,
        uint96 bBull,
        uint96 cBear,
        uint96 dBear,
        uint256 lockPrice,
        uint256 closePrice
    ) public {
        aBull = uint96(bound(aBull, MIN_BET, 100 ether));
        bBull = uint96(bound(bBull, MIN_BET, 100 ether));
        cBear = uint96(bound(cBear, MIN_BET, 100 ether));
        dBear = uint96(bound(dBear, MIN_BET, 100 ether));
        lockPrice = bound(lockPrice, 1, type(uint128).max);
        closePrice = bound(closePrice, 1, type(uint128).max);

        _bet(alice, 1, true, aBull);
        _bet(bob, 1, true, bBull);
        _bet(charlie, 1, false, cBear);
        _bet(dora, 1, false, dBear);
        uint256 pool = uint256(aBull) + bBull + cBear + dBear;

        _settle(lockPrice, closePrice);

        uint256 paid;
        if (market.claimable(1, alice) + market.refundable(1, alice) > 0) paid += _claim(alice);
        if (market.claimable(1, bob) + market.refundable(1, bob) > 0) paid += _claim(bob);
        if (market.claimable(1, charlie) + market.refundable(1, charlie) > 0) paid += _claim(charlie);
        if (market.claimable(1, dora) + market.refundable(1, dora) > 0) paid += _claim(dora);

        assertLe(paid + market.burnAllocated(), pool, "distributed more than was staked");
        _assertSolvent();
    }

    /// @dev Whichever way the price moved, exactly one side may collect, and it is the
    ///      side the comparison names. Nothing here depends on the magnitude of the move.
    function testFuzz_onlyTheCorrectSideCanCollect(uint256 lockPrice, uint256 closePrice) public {
        lockPrice = bound(lockPrice, 1, type(uint128).max);
        closePrice = bound(closePrice, 1, type(uint128).max);

        _bet(alice, 1, true, 1 ether);
        _bet(bob, 1, false, 1 ether);
        _settle(lockPrice, closePrice);

        if (closePrice > lockPrice) {
            assertGt(market.claimable(1, alice), 0, "bull should have won");
            assertEq(market.claimable(1, bob), 0);
        } else if (closePrice < lockPrice) {
            assertGt(market.claimable(1, bob), 0, "bear should have won");
            assertEq(market.claimable(1, alice), 0);
        } else {
            assertEq(market.claimable(1, alice), 0);
            assertEq(market.claimable(1, bob), 0);
            assertEq(market.refundable(1, alice), 1 ether, "a tie refunds");
            assertEq(market.refundable(1, bob), 1 ether);
        }
    }

    function testFuzz_feeIsExactlyTheConfiguredShare(uint16 bps, uint96 bull, uint96 bear) public {
        bps = uint16(bound(bps, 0, uint16(market.MAX_BURN_FEE_BPS())));
        bull = uint96(bound(bull, MIN_BET, 100 ether));
        bear = uint96(bound(bear, MIN_BET, 100 ether));

        vm.prank(admin);
        market.proposeBurnFee(bps);
        vm.warp(block.timestamp + market.CONFIG_TIMELOCK());
        vm.prank(admin);
        market.commitBurnFee();

        // A round created *after* the change picks the new fee up.
        Round memory head = _round(1);
        vm.warp(head.lockTimestamp + 1);
        market.startNextRound();
        Round memory r2 = _round(2);
        vm.warp(r2.startTimestamp > block.timestamp ? r2.startTimestamp : block.timestamp);

        _bet(alice, 2, true, bull);
        _bet(bob, 2, false, bear);
        vm.warp(r2.lockTimestamp);
        oracle.setPrice(r2.lockTimestamp, P0);
        market.lockRound(2);
        vm.warp(r2.closeTimestamp);
        oracle.setPrice(r2.closeTimestamp, P0 + 1);
        market.settleRound(2);

        uint256 pool = uint256(bull) + bear;
        assertEq(market.burnAllocated(), (pool * bps) / 10_000, "fee is not the configured share");
        assertEq(_round(2).rewardAmount, pool - (pool * bps) / 10_000);
    }

    /// @dev No sequence of stakes may let a claimant draw twice.
    function testFuzz_noDoubleClaimAcrossAnyStakeMix(uint96 bull, uint96 bear, bool bullWins) public {
        bull = uint96(bound(bull, MIN_BET, 100 ether));
        bear = uint96(bound(bear, MIN_BET, 100 ether));
        _bet(alice, 1, true, bull);
        _bet(bob, 1, false, bear);
        _settle(P0, bullWins ? P0 + 1 : P0 - 1);

        address winner = bullWins ? alice : bob;
        uint256 first = _claim(winner);
        assertGt(first, 0);

        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(winner);
        vm.expectRevert();
        market.claim(e);
        _assertSolvent();
    }

    /// @dev Larger stake on the winning side always means a larger payout, never less.
    function testFuzz_payoutIsMonotonicInStake(uint96 small, uint96 large, uint96 bear) public {
        small = uint96(bound(small, MIN_BET, 50 ether));
        large = uint96(bound(large, small, 100 ether));
        bear = uint96(bound(bear, MIN_BET, 100 ether));

        _bet(alice, 1, true, small);
        _bet(bob, 1, true, large);
        _bet(charlie, 1, false, bear);
        _settle(P0, P0 + 1);

        assertGe(market.claimable(1, bob), market.claimable(1, alice), "bigger stake paid less");
    }

    function testFuzz_scheduleStaysConsistentUnderArbitraryDelays(uint32[8] memory delays) public {
        for (uint256 i = 0; i < delays.length; i++) {
            uint256 d = bound(delays[i], 1, 5000);
            Round memory head = _round(market.currentEpoch());
            vm.warp(head.lockTimestamp + d);
            oracle.setPrice(head.lockTimestamp, P0 + i * 1e9);
            market.executeRound();
        }
        for (uint256 e = 1; e < market.currentEpoch(); e++) {
            assertEq(_round(e).closeTimestamp, _round(e + 1).lockTimestamp, "boundary drifted");
            assertEq(_round(e + 1).closeTimestamp - _round(e + 1).lockTimestamp, INTERVAL, "interval drifted");
        }
    }
}
