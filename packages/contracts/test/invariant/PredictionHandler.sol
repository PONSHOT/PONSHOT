// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsPrediction} from "../../src/PonsPrediction.sol";
import {IPonsPredictionTypes} from "../../src/interfaces/IPonsPrediction.sol";
import {MockPredictionOracle} from "../../src/mocks/MockPredictionOracle.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

/// @notice Drives the market the way the world would: random stakes from a fixed cast of
///         actors, random time jumps, an oracle that is sometimes simply unavailable, and
///         claims taken in arbitrary order.
/// @dev Every action is written so that *legitimate* reverts are swallowed and only a
///      broken invariant can fail the run. Totals are tracked independently here so the
///      invariants compare the contract against a model, not against itself.
contract PredictionHandler is CommonBase, StdCheats, StdUtils, IPonsPredictionTypes {
    PonsPrediction public immutable market;
    MockPredictionOracle public immutable oracle;

    address[5] public actors;
    address public immutable admin;

    uint256 public totalStaked;
    uint256 public totalPaidOut;
    uint256 public totalFeesWithdrawn;
    uint256 public ghostPrice = 1_400_000_000_000;

    uint256 public callsBet;
    uint256 public callsClaim;
    uint256 public callsExecute;
    uint256 public callsCancel;

    constructor(PonsPrediction market_, MockPredictionOracle oracle_, address[5] memory actors_, address admin_) {
        market = market_;
        oracle = oracle_;
        actors = actors_;
        admin = admin_;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function bet(uint256 actorSeed, uint256 epochSeed, bool bull, uint96 amount) external {
        address who = _actor(actorSeed);
        uint256 epoch = bound(epochSeed, 1, market.currentEpoch() == 0 ? 1 : market.currentEpoch());
        amount = uint96(bound(amount, market.minimumBet(), 20 ether));
        if (who.balance < amount) return;

        vm.prank(who);
        if (bull) {
            try market.betBull{value: amount}(epoch) {
                totalStaked += amount;
                callsBet++;
            } catch {}
        } else {
            try market.betBear{value: amount}(epoch) {
                totalStaked += amount;
                callsBet++;
            } catch {}
        }
    }

    /// @dev Time moves in irregular jumps, so rounds are sometimes handled promptly and
    ///      sometimes only after several intervals have gone by.
    function advanceTime(uint32 delta) external {
        vm.warp(block.timestamp + bound(delta, 1, 1200));
    }

    /// @dev Publishing is deliberately unreliable: this is what makes rounds get stuck.
    function publishPrice(uint256 epochSeed, int256 drift, bool publish) external {
        if (market.currentEpoch() == 0) return;
        uint256 epoch = bound(epochSeed, 1, market.currentEpoch());
        Round memory r = market.getRound(epoch);
        if (r.epoch == 0) return;
        if (!publish) return;

        ghostPrice = bound(uint256(int256(ghostPrice) + bound(drift, -5e10, 5e10)), 1e9, 1e16);
        if (block.timestamp >= r.lockTimestamp) oracle.setPrice(r.lockTimestamp, ghostPrice);
        if (block.timestamp >= r.closeTimestamp) oracle.setPrice(r.closeTimestamp, ghostPrice);
    }

    function execute() external {
        if (market.currentEpoch() == 0) return;
        try market.executeRound() {
            callsExecute++;
        } catch {}
    }

    function cancel(uint256 epochSeed) external {
        if (market.currentEpoch() == 0) return;
        uint256 epoch = bound(epochSeed, 1, market.currentEpoch());
        try market.cancelRound(epoch) {
            callsCancel++;
        } catch {}
    }

    function claim(uint256 actorSeed, uint256 epochSeed) external {
        address who = _actor(actorSeed);
        if (market.currentEpoch() == 0) return;
        uint256 epoch = bound(epochSeed, 1, market.currentEpoch());

        uint256 expected = market.claimable(epoch, who) + market.refundable(epoch, who);
        if (expected == 0) return;

        uint256[] memory e = new uint256[](1);
        e[0] = epoch;
        uint256 before = who.balance;
        vm.prank(who);
        try market.claim(e) {
            totalPaidOut += who.balance - before;
            callsClaim++;
        } catch {}
    }

    function sweepBurn(uint256) external {
        uint256 available = market.burnAllocated();
        if (available == 0) return;
        try market.sweepToBurner() {
            totalFeesWithdrawn += available;
        } catch {}
    }

    function actorCount() external pure returns (uint256) {
        return 5;
    }
}
