// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IPonsPredictionTypes} from "./interfaces/IPonsPrediction.sol";
import {IPredictionOracle} from "./interfaces/IPredictionOracle.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PonsPrediction
/// @notice Parimutuel up/down prediction on the PONS/WETH price, staked in native ETH.
///
/// @dev ## Why this is not a Pancake fork
///
/// In the familiar design the keeper's transaction *is* the price event: whatever
/// the oracle says at the moment the keeper lands becomes the lock or close price.
/// That couples money to keeper punctuality, and it hands whoever runs the keeper a
/// real option — settle now, or wait a block and settle at a better number.
///
/// Here a round's prices are a **pure function of the round's own schedule**:
///
///     lockPrice(n)  = oracle.getPriceAt(lockTimestamp(n),  twapWindow(n))
///     closePrice(n) = oracle.getPriceAt(closeTimestamp(n), twapWindow(n))
///
/// Both are TWAPs over closed historical windows. Nobody — keeper, admin, bettor —
/// can change the answer by choosing *when* to call, so the lifecycle transitions
/// are **permissionless**. Anyone may lock, settle or cancel a round; every caller
/// gets the identical result. That removes the keeper as a trust assumption and as a
/// liveness bottleneck in one move: the keeper in `apps/keeper` is a convenience, not
/// an authority, and a compromised keeper can do nothing an anonymous caller cannot.
///
/// ## Schedule
///
/// Rounds overlap, and each round's close instant *is* the next round's lock instant:
///
///     round n:      start ──────── lock ──────── close
///     round n+1:              start ──────── lock ──────── close
///
///     closeTimestamp(n) == lockTimestamp(n+1)      (invariant, by construction)
///
/// So consecutive rounds are priced off the same boundary reading and there is no
/// unmeasured gap between them. Schedule times are derived from the *previous
/// round's stored timestamps*, never from the executing block, so a late keeper
/// cannot make the schedule drift.
///
/// ## Round progression is decoupled from price availability
///
/// The pool's TWAP oracle can only answer for an instant once the pool has written
/// an observation at or after it, and Uniswap V3 writes one only when a swap moves
/// the tick. Measured on the live PONS pool that seal lag is ~60s at the median but
/// reached 888s over a 4.6-day window (see docs/TWAP_ANALYSIS.md). If round n+1 could
/// not open until round n had a price, one quiet stretch would stall the product.
///
/// So opening rounds and pricing rounds are independent. A round that is past its
/// lock time but not yet priced stops taking entries immediately and acquires its
/// price later — at the same value it would have had. Only if the price is still
/// unavailable `bufferSeconds` after it was due does the round become cancellable,
/// at which point every participant takes back 100% of their stake.
///
/// ## What administrators cannot do
///
/// There is no function by which any role can set a price, alter a placed bet, change
/// a recorded outcome, claim on a user's behalf, or withdraw ETH owed to users.
/// `claimTreasury` is bounded by `treasuryAmount`, which only ever grows by fees
/// booked during settlement. Fee and oracle changes are timelocked *and* snapshotted
/// per round, so they can only ever reach rounds that do not yet exist.
contract PonsPrediction is IPonsPredictionTypes, AccessControl, Pausable, ReentrancyGuard {
    /*//////////////////////////////////////////////////////////////
                                 ROLES
    //////////////////////////////////////////////////////////////*/

    /// @notice May start the very first round. Routine lifecycle needs no role.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// @notice May pause entries and cancel rounds that cannot be priced.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    /// @notice May adjust economic parameters within the contract's hard limits.
    bytes32 public constant CONFIG_ROLE = keccak256("CONFIG_ROLE");

    /*//////////////////////////////////////////////////////////////
                             HARD LIMITS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant MAX_BPS = 10_000;

    /// @notice Hard ceiling on the protocol fee. Not adjustable by anyone, ever.
    /// @dev 5% of the pooled stake. Chosen so that the contract itself, rather than
    ///      governance, is the guarantee bettors rely on.
    uint256 public constant MAX_TREASURY_FEE_BPS = 500;

    /// @notice Bounds on the round interval.
    uint32 public constant MIN_INTERVAL = 60;
    uint32 public constant MAX_INTERVAL = 1 days;

    /// @notice Bounds on the TWAP window.
    uint32 public constant MIN_TWAP_WINDOW = 30;
    uint32 public constant MAX_TWAP_WINDOW = 1 days;

    /// @notice Bounds on how long a round may wait for a price before it can be voided.
    /// @dev The floor is well above the worst seal lag measured on the live pool, so a
    ///      quiet market cannot cause spurious cancellations.
    uint32 public constant MIN_BUFFER_SECONDS = 900;
    uint32 public constant MAX_BUFFER_SECONDS = 7 days;

    /// @notice Delay applied to changes that could affect money: fee and oracle.
    uint256 public constant CONFIG_TIMELOCK = 2 days;

    /// @notice Hard bound on how many rounds the convenience helpers will scan in one call.
    /// @dev `executeRound` and `pendingWork` walk back over rounds that might still be
    ///      unresolved. That window is derived from `bufferSeconds / interval`, so without
    ///      a ceiling a large tolerance on a short interval would make both loop thousands
    ///      of times and exceed the block gas limit — bricking the keeper's path and the
    ///      operations dashboard with one configuration change. The bound keeps their cost
    ///      predictable; `lockRound`, `settleRound` and `cancelRound` address a single
    ///      round each, never loop, and stay available for anything outside the window.
    uint256 public constant MAX_SCAN_ROUNDS = 64;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error AlreadyStarted();
    error NotStarted();
    error RoundNotFound(uint256 epoch);
    error RoundNotOpen(uint256 epoch);
    error EntriesClosed(uint256 epoch);
    error AlreadyEntered(uint256 epoch, address account);
    error StakeBelowMinimum(uint256 sent, uint256 minimum);
    error StakeAboveMaximum(uint256 sent, uint256 maximum);
    error RoundPoolExceeded(uint256 would, uint256 cap);
    error NotYetLockable(uint256 epoch);
    error NotYetSettleable(uint256 epoch);
    error PriceUnavailable(uint256 epoch, uint256 instant, string reason);
    error RoundNotCancellable(uint256 epoch);
    error NothingToClaim(uint256 epoch, address account);
    error AlreadyClaimed(uint256 epoch, address account);
    error TransferFailed(address to, uint256 amount);
    error FeeTooHigh(uint256 bps, uint256 max);
    error OutOfBounds(uint256 value, uint256 lo, uint256 hi);
    error InvalidBetLimits(uint256 minimum, uint256 maximum);
    error NoPendingChange();
    error TimelockNotElapsed(uint256 readyAt);
    error TreasuryOverdraw(uint256 requested, uint256 available);
    error ToleranceExceedsScanWindow(uint32 bufferSeconds, uint32 interval, uint256 maxScanRounds);
    error DirectPaymentsRejected();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event RoundStarted(uint256 indexed epoch, uint256 startTimestamp, uint256 lockTimestamp, uint256 closeTimestamp);
    event RoundLocked(uint256 indexed epoch, uint256 lockPrice, int24 lockTick, uint256 instant, uint256 executedAt);
    event RoundSettled(
        uint256 indexed epoch,
        uint256 closePrice,
        int24 closeTick,
        Outcome outcome,
        uint256 rewardBaseAmount,
        uint256 rewardAmount,
        uint256 treasuryFee,
        uint256 executedAt
    );
    event RoundCancelled(uint256 indexed epoch, string reason);
    event BetBull(address indexed sender, uint256 indexed epoch, uint256 amount);
    event BetBear(address indexed sender, uint256 indexed epoch, uint256 amount);
    event Claim(address indexed sender, uint256 indexed epoch, uint256 amount);
    event Refund(address indexed sender, uint256 indexed epoch, uint256 amount);
    event TreasuryClaim(address indexed to, uint256 amount);

    event FeeChangeProposed(uint256 currentBps, uint256 proposedBps, uint256 readyAt);
    event FeeUpdated(uint256 previousBps, uint256 newBps);
    event OracleChangeProposed(address current, address proposed, uint256 readyAt);
    event OracleUpdated(address previous, address next, uint64 oracleVersion);
    event ConfigChangeCancelled(bytes32 indexed what);

    event IntervalUpdated(uint32 previous, uint32 next);
    event TwapWindowUpdated(uint32 previous, uint32 next);
    event BufferSecondsUpdated(uint32 previous, uint32 next);
    event MinimumBetUpdated(uint256 previous, uint256 next);
    event MaximumBetUpdated(uint256 previous, uint256 next);
    event MaximumRoundPoolUpdated(uint256 previous, uint256 next);
    event TreasuryUpdated(address previous, address next);

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    /// @notice Highest epoch that exists. 0 before genesis.
    uint256 public currentEpoch;

    /// @notice Price source used when creating *new* rounds.
    IPredictionOracle public oracle;

    /// @notice Where protocol fees are withdrawable to.
    address public treasury;

    /// @notice Seconds between a round's start and its lock, and between lock and close.
    uint32 public interval;
    /// @notice TWAP averaging length applied to new rounds.
    uint32 public twapWindow;
    /// @notice Grace period after a price is due before the round may be voided.
    uint32 public bufferSeconds;
    /// @notice Protocol fee applied to new rounds, in basis points of the pooled stake.
    uint32 public treasuryFeeBps;

    uint256 public minimumBet;
    /// @notice Per-wallet cap for a single entry. 0 disables the cap.
    uint256 public maximumBet;
    /// @notice Cap on a round's total pooled stake. 0 disables the cap.
    uint256 public maximumRoundPool;

    /// @notice Fees booked at settlement and not yet withdrawn.
    uint256 public treasuryAmount;

    /// @notice ETH this contract owes to users: live stakes, unclaimed rewards, unclaimed refunds.
    /// @dev The core solvency invariant is `address(this).balance >= totalLiabilities + treasuryAmount`.
    uint256 public totalLiabilities;

    mapping(uint256 epoch => Round) private _rounds;
    mapping(uint256 epoch => RoundTerms) private _terms;
    mapping(uint256 epoch => mapping(address account => BetInfo)) private _ledger;
    mapping(address account => uint256[] epochs) private _userEpochs;

    // Pending timelocked changes.
    uint32 private _pendingFeeBps;
    uint256 private _pendingFeeReadyAt;
    address private _pendingOracle;
    uint256 private _pendingOracleReadyAt;

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    struct InitParams {
        address admin;
        address operator;
        address treasury;
        address oracle;
        uint32 interval;
        uint32 twapWindow;
        uint32 bufferSeconds;
        uint32 treasuryFeeBps;
        uint256 minimumBet;
        uint256 maximumBet;
        uint256 maximumRoundPool;
    }

    constructor(InitParams memory p) {
        if (p.admin == address(0) || p.treasury == address(0) || p.oracle == address(0)) revert ZeroAddress();
        _checkInterval(p.interval);
        _checkTwapWindow(p.twapWindow);
        _checkBuffer(p.bufferSeconds);
        _checkTolerance(p.bufferSeconds, p.interval);
        if (p.treasuryFeeBps > MAX_TREASURY_FEE_BPS) revert FeeTooHigh(p.treasuryFeeBps, MAX_TREASURY_FEE_BPS);
        if (p.maximumBet != 0 && p.maximumBet < p.minimumBet) revert InvalidBetLimits(p.minimumBet, p.maximumBet);

        _grantRole(DEFAULT_ADMIN_ROLE, p.admin);
        _grantRole(PAUSER_ROLE, p.admin);
        _grantRole(CONFIG_ROLE, p.admin);
        if (p.operator != address(0)) _grantRole(OPERATOR_ROLE, p.operator);

        oracle = IPredictionOracle(p.oracle);
        treasury = p.treasury;
        interval = p.interval;
        twapWindow = p.twapWindow;
        bufferSeconds = p.bufferSeconds;
        treasuryFeeBps = p.treasuryFeeBps;
        minimumBet = p.minimumBet;
        maximumBet = p.maximumBet;
        maximumRoundPool = p.maximumRoundPool;
    }

    /*//////////////////////////////////////////////////////////////
                              ENTERING
    //////////////////////////////////////////////////////////////*/

    /// @notice Stake ETH on PONS finishing the round higher than it locked.
    function betBull(uint256 epoch) external payable whenNotPaused nonReentrant {
        _enter(epoch, Position.Bull);
    }

    /// @notice Stake ETH on PONS finishing the round lower than it locked.
    function betBear(uint256 epoch) external payable whenNotPaused nonReentrant {
        _enter(epoch, Position.Bear);
    }

    function _enter(uint256 epoch, Position position) private {
        Round storage r = _rounds[epoch];
        if (r.status == RoundStatus.Pending) revert RoundNotFound(epoch);
        if (r.status != RoundStatus.Open) revert RoundNotOpen(epoch);
        // Entries close on the clock, not on the keeper. A round whose lock time has
        // passed refuses stakes even if nobody has locked it yet.
        if (block.timestamp >= r.lockTimestamp) revert EntriesClosed(epoch);
        if (block.timestamp < r.startTimestamp) revert RoundNotOpen(epoch);

        uint256 amount = msg.value;
        if (amount < minimumBet) revert StakeBelowMinimum(amount, minimumBet);
        if (maximumBet != 0 && amount > maximumBet) revert StakeAboveMaximum(amount, maximumBet);

        BetInfo storage bet = _ledger[epoch][msg.sender];
        // One position per wallet per round. The struct is shaped so that topping up
        // the same side could be enabled later without a storage migration.
        if (bet.amount != 0) revert AlreadyEntered(epoch, msg.sender);

        uint256 newTotal = r.totalAmount + amount;
        if (maximumRoundPool != 0 && newTotal > maximumRoundPool) revert RoundPoolExceeded(newTotal, maximumRoundPool);

        bet.position = position;
        bet.amount = amount;
        r.totalAmount = newTotal;
        if (position == Position.Bull) {
            r.bullAmount += amount;
        } else {
            r.bearAmount += amount;
        }
        totalLiabilities += amount;
        _userEpochs[msg.sender].push(epoch);

        if (position == Position.Bull) {
            emit BetBull(msg.sender, epoch, amount);
        } else {
            emit BetBear(msg.sender, epoch, amount);
        }
    }

    /*//////////////////////////////////////////////////////////////
                         ROUND LIFECYCLE
    //////////////////////////////////////////////////////////////*/

    /// @notice Creates the first round. The only lifecycle call that needs a role,
    ///         because it is the one that chooses where the schedule begins.
    function genesisStartRound() external onlyRole(OPERATOR_ROLE) whenNotPaused {
        if (currentEpoch != 0) revert AlreadyStarted();
        uint256 start = block.timestamp;
        _createRound(1, start, start + interval, start + 2 * uint256(interval));
        currentEpoch = 1;
    }

    /// @notice Advances everything that is due. Convenience wrapper the keeper calls;
    ///         it grants no ability that `lockRound`/`settleRound`/`startNextRound` lack.
    /// @dev Never reverts on "nothing to do" so a keeper can call it on a fixed cadence
    ///      without special-casing quiet periods. Returns what it managed to do.
    function executeRound() external whenNotPaused returns (bool lockedAny, bool settledAny, bool startedAny) {
        if (currentEpoch == 0) revert NotStarted();

        // Settle before locking: a settle frees the older epoch, and both read the same
        // boundary instant, so ordering keeps the two consistent within one transaction.
        for (uint256 epoch = _oldestUnresolved(); epoch <= currentEpoch; epoch++) {
            Round storage r = _rounds[epoch];
            if (r.status == RoundStatus.Open && block.timestamp >= r.lockTimestamp) {
                if (_tryLock(epoch)) lockedAny = true;
            }
            if (_rounds[epoch].status == RoundStatus.Locked && block.timestamp >= r.closeTimestamp) {
                if (_trySettle(epoch)) settledAny = true;
            }
        }

        Round storage head = _rounds[currentEpoch];
        if (block.timestamp >= head.lockTimestamp) {
            _startNextRound();
            startedAny = true;
        }
    }

    /// @notice Opens the next round if the current one has stopped taking entries.
    /// @dev Permissionless: the schedule it writes is derived entirely from stored
    ///      timestamps, so the caller cannot influence it.
    function startNextRound() external whenNotPaused {
        if (currentEpoch == 0) revert NotStarted();
        if (block.timestamp < _rounds[currentEpoch].lockTimestamp) revert NotYetLockable(currentEpoch);
        _startNextRound();
    }

    /// @notice Records `epoch`'s lock price. Permissionless; reverts if not yet obtainable.
    function lockRound(uint256 epoch) external {
        Round storage r = _rounds[epoch];
        if (r.status != RoundStatus.Open) revert RoundNotOpen(epoch);
        if (block.timestamp < r.lockTimestamp) revert NotYetLockable(epoch);
        if (!_tryLock(epoch)) {
            (, string memory reason) = _probe(epoch, r.lockTimestamp);
            revert PriceUnavailable(epoch, r.lockTimestamp, reason);
        }
    }

    /// @notice Records `epoch`'s close price and resolves it. Permissionless.
    function settleRound(uint256 epoch) external {
        Round storage r = _rounds[epoch];
        if (r.status != RoundStatus.Locked) revert NotYetSettleable(epoch);
        if (block.timestamp < r.closeTimestamp) revert NotYetSettleable(epoch);
        if (!_trySettle(epoch)) {
            (, string memory reason) = _probe(epoch, r.closeTimestamp);
            revert PriceUnavailable(epoch, r.closeTimestamp, reason);
        }
    }

    /// @notice Voids a round whose price is still unobtainable `bufferSeconds` after it
    ///         was due. Permissionless, and the only outcome is a full refund to everyone.
    function cancelRound(uint256 epoch) external {
        Round storage r = _rounds[epoch];
        (bool can, string memory reason) = _cancellability(epoch);
        if (!can) revert RoundNotCancellable(epoch);
        r.status = RoundStatus.Cancelled;
        emit RoundCancelled(epoch, reason);
    }

    /// @notice Emergency void, restricted to PAUSER_ROLE.
    /// @dev Deliberately powerless over decided rounds. It is permitted only when
    ///      (a) the round is still taking entries, so no outcome exists yet, or
    ///      (b) the price the round needs is genuinely unavailable right now.
    ///      In neither case can it change a result — the sole effect is full refunds.
    function emergencyCancelRound(uint256 epoch) external onlyRole(PAUSER_ROLE) {
        Round storage r = _rounds[epoch];
        if (r.status == RoundStatus.Pending) revert RoundNotFound(epoch);
        if (r.status == RoundStatus.Settled || r.status == RoundStatus.Cancelled) revert RoundNotCancellable(epoch);

        bool beforeAnyOutcome = r.status == RoundStatus.Open && block.timestamp < r.lockTimestamp;
        if (!beforeAnyOutcome) {
            uint256 instant = r.status == RoundStatus.Open ? r.lockTimestamp : r.closeTimestamp;
            if (block.timestamp < instant) revert RoundNotCancellable(epoch);
            (bool ok,) = _probe(epoch, instant);
            // If the price is available the round can simply be settled by anyone, so
            // there is no emergency and no justification for voiding it.
            if (ok) revert RoundNotCancellable(epoch);
        }
        r.status = RoundStatus.Cancelled;
        emit RoundCancelled(epoch, beforeAnyOutcome ? "EMERGENCY_BEFORE_LOCK" : "EMERGENCY_PRICE_UNAVAILABLE");
    }

    /*//////////////////////////////////////////////////////////////
                       LIFECYCLE INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _startNextRound() private {
        Round storage head = _rounds[currentEpoch];
        uint256 next = currentEpoch + 1;
        if (_rounds[next].status != RoundStatus.Pending) return;

        // Times come from the previous round's *stored* schedule, never from
        // `block.timestamp`, so late execution cannot make the schedule drift.
        // Deriving the next lock from the previous close is what preserves
        // `closeTimestamp(n) == lockTimestamp(n+1)` across an interval change.
        uint256 start = head.lockTimestamp;
        uint256 lock = head.closeTimestamp;
        uint256 close = lock + interval;
        _createRound(next, start, lock, close);
        currentEpoch = next;
    }

    function _createRound(uint256 epoch, uint256 start, uint256 lock, uint256 close) private {
        Round storage r = _rounds[epoch];
        r.epoch = epoch;
        r.startTimestamp = start;
        r.lockTimestamp = lock;
        r.closeTimestamp = close;
        r.status = RoundStatus.Open;

        // Pin everything that decides this round's money, so that later configuration
        // changes provably cannot reach a round somebody has already entered.
        RoundTerms storage t = _terms[epoch];
        t.oracle = address(oracle);
        t.twapWindow = twapWindow;
        t.treasuryFeeBps = treasuryFeeBps;
        // Provenance only -- it records which pricing rules governed the round, and is
        // never an input to settlement. So it must not be able to halt anything: an
        // unguarded call here would let a misbehaving oracle revert `executeRound`
        // wholesale, discarding the lock and settle work already done in the same
        // transaction. Unavailable reads record 0 rather than stopping the schedule.
        try oracle.oracleVersion() returns (uint64 version) {
            t.oracleVersion = version;
        } catch {
            t.oracleVersion = 0;
        }

        emit RoundStarted(epoch, start, lock, close);
    }

    function _tryLock(uint256 epoch) private returns (bool) {
        Round storage r = _rounds[epoch];
        RoundTerms storage t = _terms[epoch];
        (bool ok, uint256 price, int24 tick) = _quote(t.oracle, r.lockTimestamp, t.twapWindow);
        if (!ok) return false;

        r.lockPrice = price;
        r.status = RoundStatus.Locked;
        t.lockTick = tick;
        t.lockedAt = uint64(block.timestamp);
        emit RoundLocked(epoch, price, tick, r.lockTimestamp, block.timestamp);
        return true;
    }

    function _trySettle(uint256 epoch) private returns (bool) {
        Round storage r = _rounds[epoch];
        RoundTerms storage t = _terms[epoch];
        (bool ok, uint256 price, int24 tick) = _quote(t.oracle, r.closeTimestamp, t.twapWindow);
        if (!ok) return false;

        r.closePrice = price;
        t.closeTick = tick;
        t.settledAt = uint64(block.timestamp);

        Outcome outcome;
        uint256 winningPool;
        if (r.bullAmount == 0 || r.bearAmount == 0) {
            // Nobody took the other side, so nothing was won. Charging a rake on a
            // bettor's own stake in that case would be a pure loss for being right,
            // so the round refunds instead. This also covers "nobody entered".
            outcome = Outcome.NoContest;
        } else if (price > r.lockPrice) {
            outcome = Outcome.Bull;
            winningPool = r.bullAmount;
        } else if (price < r.lockPrice) {
            outcome = Outcome.Bear;
            winningPool = r.bearAmount;
        } else {
            outcome = Outcome.Tie;
        }

        uint256 fee;
        if (winningPool != 0) {
            fee = (r.totalAmount * t.treasuryFeeBps) / MAX_BPS;
            r.rewardBaseAmount = winningPool;
            r.rewardAmount = r.totalAmount - fee;
            treasuryAmount += fee;
            totalLiabilities -= fee;
        }

        t.outcome = outcome;
        r.status = RoundStatus.Settled;
        emit RoundSettled(epoch, price, tick, outcome, r.rewardBaseAmount, r.rewardAmount, fee, block.timestamp);
        return true;
    }

    /// @dev External call in try/catch so a broken or hostile oracle degrades the round
    ///      to "unpriced" (and eventually refundable) rather than bricking the market.
    function _quote(address oracle_, uint256 instant, uint32 window)
        private
        view
        returns (bool ok, uint256 price, int24 tick)
    {
        try IPredictionOracle(oracle_).getPriceAt(instant, window) returns (uint256 p, int24 tk) {
            if (p == 0) return (false, 0, 0);
            return (true, p, tk);
        } catch {
            return (false, 0, 0);
        }
    }

    function _probe(uint256 epoch, uint256 instant) private view returns (bool ok, string memory reason) {
        RoundTerms storage t = _terms[epoch];
        try IPredictionOracle(t.oracle).canQuote(instant, t.twapWindow) returns (bool o, string memory r) {
            return (o, o ? "" : r);
        } catch {
            return (false, "ORACLE_REVERTED");
        }
    }

    /// @dev Scans back far enough to catch rounds still awaiting a price without
    ///      unbounded iteration. Two intervals plus the tolerance is the widest window
    ///      in which an unresolved round can legitimately still be sitting.
    function _oldestUnresolved() private view returns (uint256) {
        uint256 span = 3 + (uint256(bufferSeconds) / interval);
        // Bounded regardless of configuration; see MAX_SCAN_ROUNDS. `_checkTolerance`
        // keeps the two consistent so this clamp is a backstop, not a silent gap.
        if (span > MAX_SCAN_ROUNDS) span = MAX_SCAN_ROUNDS;
        return currentEpoch > span ? currentEpoch - span : 1;
    }

    function _cancellability(uint256 epoch) private view returns (bool, string memory) {
        Round storage r = _rounds[epoch];
        if (r.status == RoundStatus.Open) {
            if (block.timestamp <= r.lockTimestamp + bufferSeconds) return (false, "");
            (bool ok,) = _probe(epoch, r.lockTimestamp);
            return ok ? (false, "") : (true, "LOCK_PRICE_UNAVAILABLE");
        }
        if (r.status == RoundStatus.Locked) {
            if (block.timestamp <= r.closeTimestamp + bufferSeconds) return (false, "");
            (bool ok,) = _probe(epoch, r.closeTimestamp);
            return ok ? (false, "") : (true, "CLOSE_PRICE_UNAVAILABLE");
        }
        return (false, "");
    }

    /*//////////////////////////////////////////////////////////////
                                CLAIMS
    //////////////////////////////////////////////////////////////*/

    /// @notice Collects winnings and refunds across many rounds in one transaction.
    /// @dev Pull-based and reentrancy-guarded, with every storage effect applied before
    ///      the single ETH transfer at the end.
    function claim(uint256[] calldata epochs) external nonReentrant {
        uint256 payout;
        uint256 len = epochs.length;
        for (uint256 i = 0; i < len; i++) {
            uint256 epoch = epochs[i];
            BetInfo storage bet = _ledger[epoch][msg.sender];
            if (bet.amount == 0) revert NothingToClaim(epoch, msg.sender);
            if (bet.claimed) revert AlreadyClaimed(epoch, msg.sender);

            (bool won, uint256 amount) = _entitlement(epoch, msg.sender);
            if (amount == 0) revert NothingToClaim(epoch, msg.sender);

            bet.claimed = true;
            payout += amount;
            if (won) {
                emit Claim(msg.sender, epoch, amount);
            } else {
                emit Refund(msg.sender, epoch, amount);
            }
        }

        totalLiabilities -= payout;
        _send(msg.sender, payout);
    }

    /// @notice Winnings owed to `account` for `epoch`, or 0.
    function claimable(uint256 epoch, address account) external view returns (uint256) {
        (bool won, uint256 amount) = _entitlement(epoch, account);
        return won ? amount : 0;
    }

    /// @notice Stake refundable to `account` for `epoch`, or 0.
    function refundable(uint256 epoch, address account) external view returns (uint256) {
        (bool won, uint256 amount) = _entitlement(epoch, account);
        return won ? 0 : amount;
    }

    /// @return won True when the amount is winnings; false when it is a returned stake.
    /// @return amount Zero if there is nothing to collect, including if already collected.
    function _entitlement(uint256 epoch, address account) private view returns (bool won, uint256 amount) {
        BetInfo storage bet = _ledger[epoch][account];
        if (bet.amount == 0 || bet.claimed) return (false, 0);

        Round storage r = _rounds[epoch];
        if (r.status == RoundStatus.Cancelled) return (false, bet.amount);
        if (r.status != RoundStatus.Settled) return (false, 0);

        Outcome outcome = _terms[epoch].outcome;
        if (outcome == Outcome.Tie || outcome == Outcome.NoContest) return (false, bet.amount);

        bool isWinner = (outcome == Outcome.Bull && bet.position == Position.Bull)
            || (outcome == Outcome.Bear && bet.position == Position.Bear);
        if (!isWinner) return (false, 0);

        // Floor division; the wei of dust it leaves behind stays inside the contract
        // and is therefore always on the solvent side of the accounting invariant.
        return (true, (bet.amount * r.rewardAmount) / r.rewardBaseAmount);
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = payable(to).call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
    }

    /*//////////////////////////////////////////////////////////////
                               TREASURY
    //////////////////////////////////////////////////////////////*/

    /// @notice Withdraws accrued protocol fees.
    /// @dev Bounded by `treasuryAmount`, which grows only from fees booked at
    ///      settlement, so this can never reach ETH owed to users.
    function claimTreasury(uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        uint256 available = treasuryAmount;
        if (amount == 0 || amount > available) revert TreasuryOverdraw(amount, available);
        treasuryAmount = available - amount;
        emit TreasuryClaim(treasury, amount);
        _send(treasury, amount);
    }

    /*//////////////////////////////////////////////////////////////
                            CONFIGURATION
    //////////////////////////////////////////////////////////////*/

    function pausePrediction() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpausePrediction() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function proposeTreasuryFee(uint32 bps) external onlyRole(CONFIG_ROLE) {
        if (bps > MAX_TREASURY_FEE_BPS) revert FeeTooHigh(bps, MAX_TREASURY_FEE_BPS);
        _pendingFeeBps = bps;
        _pendingFeeReadyAt = block.timestamp + CONFIG_TIMELOCK;
        emit FeeChangeProposed(treasuryFeeBps, bps, _pendingFeeReadyAt);
    }

    function commitTreasuryFee() external onlyRole(CONFIG_ROLE) {
        if (_pendingFeeReadyAt == 0) revert NoPendingChange();
        if (block.timestamp < _pendingFeeReadyAt) revert TimelockNotElapsed(_pendingFeeReadyAt);
        uint32 previous = treasuryFeeBps;
        treasuryFeeBps = _pendingFeeBps;
        _pendingFeeReadyAt = 0;
        emit FeeUpdated(previous, treasuryFeeBps);
    }

    function proposeOracle(address next) external onlyRole(CONFIG_ROLE) {
        if (next == address(0)) revert ZeroAddress();
        // Fail early rather than at commit time if the candidate is not a working oracle.
        IPredictionOracle(next).oracleVersion();
        _pendingOracle = next;
        _pendingOracleReadyAt = block.timestamp + CONFIG_TIMELOCK;
        emit OracleChangeProposed(address(oracle), next, _pendingOracleReadyAt);
    }

    function commitOracle() external onlyRole(CONFIG_ROLE) {
        if (_pendingOracleReadyAt == 0) revert NoPendingChange();
        if (block.timestamp < _pendingOracleReadyAt) revert TimelockNotElapsed(_pendingOracleReadyAt);
        address previous = address(oracle);
        oracle = IPredictionOracle(_pendingOracle);
        _pendingOracleReadyAt = 0;
        uint64 version;
        try oracle.oracleVersion() returns (uint64 v) {
            version = v;
        } catch {}
        emit OracleUpdated(previous, address(oracle), version);
    }

    function cancelPendingFee() external onlyRole(CONFIG_ROLE) {
        _pendingFeeReadyAt = 0;
        emit ConfigChangeCancelled("fee");
    }

    function cancelPendingOracle() external onlyRole(CONFIG_ROLE) {
        _pendingOracleReadyAt = 0;
        emit ConfigChangeCancelled("oracle");
    }

    function setInterval(uint32 next) external onlyRole(CONFIG_ROLE) {
        _checkInterval(next);
        _checkTolerance(bufferSeconds, next);
        emit IntervalUpdated(interval, next);
        interval = next;
    }

    function setTwapWindow(uint32 next) external onlyRole(CONFIG_ROLE) {
        _checkTwapWindow(next);
        emit TwapWindowUpdated(twapWindow, next);
        twapWindow = next;
    }

    function setBufferSeconds(uint32 next) external onlyRole(CONFIG_ROLE) {
        _checkBuffer(next);
        _checkTolerance(next, interval);
        emit BufferSecondsUpdated(bufferSeconds, next);
        bufferSeconds = next;
    }

    function setMinimumBet(uint256 next) external onlyRole(CONFIG_ROLE) {
        if (maximumBet != 0 && next > maximumBet) revert InvalidBetLimits(next, maximumBet);
        emit MinimumBetUpdated(minimumBet, next);
        minimumBet = next;
    }

    function setMaximumBet(uint256 next) external onlyRole(CONFIG_ROLE) {
        if (next != 0 && next < minimumBet) revert InvalidBetLimits(minimumBet, next);
        emit MaximumBetUpdated(maximumBet, next);
        maximumBet = next;
    }

    function setMaximumRoundPool(uint256 next) external onlyRole(CONFIG_ROLE) {
        emit MaximumRoundPoolUpdated(maximumRoundPool, next);
        maximumRoundPool = next;
    }

    function setTreasury(address next) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (next == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, next);
        treasury = next;
    }

    function _checkInterval(uint32 v) private pure {
        if (v < MIN_INTERVAL || v > MAX_INTERVAL) revert OutOfBounds(v, MIN_INTERVAL, MAX_INTERVAL);
    }

    function _checkTwapWindow(uint32 v) private pure {
        if (v < MIN_TWAP_WINDOW || v > MAX_TWAP_WINDOW) revert OutOfBounds(v, MIN_TWAP_WINDOW, MAX_TWAP_WINDOW);
    }

    /// @dev Keeps the cancellation tolerance inside the window the helpers actually scan.
    ///      Enforced where the values are set rather than left to the clamp, so an operator
    ///      is told no instead of quietly getting a market whose older rounds the keeper
    ///      never looks at.
    function _checkTolerance(uint32 bufferSeconds_, uint32 interval_) private pure {
        if (3 + (uint256(bufferSeconds_) / interval_) > MAX_SCAN_ROUNDS) {
            revert ToleranceExceedsScanWindow(bufferSeconds_, interval_, MAX_SCAN_ROUNDS);
        }
    }

    function _checkBuffer(uint32 v) private pure {
        if (v < MIN_BUFFER_SECONDS || v > MAX_BUFFER_SECONDS) {
            revert OutOfBounds(v, MIN_BUFFER_SECONDS, MAX_BUFFER_SECONDS);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    function getRound(uint256 epoch) external view returns (Round memory) {
        return _rounds[epoch];
    }

    function getRoundTerms(uint256 epoch) external view returns (RoundTerms memory) {
        return _terms[epoch];
    }

    function getBet(uint256 epoch, address account) external view returns (BetInfo memory) {
        return _ledger[epoch][account];
    }

    /// @notice Epochs `account` has entered, newest last. Paginated because it is unbounded.
    function getUserEpochs(address account, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory page, uint256 total)
    {
        uint256[] storage all = _userEpochs[account];
        total = all.length;
        if (offset >= total) return (new uint256[](0), total);
        uint256 n = total - offset;
        if (n > limit) n = limit;
        page = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            page[i] = all[offset + i];
        }
    }

    /// @notice The three rounds a client renders: previous, live and next.
    /// @dev Returns zeros for slots that do not exist yet.
    function getVisibleRounds() external view returns (Round memory previous, Round memory live, Round memory next) {
        uint256 e = currentEpoch;
        if (e == 0) return (previous, live, next);
        next = _rounds[e];
        if (e >= 2) live = _rounds[e - 1];
        if (e >= 3) previous = _rounds[e - 2];
    }

    /// @notice Derived phase, including states the stored status does not distinguish.
    function phaseOf(uint256 epoch) external view returns (Phase) {
        Round storage r = _rounds[epoch];
        if (r.status == RoundStatus.Pending) return Phase.Pending;
        if (r.status == RoundStatus.Cancelled) return Phase.Cancelled;
        if (r.status == RoundStatus.Settled) return Phase.Settled;

        (bool cancellable,) = _cancellability(epoch);
        if (cancellable) return Phase.Cancellable;

        if (r.status == RoundStatus.Open) {
            return block.timestamp < r.lockTimestamp ? Phase.Open : Phase.AwaitingLock;
        }
        return block.timestamp < r.closeTimestamp ? Phase.Live : Phase.AwaitingSettle;
    }

    /// @notice What a keeper (or anyone) could usefully do right now.
    function pendingWork()
        external
        view
        returns (
            uint256[] memory lockable,
            uint256[] memory settleable,
            uint256[] memory cancellable,
            bool canStartNext
        )
    {
        if (currentEpoch == 0) {
            return (new uint256[](0), new uint256[](0), new uint256[](0), false);
        }
        uint256 from = _oldestUnresolved();
        uint256 span = currentEpoch - from + 1;
        uint256[] memory l = new uint256[](span);
        uint256[] memory s = new uint256[](span);
        uint256[] memory c = new uint256[](span);
        uint256 li;
        uint256 si;
        uint256 ci;

        for (uint256 epoch = from; epoch <= currentEpoch; epoch++) {
            Round storage r = _rounds[epoch];
            (bool canCancel,) = _cancellability(epoch);
            if (canCancel) {
                c[ci++] = epoch;
                continue;
            }
            if (r.status == RoundStatus.Open && block.timestamp >= r.lockTimestamp) {
                (bool ok,) = _probe(epoch, r.lockTimestamp);
                if (ok) l[li++] = epoch;
            } else if (r.status == RoundStatus.Locked && block.timestamp >= r.closeTimestamp) {
                (bool ok,) = _probe(epoch, r.closeTimestamp);
                if (ok) s[si++] = epoch;
            }
        }

        lockable = _trim(l, li);
        settleable = _trim(s, si);
        cancellable = _trim(c, ci);
        canStartNext = block.timestamp >= _rounds[currentEpoch].lockTimestamp
            && _rounds[currentEpoch + 1].status == RoundStatus.Pending;
    }

    function _trim(uint256[] memory arr, uint256 n) private pure returns (uint256[] memory out) {
        out = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = arr[i];
        }
    }

    /// @notice The solvency invariant, exposed so monitoring reads exactly what tests assert.
    function solvency() external view returns (uint256 balance, uint256 owed, bool solvent) {
        balance = address(this).balance;
        owed = totalLiabilities + treasuryAmount;
        solvent = balance >= owed;
    }

    function pendingConfig()
        external
        view
        returns (uint32 pendingFeeBps, uint256 feeReadyAt, address pendingOracle, uint256 oracleReadyAt)
    {
        return (_pendingFeeBps, _pendingFeeReadyAt, _pendingOracle, _pendingOracleReadyAt);
    }

    /// @dev Stakes must arrive through `betBull`/`betBear` so that they are recorded.
    ///      Untracked ETH can still be forced in via `selfdestruct`, which only ever
    ///      makes the contract more solvent and is why the invariant is `>=`.
    receive() external payable {
        revert DirectPaymentsRejected();
    }
}
