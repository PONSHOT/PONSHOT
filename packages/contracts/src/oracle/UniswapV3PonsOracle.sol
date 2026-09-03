// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IPredictionOracle} from "../interfaces/IPredictionOracle.sol";
import {IUniswapV3PoolMinimal} from "../interfaces/IUniswapV3PoolMinimal.sol";
import {TickPriceMath} from "../libraries/TickPriceMath.sol";

/// @title UniswapV3PonsOracle
/// @notice Manipulation-resistant PONS price, read from a Uniswap V3 pool's TWAP oracle.
///
/// @dev ## What this contract measures
///
/// `getPriceAt(t, w)` returns the arithmetic-mean-tick TWAP over the *closed
/// historical window* `[t - w, t]`, converted to quote-token units per 1e18 base
/// tokens. It does **not** measure "the price around now". That distinction is the
/// whole point:
///
///  - The answer is a pure function of `(t, w)` and committed pool history. A keeper
///    that settles 40 seconds late gets the identical number to one that settles on
///    time, so lateness cannot be steered into a favourable price.
///  - Nothing the settling transaction does can influence its own reading.
///
/// ## The sealing rule
///
/// Uniswap's `observe()` will happily answer for an instant *newer than the pool's
/// most recent observation* by extrapolating from that observation using the pool's
/// **current** tick. That extrapolated tail is attacker-controlled within the
/// settling block, and on a chain with sub-second blocks the tail can easily span a
/// large fraction of a 60-second window. Reading a TWAP that way would hand an
/// attacker most of the manipulation leverage the TWAP was supposed to remove.
///
/// So before answering, this oracle requires the window's end instant to be
/// **sealed**: the pool must already hold an observation at or after `t`. Once that
/// holds, both endpoints are interpolated purely between committed observations and
/// the live tick cannot leak in. An unsealed instant is reported as *not yet
/// available* rather than answered badly — the market retries, and cancels the round
/// if it stays unavailable past its tolerance.
///
/// ## Immutability
///
/// Pool, token ordering and base/quote roles are fixed at construction and verified
/// against the pool itself. There is no owner and no setter: migrating to a different
/// pool means deploying a new adapter and pointing *future* rounds at it.
contract UniswapV3PonsOracle is IPredictionOracle {
    using TickPriceMath for int24;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error ZeroWindow();
    error WindowTooLong(uint32 window, uint32 maxWindow);
    error BaseTokenNotInPool(address base);
    error QuoteTokenNotInPool(address quote);
    error TargetInFuture(uint256 target, uint256 nowTs);
    error TargetNotSealed(uint256 target, uint256 newestObservation);
    error WindowStartUnderflow(uint256 target, uint32 window);
    error HistoryEvicted(uint256 windowStart, uint256 earliestAvailable);
    error PoolNotInitialised();
    error QuoteIsZero(int24 meanTick);
    error BaseDecimalsTooLarge(uint8 decimals);
    error BaseDecimalsMismatch(uint8 declared, uint8 onChain);

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @notice The Uniswap V3 pool backing this feed.
    IUniswapV3PoolMinimal public immutable pool;

    /// @notice Token whose price is being measured (PONS).
    address public immutable baseToken;

    /// @notice Token the price is denominated in (WETH).
    address public immutable quoteToken;

    /// @notice True when `baseToken` is the pool's token0.
    /// @dev Resolved from the pool at construction; never assumed.
    bool public immutable baseIsToken0;

    /// @notice One whole unit of the base token, i.e. 10 ** baseDecimals.
    uint128 public immutable baseUnit;

    /// @notice Window used by `getPrice()`. Per-round windows are supplied by the caller.
    uint32 public immutable defaultTwapWindow;

    /// @notice Upper bound on any accepted window, guarding against absurd requests.
    uint32 public constant MAX_TWAP_WINDOW = 7 days;

    /// @inheritdoc IPredictionOracle
    uint64 public immutable oracleVersion;

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @param pool_ Uniswap V3 pool to read. Must contain both tokens.
    /// @param baseToken_ Token being priced (PONS).
    /// @param quoteToken_ Token prices are expressed in (WETH).
    /// @param baseDecimals_ Decimals of `baseToken_`, checked by the deploy script against the token.
    /// @param defaultTwapWindow_ Window for `getPrice()`.
    /// @param oracleVersion_ Version tag stamped into rounds that use this adapter.
    constructor(
        address pool_,
        address baseToken_,
        address quoteToken_,
        uint8 baseDecimals_,
        uint32 defaultTwapWindow_,
        uint64 oracleVersion_
    ) {
        if (pool_ == address(0) || baseToken_ == address(0) || quoteToken_ == address(0)) {
            revert ZeroAddress();
        }
        if (defaultTwapWindow_ == 0) revert ZeroWindow();
        if (defaultTwapWindow_ > MAX_TWAP_WINDOW) revert WindowTooLong(defaultTwapWindow_, MAX_TWAP_WINDOW);

        IUniswapV3PoolMinimal p = IUniswapV3PoolMinimal(pool_);
        address t0 = p.token0();
        address t1 = p.token1();

        // Ordering is *derived*, never assumed. In the live PONS/WETH 1% pool WETH is
        // token0 and PONS is token1, which inverts the tick->price direction; getting
        // this from the pool rather than from a constant is what keeps that correct.
        bool baseIs0;
        if (baseToken_ == t0) {
            baseIs0 = true;
            if (quoteToken_ != t1) revert QuoteTokenNotInPool(quoteToken_);
        } else if (baseToken_ == t1) {
            baseIs0 = false;
            if (quoteToken_ != t0) revert QuoteTokenNotInPool(quoteToken_);
        } else {
            revert BaseTokenNotInPool(baseToken_);
        }

        (,,, uint16 cardinality,,,) = p.slot0();
        if (cardinality == 0) revert PoolNotInitialised();

        // `10 ** decimals` is cast to uint128 below. Anything above 38 still fits uint256
        // but exceeds uint128, so the cast would truncate *silently* and every price this
        // oracle ever returned would be wrong by a factor nobody could see.
        if (baseDecimals_ > 38) revert BaseDecimalsTooLarge(baseDecimals_);

        // Cross-check the declared decimals against the token itself. The deploy script
        // already checks this, but a deploy script is not a guarantee — the contract is.
        // Tokens that do not expose `decimals()` are tolerated rather than rejected: the
        // call simply cannot disagree, and refusing them would rule out valid pairs.
        (bool ok, bytes memory data) = baseToken_.staticcall(abi.encodeWithSignature("decimals()"));
        if (ok && data.length >= 32) {
            uint8 onChain = uint8(abi.decode(data, (uint256)));
            if (onChain != baseDecimals_) revert BaseDecimalsMismatch(baseDecimals_, onChain);
        }

        pool = p;
        baseToken = baseToken_;
        quoteToken = quoteToken_;
        baseIsToken0 = baseIs0;
        baseUnit = uint128(10 ** uint256(baseDecimals_));
        defaultTwapWindow = defaultTwapWindow_;
        oracleVersion = oracleVersion_;
    }

    /*//////////////////////////////////////////////////////////////
                          IPredictionOracle
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IPredictionOracle
    function decimals() external pure returns (uint8) {
        return 18;
    }

    /// @inheritdoc IPredictionOracle
    function description() external view returns (string memory) {
        return string.concat(
            "UniswapV3 TWAP ",
            _symbol(baseToken),
            "/",
            _symbol(quoteToken),
            " fee=",
            _uintToString(pool.fee()),
            " window=",
            _uintToString(defaultTwapWindow),
            "s"
        );
    }

    /// @inheritdoc IPredictionOracle
    /// @dev Deliberately returns a *TWAP*, not spot, so that a consumer holding only
    ///      the generic interface cannot accidentally settle on a manipulable number.
    ///      Spot is available separately via `getSpotPrice()` and is display-only.
    function getPrice() external view returns (uint256 price, uint256 timestamp) {
        uint256 sealedAt = newestObservationTimestamp();
        // Clamp to the newest sealed instant so this never depends on the live tick.
        if (sealedAt > block.timestamp) sealedAt = block.timestamp;
        (price,) = _priceAt(sealedAt, defaultTwapWindow);
        timestamp = sealedAt;
    }

    /// @inheritdoc IPredictionOracle
    function getPriceAt(uint256 targetTimestamp, uint32 twapWindow)
        external
        view
        returns (uint256 price, int24 meanTick)
    {
        return _priceAt(targetTimestamp, twapWindow);
    }

    /// @inheritdoc IPredictionOracle
    function canQuote(uint256 targetTimestamp, uint32 twapWindow) public view returns (bool ok, string memory reason) {
        if (twapWindow == 0) return (false, "ZERO_WINDOW");
        if (twapWindow > MAX_TWAP_WINDOW) return (false, "WINDOW_TOO_LONG");
        if (targetTimestamp > block.timestamp) return (false, "TARGET_IN_FUTURE");
        if (targetTimestamp < twapWindow) return (false, "WINDOW_START_UNDERFLOW");

        uint256 newest = newestObservationTimestamp();
        if (newest < targetTimestamp) return (false, "TARGET_NOT_SEALED");

        uint256 windowStart = targetTimestamp - twapWindow;
        uint256 earliest = earliestAvailableTimestamp();
        if (windowStart < earliest) return (false, "HISTORY_EVICTED");
        if (block.timestamp - windowStart > type(uint32).max) return (false, "HISTORY_EVICTED");

        return (true, "");
    }

    /// @inheritdoc IPredictionOracle
    /// @dev The ring buffer's oldest live entry. Slot `(index + 1) % cardinality` is the
    ///      next to be overwritten and therefore the oldest — unless the buffer has not
    ///      wrapped yet, in which case that slot is uninitialised and slot 0 is oldest.
    function earliestAvailableTimestamp() public view returns (uint256) {
        (,, uint16 index, uint16 cardinality,,,) = pool.slot0();
        uint256 oldestIndex = (uint256(index) + 1) % uint256(cardinality);
        (uint32 ts,,, bool initialized) = pool.observations(oldestIndex);
        if (!initialized) {
            (ts,,,) = pool.observations(0);
        }
        return uint256(ts);
    }

    /*//////////////////////////////////////////////////////////////
                          ADDITIONAL VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Instantaneous pool price. **Display only — never settle on this.**
    /// @dev Trivially movable by anyone with capital for the duration of one block.
    function getSpotPrice() external view returns (uint256 price, int24 tick) {
        (, tick,,,,,) = pool.slot0();
        price = TickPriceMath.quoteAtTick(tick, baseUnit, baseIsToken0);
    }

    /// @notice Timestamp of the pool's most recent observation.
    function newestObservationTimestamp() public view returns (uint256) {
        (,, uint16 index,,,,) = pool.slot0();
        (uint32 ts,,,) = pool.observations(index);
        return uint256(ts);
    }

    /// @notice Ring-buffer occupancy, for monitoring and for deciding whether to grow it.
    function observationState()
        external
        view
        returns (uint16 index, uint16 cardinality, uint16 cardinalityNext, uint256 oldest, uint256 newest)
    {
        (,, index, cardinality, cardinalityNext,,) = pool.slot0();
        oldest = earliestAvailableTimestamp();
        newest = newestObservationTimestamp();
    }

    /// @notice In-range liquidity, surfaced so the market can gate exposure on pool depth.
    function poolLiquidity() external view returns (uint128) {
        return pool.liquidity();
    }

    /// @notice Grows the pool's observation buffer. Permissionless on the pool itself.
    /// @dev Exposed here only for operational convenience; it changes nothing about pricing.
    function increasePoolCardinality(uint16 next) external {
        pool.increaseObservationCardinalityNext(next);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _priceAt(uint256 targetTimestamp, uint32 twapWindow)
        internal
        view
        returns (uint256 price, int24 meanTick)
    {
        if (twapWindow == 0) revert ZeroWindow();
        if (twapWindow > MAX_TWAP_WINDOW) revert WindowTooLong(twapWindow, MAX_TWAP_WINDOW);
        if (targetTimestamp > block.timestamp) revert TargetInFuture(targetTimestamp, block.timestamp);
        if (targetTimestamp < twapWindow) revert WindowStartUnderflow(targetTimestamp, twapWindow);

        // The sealing rule. See the contract-level notes.
        uint256 newest = newestObservationTimestamp();
        if (newest < targetTimestamp) revert TargetNotSealed(targetTimestamp, newest);

        uint256 windowStart = targetTimestamp - twapWindow;
        uint256 earliest = earliestAvailableTimestamp();
        if (windowStart < earliest) revert HistoryEvicted(windowStart, earliest);

        uint256 agoStart = block.timestamp - windowStart;
        if (agoStart > type(uint32).max) revert HistoryEvicted(windowStart, earliest);

        // Both casts are lossless: `agoStart` is bounds-checked just above, and the window
        // start is never newer than the target, so `now - target <= now - windowStart`
        // and the second value cannot exceed the first.
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = uint32(agoStart);
        secondsAgos[1] = uint32(block.timestamp - targetTimestamp);

        // Reverts "OLD" if the pool disagrees about what it still holds; that
        // propagates to the caller as an unavailable oracle, which is the safe outcome.
        (int56[] memory tickCumulatives,) = pool.observe(secondsAgos);

        meanTick = TickPriceMath.meanTick(tickCumulatives[1] - tickCumulatives[0], twapWindow);
        price = TickPriceMath.quoteAtTick(meanTick, baseUnit, baseIsToken0);

        // A zero price would make every downstream comparison meaningless and would
        // signal that the pair has moved outside representable precision.
        if (price == 0) revert QuoteIsZero(meanTick);
    }

    function _symbol(address token) private view returns (string memory) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("symbol()"));
        if (ok && data.length >= 64) return abi.decode(data, (string));
        return "?";
    }

    function _uintToString(uint256 v) private pure returns (string memory) {
        if (v == 0) return "0";
        uint256 digits;
        for (uint256 t = v; t != 0; t /= 10) {
            digits++;
        }
        bytes memory buf = new bytes(digits);
        while (v != 0) {
            digits--;
            buf[digits] = bytes1(uint8(48 + (v % 10)));
            v /= 10;
        }
        return string(buf);
    }
}
