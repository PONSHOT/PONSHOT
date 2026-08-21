// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsPrediction} from "../../src/PonsPrediction.sol";
import {IPonsPredictionTypes} from "../../src/interfaces/IPonsPrediction.sol";
import {MockPredictionOracle} from "../../src/mocks/MockPredictionOracle.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Shared fixture: a started market on a 300s interval with a scriptable oracle.
abstract contract PredictionHarness is Test, IPonsPredictionTypes {
    PonsPrediction internal market;
    MockPredictionOracle internal oracle;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal burnerWallet = makeAddr("burner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal charlie = makeAddr("charlie");
    address internal dora = makeAddr("dora");

    uint32 internal constant INTERVAL = 300;
    uint32 internal constant TWAP = 60;
    uint32 internal constant BUFFER = 900;
    uint32 internal constant FEE_BPS = 300;
    uint256 internal constant MIN_BET = 0.001 ether;
    uint256 internal constant MAX_BET = 100 ether;
    uint256 internal constant MAX_POOL = 1000 ether;

    uint256 internal constant P0 = 1_400_000_000_000; // 0.0000014 WETH per PONS

    function _deployMarket() internal {
        vm.warp(1_700_000_000);
        oracle = new MockPredictionOracle();
        market = new PonsPrediction(
            PonsPrediction.InitParams({
                admin: admin,
                operator: operator,
                burner: burnerWallet,
                oracle: address(oracle),
                interval: INTERVAL,
                twapWindow: TWAP,
                bufferSeconds: BUFFER,
                burnFeeBps: FEE_BPS,
                minimumBet: MIN_BET,
                maximumBet: MAX_BET,
                maximumRoundPool: MAX_POOL
            })
        );
        for (uint160 i = 0; i < 6; i++) {
            vm.deal(address(uint160(uint160(alice) + i)), 0);
        }
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(charlie, 1000 ether);
        vm.deal(dora, 1000 ether);

        vm.prank(operator);
        market.genesisStartRound();
    }

    function _bet(address who, uint256 epoch, bool bull, uint256 amount) internal {
        vm.prank(who);
        if (bull) {
            market.betBull{value: amount}(epoch);
        } else {
            market.betBear{value: amount}(epoch);
        }
    }

    /// @dev Moves to a round's lock instant, publishes the boundary price and advances
    ///      the machine, mirroring what a healthy keeper would do.
    function _advanceTo(uint256 instant, uint256 price) internal {
        vm.warp(instant + 1);
        oracle.setPrice(instant, price);
        market.executeRound();
    }

    function _round(uint256 epoch) internal view returns (Round memory) {
        return market.getRound(epoch);
    }

    function _terms(uint256 epoch) internal view returns (RoundTerms memory) {
        return market.getRoundTerms(epoch);
    }

    /// @dev The invariant every test re-checks: the contract can always pay what it owes.
    function _assertSolvent() internal view {
        (uint256 balance, uint256 owed, bool solvent) = market.solvency();
        assertTrue(solvent, "insolvent");
        assertGe(balance, owed);
    }
}
