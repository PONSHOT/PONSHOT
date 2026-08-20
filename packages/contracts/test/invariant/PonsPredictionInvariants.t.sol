// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsPrediction} from "../../src/PonsPrediction.sol";
import {IPonsPredictionTypes} from "../../src/interfaces/IPonsPrediction.sol";
import {MockPredictionOracle} from "../../src/mocks/MockPredictionOracle.sol";
import {PredictionHandler} from "./PredictionHandler.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Properties that must hold no matter what order anything happens in.
contract PonsPredictionInvariantsTest is Test, IPonsPredictionTypes {
    PonsPrediction internal market;
    MockPredictionOracle internal oracle;
    PredictionHandler internal handler;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal burnerWallet = makeAddr("burner");
    address[5] internal actors;

    function setUp() public {
        vm.warp(1_700_000_000);
        oracle = new MockPredictionOracle();
        market = new PonsPrediction(
            PonsPrediction.InitParams({
                admin: admin,
                operator: operator,
                burner: burnerWallet,
                oracle: address(oracle),
                interval: 300,
                twapWindow: 60,
                bufferSeconds: 900,
                burnFeeBps: 300,
                minimumBet: 0.001 ether,
                maximumBet: 50 ether,
                maximumRoundPool: 500 ether
            })
        );
        vm.prank(operator);
        market.genesisStartRound();

        for (uint256 i = 0; i < 5; i++) {
            actors[i] = makeAddr(string(abi.encodePacked("actor", i)));
            vm.deal(actors[i], 5000 ether);
        }
        handler = new PredictionHandler(market, oracle, actors, admin);
        targetContract(address(handler));
    }

    /// @dev The solvency property, and the reason payouts are pull-based: the contract
    ///      can always cover everything it has promised.
    function invariant_contractCanAlwaysCoverWhatItOwes() public view {
        (uint256 balance, uint256 owed, bool solvent) = market.solvency();
        assertTrue(solvent, "contract cannot cover its liabilities");
        assertGe(balance, owed);
    }

    /// @dev Independent double-entry check against the handler's own tally.
    function invariant_ethInEqualsEthOutPlusWhatIsStillHeld() public view {
        assertEq(
            address(market).balance + handler.totalPaidOut() + handler.totalFeesWithdrawn(),
            handler.totalStaked(),
            "ETH appeared or vanished"
        );
    }

    function invariant_sidesAlwaysSumToTheTotal() public view {
        for (uint256 e = 1; e <= market.currentEpoch(); e++) {
            Round memory r = market.getRound(e);
            assertEq(r.bullAmount + r.bearAmount, r.totalAmount, "sides do not sum to total");
        }
    }

    /// @dev A settled round may never promise more than it holds.
    function invariant_rewardNeverExceedsTheRoundPool() public view {
        for (uint256 e = 1; e <= market.currentEpoch(); e++) {
            Round memory r = market.getRound(e);
            if (r.status != RoundStatus.Settled) continue;
            assertLe(r.rewardAmount, r.totalAmount, "reward exceeds the pool");
            if (r.rewardBaseAmount != 0) {
                assertLe(r.rewardBaseAmount, r.totalAmount, "winning pool exceeds the pool");
            }
        }
    }

    function invariant_scheduleBoundariesLineUp() public view {
        for (uint256 e = 1; e < market.currentEpoch(); e++) {
            Round memory r = market.getRound(e);
            Round memory n = market.getRound(e + 1);
            assertEq(r.closeTimestamp, n.lockTimestamp, "close/lock boundary broke");
            assertEq(r.lockTimestamp, n.startTimestamp, "overlap broke");
            assertLt(r.startTimestamp, r.lockTimestamp, "round has no entry window");
            assertLt(r.lockTimestamp, r.closeTimestamp, "round has no live window");
        }
    }

    /// @dev The epoch counter only ever climbs, and every epoch below it exists.
    function invariant_everyEpochUpToTheHeadExists() public view {
        uint256 head = market.currentEpoch();
        assertGt(head, 0);
        for (uint256 e = 1; e <= head; e++) {
            assertTrue(market.getRound(e).status != RoundStatus.Pending, "gap in the epoch sequence");
        }
        assertTrue(market.getRound(head + 1).status == RoundStatus.Pending, "a round exists beyond the head");
    }

    /// @dev A settled or cancelled round never reverts to an earlier state, and a priced
    ///      round always carries the price its state implies.
    function invariant_terminalStatesAreConsistent() public view {
        for (uint256 e = 1; e <= market.currentEpoch(); e++) {
            Round memory r = market.getRound(e);
            RoundTerms memory t = market.getRoundTerms(e);
            if (r.status == RoundStatus.Locked || r.status == RoundStatus.Settled) {
                assertGt(r.lockPrice, 0, "locked without a lock price");
            }
            if (r.status == RoundStatus.Settled) {
                assertGt(r.closePrice, 0, "settled without a close price");
                assertTrue(t.outcome != Outcome.Undecided, "settled without an outcome");
                // The outcome must be exactly what the prices and the two pools imply.
                if (r.totalAmount == 0) {
                    assertTrue(t.outcome == Outcome.NoContest, "empty round was not a no-contest");
                } else if (r.closePrice == r.lockPrice) {
                    assertTrue(t.outcome == Outcome.Tie, "equal prices must be a tie");
                } else {
                    bool bullWins = r.closePrice > r.lockPrice;
                    uint256 winning = bullWins ? r.bullAmount : r.bearAmount;
                    uint256 losing = bullWins ? r.bearAmount : r.bullAmount;
                    if (winning == 0) {
                        assertTrue(t.outcome == Outcome.AllLost, "every entry lost, but not AllLost");
                    } else if (losing == 0) {
                        assertTrue(t.outcome == Outcome.NoContest, "nothing was won, but not a no-contest");
                    } else {
                        assertTrue(
                            t.outcome == (bullWins ? Outcome.Bull : Outcome.Bear), "outcome contradicts the prices"
                        );
                    }
                }
            } else {
                assertTrue(t.outcome == Outcome.Undecided, "unsettled round carries an outcome");
            }
        }
    }

    /// @dev Refund-shaped resolutions must never have been charged a fee.
    function invariant_noFeeIsTakenFromRefundedRounds() public view {
        for (uint256 e = 1; e <= market.currentEpoch(); e++) {
            Round memory r = market.getRound(e);
            RoundTerms memory t = market.getRoundTerms(e);
            bool refundShaped = r.status == RoundStatus.Cancelled
                || (r.status == RoundStatus.Settled && (t.outcome == Outcome.Tie || t.outcome == Outcome.NoContest));
            if (refundShaped) {
                assertEq(r.rewardAmount, 0, "a refunded round booked a reward");
                assertEq(r.rewardBaseAmount, 0, "a refunded round booked a winning pool");
            }
        }
    }

    /// @dev Every actor holds at most one position per epoch, forever.
    function invariant_atMostOnePositionPerWalletPerEpoch() public view {
        for (uint256 e = 1; e <= market.currentEpoch(); e++) {
            for (uint256 i = 0; i < 5; i++) {
                BetInfo memory bet = market.getBet(e, actors[i]);
                if (bet.amount == 0) continue;
                assertLe(bet.amount, market.maximumBet(), "a stake exceeded the cap");
            }
        }
    }

    /// @dev Nobody can be owed both winnings and a refund for the same round.
    function invariant_entitlementsAreMutuallyExclusive() public view {
        for (uint256 e = 1; e <= market.currentEpoch(); e++) {
            for (uint256 i = 0; i < 5; i++) {
                uint256 win = market.claimable(e, actors[i]);
                uint256 ref = market.refundable(e, actors[i]);
                assertTrue(win == 0 || ref == 0, "owed winnings and a refund at once");
            }
        }
    }

    /// @dev Guard against a vacuous run. Every handler action swallows legitimate
    ///      reverts, so a mistake there could leave the invariants technically true but
    ///      exercising nothing. This drives the handler directly and insists it bites.
    function test_handlerActuallyReachesTheContract() public {
        handler.bet(0, 1, true, 1 ether);
        handler.bet(1, 1, false, 2 ether);
        assertEq(handler.callsBet(), 2, "handler placed no bets");
        assertEq(handler.totalStaked(), 3 ether);

        handler.advanceTime(400);
        handler.publishPrice(1, 0, true);
        handler.execute();
        assertGt(handler.callsExecute(), 0, "handler never advanced the market");
        assertEq(market.currentEpoch(), 2, "market did not progress");

        handler.advanceTime(400);
        handler.publishPrice(1, 1e9, true);
        handler.execute();
        handler.claim(0, 1);
        assertGt(handler.callsClaim() + handler.callsCancel(), 0, "handler never resolved anything");
    }
}
