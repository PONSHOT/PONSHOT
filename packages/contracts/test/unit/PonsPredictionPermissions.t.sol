// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsPrediction} from "../../src/PonsPrediction.sol";
import {MockPredictionOracle} from "../../src/mocks/MockPredictionOracle.sol";
import {PredictionHarness} from "../utils/PredictionHarness.sol";

contract PonsPredictionPermissionsTest is PredictionHarness {
    function setUp() public {
        _deployMarket();
    }

    /*//////////////////////////////////////////////////////////////
                        WHAT THE KEEPER CANNOT DO
    //////////////////////////////////////////////////////////////*/

    /// @dev The compromise model from the brief. An attacker holding OPERATOR_ROLE gets
    ///      nothing beyond what an anonymous caller already has.
    function test_operatorRoleGrantsNoEconomicPower() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        // Deployed up front: `vm.expectRevert` would otherwise bind to this CREATE.
        address candidateOracle = address(new MockPredictionOracle());

        vm.startPrank(operator);
        vm.expectRevert();
        market.setBurner(operator);
        vm.expectRevert();
        market.proposeBurnFee(500);
        vm.expectRevert();
        market.proposeOracle(candidateOracle);
        vm.expectRevert();
        market.setMinimumBet(1);
        vm.expectRevert();
        market.setMaximumRoundPool(1);
        vm.expectRevert();
        market.pausePrediction();
        vm.expectRevert();
        market.emergencyCancelRound(1);
        vm.stopPrank();

        // And there is simply no function through which any caller supplies a price.
        assertEq(_round(1).lockPrice, 0);
    }

    /// @dev Lifecycle calls are permissionless *because* their result cannot depend on
    ///      who makes them. This pins that: a stranger's settlement is byte-identical.
    function test_anyoneCanDriveTheLifecycleWithTheSameResult() public {
        _bet(alice, 1, true, 3 ether);
        _bet(bob, 1, false, 7 ether);
        Round memory r1 = _round(1);

        uint256 snap = vm.snapshotState();

        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, P0);
        vm.prank(operator);
        market.lockRound(1);
        uint256 byOperator = _round(1).lockPrice;

        vm.revertToState(snap);
        vm.warp(r1.lockTimestamp);
        oracle.setPrice(r1.lockTimestamp, P0);
        vm.prank(dora); // a complete stranger
        market.lockRound(1);
        assertEq(_round(1).lockPrice, byOperator, "caller identity changed the price");
    }

    /*//////////////////////////////////////////////////////////////
                             CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    function test_feeIsCappedByTheContractItself() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.FeeTooHigh.selector, uint256(1001), uint256(1000)));
        market.proposeBurnFee(1001);
        assertEq(market.MAX_BURN_FEE_BPS(), 1000, "a contested round always pays back at least 90%");
    }

    function test_feeChangeIsTimelocked() public {
        vm.prank(admin);
        market.proposeBurnFee(400);
        (,, address po, uint256 or_) = market.pendingConfig();
        assertEq(po, address(0));
        assertEq(or_, 0);

        vm.prank(admin);
        vm.expectRevert();
        market.commitBurnFee();
        assertEq(market.burnFeeBps(), FEE_BPS, "fee changed before the delay elapsed");

        vm.warp(block.timestamp + market.CONFIG_TIMELOCK());
        vm.prank(admin);
        market.commitBurnFee();
        assertEq(market.burnFeeBps(), 400);
    }

    function test_oracleChangeIsTimelockedAndValidated() public {
        vm.prank(admin);
        vm.expectRevert();
        market.proposeOracle(address(0xdead)); // not an oracle: the probe call fails

        MockPredictionOracle next = new MockPredictionOracle();
        next.setVersion(7);
        vm.prank(admin);
        market.proposeOracle(address(next));
        vm.prank(admin);
        vm.expectRevert();
        market.commitOracle();

        vm.warp(block.timestamp + market.CONFIG_TIMELOCK());
        vm.prank(admin);
        market.commitOracle();
        assertEq(address(market.oracle()), address(next));
    }

    /// @dev The guarantee behind "a pool/oracle update applies only to future rounds":
    ///      an open round keeps the terms it was created with, on chain, provably.
    function test_configChangesCannotReachAnAlreadyOpenRound() public {
        _bet(alice, 1, true, 1 ether);
        RoundTerms memory before = _terms(1);
        assertEq(before.burnFeeBps, FEE_BPS);
        assertEq(before.oracle, address(oracle));
        assertEq(before.twapWindow, TWAP);

        MockPredictionOracle next = new MockPredictionOracle();
        next.setVersion(9);
        vm.startPrank(admin);
        market.proposeBurnFee(500);
        market.proposeOracle(address(next));
        market.setTwapWindow(600);
        vm.stopPrank();
        vm.warp(block.timestamp + market.CONFIG_TIMELOCK());
        vm.startPrank(admin);
        market.commitBurnFee();
        market.commitOracle();
        vm.stopPrank();

        RoundTerms memory afterT = _terms(1);
        assertEq(afterT.burnFeeBps, FEE_BPS, "open round's fee was rewritten");
        assertEq(afterT.oracle, address(oracle), "open round's oracle was swapped");
        assertEq(afterT.twapWindow, TWAP, "open round's window was changed");
    }

    /// @dev New rounds do pick the new terms up, and record which oracle version applied.
    function test_newRoundsAdoptTheNewTerms() public {
        MockPredictionOracle next = new MockPredictionOracle();
        next.setVersion(9);
        vm.prank(admin);
        market.proposeOracle(address(next));
        vm.warp(block.timestamp + market.CONFIG_TIMELOCK());
        vm.prank(admin);
        market.commitOracle();

        Round memory head = _round(1);
        vm.warp(head.lockTimestamp + 1);
        market.startNextRound();

        RoundTerms memory t2 = _terms(2);
        assertEq(t2.oracle, address(next));
        assertEq(t2.oracleVersion, 9, "round did not record which rules applied");
    }

    function test_intervalIsConfigurableWithinBounds() public {
        vm.startPrank(admin);
        vm.expectRevert();
        market.setInterval(59);
        vm.expectRevert();
        market.setInterval(uint32(1 days) + 1);
        market.setInterval(60);
        assertEq(market.interval(), 60);
        market.setInterval(3600);
        assertEq(market.interval(), 3600);
        vm.stopPrank();
    }

    /// @dev Changing the interval must not break the boundary invariant, or a round's
    ///      close and the next round's lock would drift apart and price two instants.
    function test_intervalChangePreservesTheBoundaryInvariant() public {
        Round memory head = _round(1);
        _advanceTo(head.lockTimestamp, P0);

        vm.prank(admin);
        market.setInterval(900); // 5m -> 15m mid-flight

        head = _round(2);
        _advanceTo(head.lockTimestamp, P0 + 1e9);
        head = _round(3);
        _advanceTo(head.lockTimestamp, P0 + 2e9);

        for (uint256 e = 1; e < market.currentEpoch(); e++) {
            assertEq(_round(e).closeTimestamp, _round(e + 1).lockTimestamp, "boundary broke on interval change");
        }
        assertEq(_round(4).closeTimestamp - _round(4).lockTimestamp, 900, "new interval did not take effect");
    }

    /// @dev The convenience helpers walk back over possibly-unresolved rounds, and that
    ///      window is `bufferSeconds / interval`. Left unbounded, a large tolerance on a
    ///      short interval makes `executeRound` and `pendingWork` loop thousands of times
    ///      and exceed block gas — bricking the keeper's path with one config call.
    function test_toleranceCannotExceedTheScanWindow() public {
        vm.startPrank(admin);
        // 7 days of tolerance on a 300s interval would need ~2019 rounds of scanning.
        vm.expectRevert(
            abi.encodeWithSelector(
                PonsPrediction.ToleranceExceedsScanWindow.selector, uint32(7 days), INTERVAL, uint256(64)
            )
        );
        market.setBufferSeconds(uint32(7 days));

        // Shortening the interval under a fixed tolerance is the same hazard from the
        // other direction: 4000s is fine over 300s rounds (16 to scan) but needs 69 over
        // 60s rounds, so the interval change is what gets rejected.
        market.setBufferSeconds(4000);
        vm.expectRevert(
            abi.encodeWithSelector(
                PonsPrediction.ToleranceExceedsScanWindow.selector, uint32(4000), uint32(60), uint256(64)
            )
        );
        market.setInterval(60);
        vm.stopPrank();
    }

    /// @dev And the loop stays bounded even at the widest configuration the checks allow,
    ///      so `executeRound` remains callable rather than becoming a gas bomb.
    function test_executeRoundStaysCheapAtTheWidestAllowedTolerance() public {
        // The widest the checks permit: bufferSeconds <= (MAX_SCAN_ROUNDS - 3) * interval,
        // i.e. 61 hours of tolerance on a 1-hour interval, scanning the full 64 rounds.
        vm.startPrank(admin);
        market.setInterval(3600);
        market.setBufferSeconds(61 * 3600);
        vm.stopPrank();

        Round memory head = _round(1);
        vm.warp(head.lockTimestamp + 1);
        uint256 gasBefore = gasleft();
        market.executeRound();
        uint256 used = gasBefore - gasleft();
        assertLt(used, 3_000_000, "executeRound must stay well inside a block");
    }

    function test_bufferSecondsHasAFloorAboveObservedSealLag() public {
        // 900s exceeds the worst seal lag measured on the live pool (888s), so a quiet
        // market cannot trigger spurious cancellations.
        assertEq(market.MIN_BUFFER_SECONDS(), 900);
        vm.prank(admin);
        vm.expectRevert();
        market.setBufferSeconds(899);
    }

    function test_betLimitsStayConsistent() public {
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.InvalidBetLimits.selector, MAX_BET + 1, MAX_BET));
        market.setMinimumBet(MAX_BET + 1);
        vm.expectRevert(abi.encodeWithSelector(PonsPrediction.InvalidBetLimits.selector, MIN_BET, MIN_BET - 1));
        market.setMaximumBet(MIN_BET - 1);
        market.setMaximumBet(0); // 0 disables the cap
        assertEq(market.maximumBet(), 0);
        vm.stopPrank();
        _bet(alice, 1, true, 500 ether);
        assertEq(_round(1).bullAmount, 500 ether);
    }

    function test_rolesAreSeparable() public {
        assertTrue(market.hasRole(market.OPERATOR_ROLE(), operator));
        assertFalse(market.hasRole(market.DEFAULT_ADMIN_ROLE(), operator));
        assertTrue(market.hasRole(market.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(market.hasRole(market.PAUSER_ROLE(), admin));
        assertTrue(market.hasRole(market.CONFIG_ROLE(), admin));

        // Admin can hand the operator role to a fresh keeper and revoke the old one.
        address keeper2 = makeAddr("keeper2");
        vm.startPrank(admin);
        market.grantRole(market.OPERATOR_ROLE(), keeper2);
        market.revokeRole(market.OPERATOR_ROLE(), operator);
        vm.stopPrank();
        assertTrue(market.hasRole(market.OPERATOR_ROLE(), keeper2));
        assertFalse(market.hasRole(market.OPERATOR_ROLE(), operator));
    }
}
