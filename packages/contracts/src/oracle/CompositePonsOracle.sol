// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IPredictionOracle} from "../interfaces/IPredictionOracle.sol";
import {IUniswapV3PoolMinimal} from "../interfaces/IUniswapV3PoolMinimal.sol";
import {TickPriceMath} from "../libraries/TickPriceMath.sol";

/// @title CompositePonsOracle
/// @notice PONS price agreed across several Uniswap V3 pools, so moving one is not enough.
///
/// @dev ## Why this exists
///
/// A single-pool TWAP is only as expensive to manipulate as that one pool is deep. Measured
/// against the live PONS/WETH 1% pool, shifting its 300s TWAP costs roughly 0.004 WETH per
/// basis point in fees alone — cheap enough that the market's exposure caps had to be set
/// painfully low. See docs/MANIPULATION_ANALYSIS.md.
///
/// PONS trades in two pools of comparable depth. This oracle reads both and requires them
/// to **agree** before it answers. That changes the attack in two ways:
///
///  - Moving one pool no longer moves the price proportionally. Push it beyond the
///    tolerance and the pools disagree, the oracle reports unavailable, and the round
///    refunds — the attacker has paid the fees and achieved nothing.
///  - Staying inside the tolerance caps the achievable shift at roughly half the gate,
///    because the answer is the median of the sources.
///
/// To move the result further an attacker has to move every pool in step, which costs
/// close to the sum of their depths rather than the smallest of them.
///
/// ## Choosing the tolerance
///
/// Entirely empirical, and the one number this contract turns on. Measured across ~2h of
/// matched 300s windows on the two live pools, natural divergence ran to a median of 38bp
/// and a maximum of 72bp (`tools/onchain-audit/divergence.py`). A 100bp gate would have
/// refused none of those 60 rounds while capping a single-pool shift near 50bp. Set it
/// tighter and honest rounds start refunding; wider and the cap it imposes weakens.
///
/// ## What it does not do
///
/// It does not average away a manipulated pool — with two sources the median sits between
/// them, so a tolerated divergence still moves the answer by up to half of it. The gate is
/// the protection; the median only limits what slips under it.
contract CompositePonsOracle is IPredictionOracle {
    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error NoSources();
    error TooManySources(uint256 given, uint256 max);
    error ZeroWindow();
    error WindowTooLong(uint32 window, uint32 maxWindow);
    error DivergenceToleranceZero();
    error BaseTokenNotInPool(address pool, address base);
    error QuoteTokenNotInPool(address pool, address quote);
    error BaseDecimalsTooLarge(uint8 decimals);
    error BaseDecimalsMismatch(uint8 declared, uint8 onChain);
    error PoolNotInitialised(address pool);
    error TargetInFuture(uint256 target, uint256 nowTs);
    error WindowStartUnderflow(uint256 target, uint32 window);
    error SourceUnavailable(address pool);
    error SourcesDiverged(int24 lowTick, int24 highTick, uint256 spreadBps, uint256 toleranceBps);
    error QuoteIsZero(int24 medianTick);

    /*//////////////////////////////////////////////////////////////
                              IMMUTABLES
    //////////////////////////////////////////////////////////////*/

    /// @dev Small on purpose: every source is read on every quote, so the cost of a
    ///      settlement grows with this, and each extra pool is another availability
    ///      dependency that can stall a round.
    uint256 public constant MAX_SOURCES = 5;
    uint32 public constant MAX_TWAP_WINDOW = 7 days;

    address public immutable baseToken;
    address public immutable quoteToken;
    uint128 public immutable baseUnit;
    uint32 public immutable defaultTwapWindow;
    uint64 public immutable oracleVersion;

    /// @notice Maximum spread between the cheapest and dearest source, in basis points.
    uint256 public immutable maxDivergenceBps;

    struct Source {
        IUniswapV3PoolMinimal pool;
        bool baseIsToken0;
    }

    Source[] private _sources;

    /*//////////////////////////////////////////////////////////////
                             CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(
        address[] memory pools,
        address baseToken_,
        address quoteToken_,
        uint8 baseDecimals_,
        uint32 defaultTwapWindow_,
        uint256 maxDivergenceBps_,
        uint64 oracleVersion_
    ) {
        if (baseToken_ == address(0) || quoteToken_ == address(0)) revert ZeroAddress();
        if (pools.length == 0) revert NoSources();
        if (pools.length > MAX_SOURCES) revert TooManySources(pools.length, MAX_SOURCES);
        if (defaultTwapWindow_ == 0) revert ZeroWindow();
        if (defaultTwapWindow_ > MAX_TWAP_WINDOW) revert WindowTooLong(defaultTwapWindow_, MAX_TWAP_WINDOW);
        // A zero tolerance would demand two independent pools agree to the tick, which
        // they never do; every round would refuse to settle.
        if (maxDivergenceBps_ == 0) revert DivergenceToleranceZero();

        // Same truncation trap as the single-pool adapter: `10 ** decimals` is narrowed to
        // uint128, and anything above 38 fits uint256 but not uint128.
        if (baseDecimals_ > 38) revert BaseDecimalsTooLarge(baseDecimals_);
        (bool ok, bytes memory data) = baseToken_.staticcall(abi.encodeWithSignature("decimals()"));
        if (ok && data.length >= 32) {
            uint8 onChain = uint8(abi.decode(data, (uint256)));
            if (onChain != baseDecimals_) revert BaseDecimalsMismatch(baseDecimals_, onChain);
        }

        for (uint256 i = 0; i < pools.length; i++) {
            address poolAddr = pools[i];
            if (poolAddr == address(0)) revert ZeroAddress();
            IUniswapV3PoolMinimal pool = IUniswapV3PoolMinimal(poolAddr);

            // Ordering is derived per pool, never assumed, and may legitimately differ
            // between sources for the same pair.
            address t0 = pool.token0();
            address t1 = pool.token1();
            bool baseIs0;
            if (baseToken_ == t0) {
                baseIs0 = true;
                if (quoteToken_ != t1) revert QuoteTokenNotInPool(poolAddr, quoteToken_);
            } else if (baseToken_ == t1) {
                baseIs0 = false;
                if (quoteToken_ != t0) revert QuoteTokenNotInPool(poolAddr, quoteToken_);
            } else {
                revert BaseTokenNotInPool(poolAddr, baseToken_);
            }

            (,,, uint16 cardinality,,,) = pool.slot0();
            if (cardinality == 0) revert PoolNotInitialised(poolAddr);

            _sources.push(Source({pool: pool, baseIsToken0: baseIs0}));
        }

        baseToken = baseToken_;
        quoteToken = quoteToken_;
        baseUnit = uint128(10 ** uint256(baseDecimals_));
        defaultTwapWindow = defaultTwapWindow_;
        maxDivergenceBps = maxDivergenceBps_;
        oracleVersion = oracleVersion_;
    }

    /*//////////////////////////////////////////////////////////////
                          IPredictionOracle
    //////////////////////////////////////////////////////////////*/

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function description() external view returns (string memory) {
        return string.concat(
            "Composite UniswapV3 TWAP over ",
            _u(_sources.length),
            " pools, window=",
            _u(defaultTwapWindow),
            "s, max divergence=",
            _u(maxDivergenceBps),
            "bps"
        );
    }

    function getPrice() external view returns (uint256 price, uint256 timestamp) {
        // The newest instant every source can already answer for.
        uint256 sealedAt = _newestCommonObservation();
        if (sealedAt > block.timestamp) sealedAt = block.timestamp;
        (price,) = _priceAt(sealedAt, defaultTwapWindow);
        timestamp = sealedAt;
    }

    function getPriceAt(uint256 targetTimestamp, uint32 twapWindow)
        external
        view
        returns (uint256 price, int24 meanTick)
    {
        return _priceAt(targetTimestamp, twapWindow);
    }

    function canQuote(uint256 targetTimestamp, uint32 twapWindow) public view returns (bool ok, string memory reason) {
        if (twapWindow == 0) return (false, "ZERO_WINDOW");
        if (twapWindow > MAX_TWAP_WINDOW) return (false, "WINDOW_TOO_LONG");
        if (targetTimestamp > block.timestamp) return (false, "TARGET_IN_FUTURE");
        if (targetTimestamp < twapWindow) return (false, "WINDOW_START_UNDERFLOW");

        int24 low = type(int24).max;
        int24 high = type(int24).min;
        for (uint256 i = 0; i < _sources.length; i++) {
            (bool available, int24 tick) = _sourceTick(_sources[i], targetTimestamp, twapWindow);
            if (!available) return (false, "SOURCE_UNAVAILABLE");
            if (tick < low) low = tick;
            if (tick > high) high = tick;
        }
        if (_spreadBps(low, high) > maxDivergenceBps) return (false, "SOURCES_DIVERGED");
        return (true, "");
    }

    /// @dev The most restrictive source wins: the composite can only reach as far back as
    ///      its shortest history allows.
    function earliestAvailableTimestamp() public view returns (uint256 earliest) {
        for (uint256 i = 0; i < _sources.length; i++) {
            uint256 e = _earliestOf(_sources[i].pool);
            if (e > earliest) earliest = e;
        }
    }

    /*//////////////////////////////////////////////////////////////
                          ADDITIONAL VIEWS
    //////////////////////////////////////////////////////////////*/

    function sourceCount() external view returns (uint256) {
        return _sources.length;
    }

    function sourceAt(uint256 i) external view returns (address pool, bool baseIsToken0) {
        return (address(_sources[i].pool), _sources[i].baseIsToken0);
    }

    /// @notice Per-source mean ticks and the resulting spread, for monitoring and alerting.
    /// @dev Surfaced because a widening spread is the leading indicator of both a
    ///      manipulation attempt and of one pool's liquidity drying up.
    function inspect(uint256 targetTimestamp, uint32 twapWindow)
        external
        view
        returns (int24[] memory ticks, bool[] memory available, uint256 spreadBps)
    {
        ticks = new int24[](_sources.length);
        available = new bool[](_sources.length);
        int24 low = type(int24).max;
        int24 high = type(int24).min;
        for (uint256 i = 0; i < _sources.length; i++) {
            (available[i], ticks[i]) = _sourceTick(_sources[i], targetTimestamp, twapWindow);
            if (!available[i]) continue;
            if (ticks[i] < low) low = ticks[i];
            if (ticks[i] > high) high = ticks[i];
        }
        spreadBps = high >= low ? _spreadBps(low, high) : 0;
    }

    /// @notice Aggregated observation state, in the same shape the single-pool adapter
    ///         reports so existing monitoring and the operations dashboard keep working.
    /// @dev Every field is the *most restrictive* across sources, because that is what
    ///      actually bounds the composite: it can only price as far back as its shortest
    ///      history, and can only answer for an instant every source has already sealed.
    ///      `index` is the first source's, which is meaningful only per pool — use
    ///      `inspect` or `sourceAt` when you need per-source detail.
    function observationState()
        external
        view
        returns (uint16 index, uint16 cardinality, uint16 cardinalityNext, uint256 oldest, uint256 newest)
    {
        cardinality = type(uint16).max;
        cardinalityNext = type(uint16).max;
        newest = type(uint256).max;

        for (uint256 i = 0; i < _sources.length; i++) {
            (,, uint16 idx, uint16 card, uint16 cardNext,,) = _sources[i].pool.slot0();
            if (i == 0) index = idx;
            if (card < cardinality) cardinality = card;
            if (cardNext < cardinalityNext) cardinalityNext = cardNext;

            (uint32 ts,,,) = _sources[i].pool.observations(idx);
            if (uint256(ts) < newest) newest = uint256(ts);

            uint256 e = _earliestOf(_sources[i].pool);
            if (e > oldest) oldest = e;
        }
        if (newest == type(uint256).max) newest = 0;
    }

    /// @notice Combined in-range liquidity across sources.
    /// @dev Summed rather than minimised: manipulating the composite means moving every
    ///      pool, so the depth an attacker faces is their total, not the shallowest.
    ///      Reported in the same shape as the single-pool adapter so monitoring that
    ///      alerts on falling liquidity needs no special case.
    function poolLiquidity() external view returns (uint128 total) {
        for (uint256 i = 0; i < _sources.length; i++) {
            total += _sources[i].pool.liquidity();
        }
    }

    /// @notice Per-source liquidity, so a single pool drying up is visible rather than
    ///         hidden inside the sum.
    function sourceLiquidity() external view returns (uint128[] memory liquidity) {
        liquidity = new uint128[](_sources.length);
        for (uint256 i = 0; i < _sources.length; i++) {
            liquidity[i] = _sources[i].pool.liquidity();
        }
    }

    /// @notice Instantaneous median across sources. **Display only — never settle on this.**
    function getSpotPrice() external view returns (uint256 price, int24 tick) {
        int24[] memory ticks = new int24[](_sources.length);
        for (uint256 i = 0; i < _sources.length; i++) {
            (, int24 t,,,,,) = _sources[i].pool.slot0();
            ticks[i] = _sources[i].baseIsToken0 ? t : -t;
        }
        int24 median = _median(ticks);
        tick = median;
        price = TickPriceMath.quoteAtTick(median, baseUnit, true);
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _priceAt(uint256 targetTimestamp, uint32 twapWindow)
        internal
        view
        returns (uint256 price, int24 medianTick)
    {
        if (twapWindow == 0) revert ZeroWindow();
        if (twapWindow > MAX_TWAP_WINDOW) revert WindowTooLong(twapWindow, MAX_TWAP_WINDOW);
        if (targetTimestamp > block.timestamp) revert TargetInFuture(targetTimestamp, block.timestamp);
        if (targetTimestamp < twapWindow) revert WindowStartUnderflow(targetTimestamp, twapWindow);

        int24[] memory ticks = new int24[](_sources.length);
        int24 low = type(int24).max;
        int24 high = type(int24).min;

        for (uint256 i = 0; i < _sources.length; i++) {
            (bool available, int24 tick) = _sourceTick(_sources[i], targetTimestamp, twapWindow);
            // Every source must answer. Silently dropping one would hand an attacker the
            // cheapest possible attack: stall a pool, then move the survivor alone.
            if (!available) revert SourceUnavailable(address(_sources[i].pool));
            ticks[i] = tick;
            if (tick < low) low = tick;
            if (tick > high) high = tick;
        }

        uint256 spread = _spreadBps(low, high);
        if (spread > maxDivergenceBps) revert SourcesDiverged(low, high, spread, maxDivergenceBps);

        medianTick = _median(ticks);
        // Ticks are normalised so the base token always behaves as token0, so the quote is
        // taken in that orientation regardless of each pool's own ordering.
        price = TickPriceMath.quoteAtTick(medianTick, baseUnit, true);
        if (price == 0) revert QuoteIsZero(medianTick);
    }

    /// @dev Returns the source's mean tick *normalised* so that a rising tick always means
    ///      a rising base-token price, whichever side of the pair the base token sits on.
    ///      Without that, mixing pools with opposite orderings would compare a price
    ///      against its own reciprocal and the divergence gate would be meaningless.
    function _sourceTick(Source storage source, uint256 targetTimestamp, uint32 twapWindow)
        internal
        view
        returns (bool available, int24 tick)
    {
        IUniswapV3PoolMinimal pool = source.pool;

        (,, uint16 index,,,,) = pool.slot0();
        (uint32 newest,,,) = pool.observations(index);
        // The sealing rule, per source. See UniswapV3PonsOracle for why this is required.
        if (uint256(newest) < targetTimestamp) return (false, 0);

        uint256 windowStart = targetTimestamp - twapWindow;
        if (windowStart < _earliestOf(pool)) return (false, 0);
        uint256 agoStart = block.timestamp - windowStart;
        if (agoStart > type(uint32).max) return (false, 0);

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = uint32(agoStart);
        secondsAgos[1] = uint32(block.timestamp - targetTimestamp);

        try pool.observe(secondsAgos) returns (int56[] memory cumulatives, uint160[] memory) {
            int24 raw = TickPriceMath.meanTick(cumulatives[1] - cumulatives[0], twapWindow);
            return (true, source.baseIsToken0 ? raw : -raw);
        } catch {
            return (false, 0);
        }
    }

    function _earliestOf(IUniswapV3PoolMinimal pool) internal view returns (uint256) {
        (,, uint16 index, uint16 cardinality,,,) = pool.slot0();
        uint256 oldestIndex = (uint256(index) + 1) % uint256(cardinality);
        (uint32 ts,,, bool initialized) = pool.observations(oldestIndex);
        if (!initialized) {
            (ts,,,) = pool.observations(0);
        }
        return uint256(ts);
    }

    function _newestCommonObservation() internal view returns (uint256 oldestNewest) {
        oldestNewest = type(uint256).max;
        for (uint256 i = 0; i < _sources.length; i++) {
            (,, uint16 index,,,,) = _sources[i].pool.slot0();
            (uint32 ts,,,) = _sources[i].pool.observations(index);
            if (uint256(ts) < oldestNewest) oldestNewest = uint256(ts);
        }
    }

    /// @dev One tick is one basis point of price to first order, so a tick difference is
    ///      already a basis-point spread and needs no price conversion.
    function _spreadBps(int24 low, int24 high) internal pure returns (uint256) {
        if (high <= low) return 0;
        return uint256(uint24(high - low));
    }

    /// @dev Insertion sort then middle. `_sources` is capped at MAX_SOURCES, so this is a
    ///      handful of comparisons rather than anything worth optimising.
    function _median(int24[] memory values) internal pure returns (int24) {
        uint256 n = values.length;
        for (uint256 i = 1; i < n; i++) {
            int24 key = values[i];
            uint256 j = i;
            while (j > 0 && values[j - 1] > key) {
                values[j] = values[j - 1];
                j--;
            }
            values[j] = key;
        }
        if (n % 2 == 1) return values[n / 2];
        // Even count: the midpoint, floored toward negative infinity so the rounding
        // direction does not flip with the sign of the tick.
        int24 a = values[n / 2 - 1];
        int24 b = values[n / 2];
        int256 sum = int256(a) + int256(b);
        return int24(sum >= 0 ? sum / 2 : (sum - 1) / 2);
    }

    function _u(uint256 v) private pure returns (string memory) {
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
