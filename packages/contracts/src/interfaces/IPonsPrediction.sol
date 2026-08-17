// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @title IPonsPrediction types and events
interface IPonsPredictionTypes {
    /// @notice Side of a prediction.
    enum Position {
        Bull, // PONS finishes higher
        Bear // PONS finishes lower
    }

    /// @notice Stored lifecycle state of a round.
    /// @dev `Open` covers both "accepting entries" and "entries closed, awaiting a
    ///      lock price". The two are distinguished by `lockTimestamp`, and
    ///      `phaseOf()` exposes the richer view the UI needs.
    enum RoundStatus {
        Pending, // never created
        Open,
        Locked,
        Settled,
        Cancelled
    }

    /// @notice How a settled round resolved.
    enum Outcome {
        Undecided,
        Bull,
        Bear,
        Tie, // closePrice == lockPrice
        NoContest, // the winning side attracted no stake, so nothing was won: refund
        AllLost // every entry was on the losing side: the whole pot funds the burn
    }

    /// @notice Richer, derived phase used by clients. Never stored.
    enum Phase {
        Pending,
        Open, // taking entries
        AwaitingLock, // entries closed, lock price not yet obtainable
        Live, // locked, running
        AwaitingSettle, // close time passed, close price not yet obtainable
        Settled,
        Cancelled,
        Cancellable // stuck past tolerance; anyone may cancel it
    }

    struct Round {
        uint256 epoch;
        uint256 startTimestamp;
        uint256 lockTimestamp;
        uint256 closeTimestamp;
        uint256 lockPrice;
        uint256 closePrice;
        uint256 totalAmount;
        uint256 bullAmount;
        uint256 bearAmount;
        uint256 rewardBaseAmount; // stake on the winning side
        uint256 rewardAmount; // total distributable to that side
        RoundStatus status;
    }

    /// @notice Per-round pinning of everything that decides the round's outcome.
    /// @dev Snapshotted when the round is created so that later configuration
    ///      changes provably cannot reach a round users have already entered.
    struct RoundTerms {
        address oracle;
        uint32 twapWindow;
        uint32 burnFeeBps;
        uint64 oracleVersion;
        int24 lockTick;
        int24 closeTick;
        uint64 lockedAt; // when the lock price was actually recorded
        uint64 settledAt; // when the close price was actually recorded
        Outcome outcome;
    }

    struct BetInfo {
        Position position;
        uint256 amount;
        bool claimed;
    }
}
