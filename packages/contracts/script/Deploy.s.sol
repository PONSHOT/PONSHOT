// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsAddresses} from "../src/PonsAddresses.sol";
import {PonsBuybackBurner} from "../src/PonsBuybackBurner.sol";
import {PonsPrediction} from "../src/PonsPrediction.sol";
import {IPredictionOracle} from "../src/interfaces/IPredictionOracle.sol";
import {IUniswapV3FactoryMinimal, IUniswapV3PoolMinimal} from "../src/interfaces/IUniswapV3PoolMinimal.sol";
import {CompositePonsOracle} from "../src/oracle/CompositePonsOracle.sol";
import {UniswapV3PonsOracle} from "../src/oracle/UniswapV3PonsOracle.sol";
import {Script, VmSafe, console2} from "forge-std/Script.sol";

interface IERC20Meta {
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/// @notice Deploys the oracle adapter and the market, then writes the addresses to
///         `deployments/<chainId>.json` so nothing downstream hand-copies them.
///
/// @dev Every assumption is re-checked against the live chain *before* anything is
///      deployed. That ordering is deliberate: a wrong pool or a flipped token order
///      would produce a market that looks healthy and settles backwards, so the script
///      refuses to proceed rather than emitting a plausible-looking deployment.
///
///      Usage:
///        forge script script/Deploy.s.sol:Deploy --rpc-url $ROBINHOOD_RPC \
///          --private-key $PK --broadcast
contract Deploy is Script {
    struct Config {
        address admin;
        address operator;
        address burner;
        address pool;
        address pons;
        address weth;
        uint32 interval;
        uint32 twapWindow;
        uint32 bufferSeconds;
        uint32 burnFeeBps;
        address secondPool;
        uint256 maxDivergenceBps;
        bool allowSingleSourceOracle;
        bool allowEoaAdmin;
        uint256 minimumBet;
        uint256 maximumBet;
        uint256 maximumRoundPool;
        uint64 oracleVersion;
        // Buyback and burn. `projectToken`/`projectPool` may be zero before the project
        // token exists; that half of the allocation then accrues in the burner untouched
        // rather than silently rolling into the PONS side.
        address projectToken;
        address projectPool;
        uint16 burnSharePonsBps;
        uint16 burnMaxSlippageBps;
        uint32 burnTwapWindow;
    }

    function run() external {
        Config memory c = _config();
        _preflight(c);

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        _rejectWellKnownKey(pk);
        vm.startBroadcast(pk);

        // Composite by default. A single source is only as expensive to manipulate as the
        // shallowest pool behind it; measured on the live pools the composite costs a
        // tuned attacker 1.83x more per basis point, and makes an untuned attack worthless.
        // See docs/MANIPULATION_ANALYSIS.md.
        address oracleAddr;
        if (c.allowSingleSourceOracle) {
            oracleAddr = address(
                new UniswapV3PonsOracle({
                    pool_: c.pool,
                    baseToken_: c.pons,
                    quoteToken_: c.weth,
                    baseDecimals_: IERC20Meta(c.pons).decimals(),
                    defaultTwapWindow_: c.twapWindow,
                    oracleVersion_: c.oracleVersion
                })
            );
        } else {
            address[] memory pools = new address[](2);
            pools[0] = c.pool;
            pools[1] = c.secondPool;
            oracleAddr = address(
                new CompositePonsOracle({
                    pools: pools,
                    baseToken_: c.pons,
                    quoteToken_: c.weth,
                    baseDecimals_: IERC20Meta(c.pons).decimals(),
                    defaultTwapWindow_: c.twapWindow,
                    maxDivergenceBps_: c.maxDivergenceBps,
                    oracleVersion_: c.oracleVersion
                })
            );
        }

        // The market books its fee and a separate transaction pushes it here. The burner
        // is deployed first so the market can be constructed already pointing at it: a
        // market that starts life pointing somewhere else would accrue burn allocation
        // that has to be re-aimed by an admin call, and that window is worth not having.
        PonsBuybackBurner burner = new PonsBuybackBurner({
            weth_: c.weth,
            admin: c.admin,
            pons: PonsBuybackBurner.Target({
                token: c.pons,
                pool: c.pool,
                wethIsToken0: false, // set from the pool inside the constructor
                shareBps: c.burnSharePonsBps,
                maxSlippageBps: c.burnMaxSlippageBps,
                twapWindow: c.burnTwapWindow
            }),
            project: PonsBuybackBurner.Target({
                token: c.projectToken,
                pool: c.projectPool,
                wethIsToken0: false,
                shareBps: uint16(10_000 - c.burnSharePonsBps),
                maxSlippageBps: c.burnMaxSlippageBps,
                twapWindow: c.burnTwapWindow
            })
        });
        c.burner = address(burner);

        PonsPrediction market = new PonsPrediction(
            PonsPrediction.InitParams({
                admin: c.admin,
                operator: c.operator,
                burner: c.burner,
                oracle: oracleAddr,
                interval: c.interval,
                twapWindow: c.twapWindow,
                bufferSeconds: c.bufferSeconds,
                burnFeeBps: c.burnFeeBps,
                minimumBet: c.minimumBet,
                maximumBet: c.maximumBet,
                maximumRoundPool: c.maximumRoundPool
            })
        );

        vm.stopBroadcast();

        _postflight(c, oracleAddr, market);
        _write(c, oracleAddr, address(market));
    }

    /// @dev Anvil and Hardhat ship the same funded accounts, and their keys are printed on
    ///      every start. They appear throughout this repo's local tooling, which is exactly
    ///      the risk: one copied command is all it takes for a public key to own a live
    ///      market's admin role. Cheap to check, catastrophic to miss.
    /// @dev `code.length > 0` is **not** a test for "is a contract" on a chain that
    ///      supports EIP-7702. A delegated EOA carries exactly 23 bytes of code —
    ///      `0xef0100` followed by the address it delegates to — while remaining
    ///      controlled by a single private key. This is not hypothetical here: Anvil's
    ///      first account already has such a delegation on chain 4663, so the naive check
    ///      waved it through as a multisig.
    function _isContract(address account) internal view returns (bool) {
        uint256 size = account.code.length;
        if (size == 0) return false;
        if (size == 23) {
            bytes memory code = account.code;
            if (code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00) return false;
        }
        return true;
    }

    function _rejectWellKnownKey(uint256 pk) internal pure {
        uint256[4] memory wellKnown = [
            0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80,
            0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d,
            0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a,
            0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
        ];
        for (uint256 i = 0; i < wellKnown.length; i++) {
            require(pk != wellKnown[i], "DEPLOYER_PRIVATE_KEY is a public development key");
        }
    }

    function _config() internal view returns (Config memory c) {
        c.admin = vm.envAddress("ADMIN_ADDRESS");
        c.operator = vm.envAddress("OPERATOR_ADDRESS");
        c.projectToken = vm.envOr("PROJECT_TOKEN", address(0));
        c.projectPool = vm.envOr("PROJECT_POOL", address(0));
        c.burnSharePonsBps = uint16(vm.envOr("BURN_SHARE_PONS_BPS", uint256(5000)));
        c.burnMaxSlippageBps = uint16(vm.envOr("BURN_MAX_SLIPPAGE_BPS", uint256(500)));
        c.burnTwapWindow = uint32(vm.envOr("BURN_TWAP_WINDOW", uint256(300)));
        c.pool = vm.envOr("PONS_POOL", PonsAddresses.PONS_WETH_POOL_10000);
        c.secondPool = vm.envOr("PONS_POOL_SECOND", PonsAddresses.PONS_WETH_POOL_3000);
        c.maxDivergenceBps = vm.envOr("MAX_DIVERGENCE_BPS", uint256(100));
        // Both escape hatches default to off: a weaker deployment must be asked for
        // explicitly, never reached by forgetting to set something.
        c.allowSingleSourceOracle = vm.envOr("ALLOW_SINGLE_SOURCE_ORACLE", false);
        c.allowEoaAdmin = vm.envOr("ALLOW_EOA_ADMIN", false);
        c.pons = vm.envOr("PONS_TOKEN", PonsAddresses.PONS);
        c.weth = vm.envOr("WETH_TOKEN", PonsAddresses.WETH);
        c.interval = uint32(vm.envOr("ROUND_INTERVAL", uint256(300)));
        c.twapWindow = uint32(vm.envOr("TWAP_WINDOW", uint256(300)));
        c.bufferSeconds = uint32(vm.envOr("BUFFER_SECONDS", uint256(1800)));
        c.burnFeeBps = uint32(vm.envOr("BURN_FEE_BPS", uint256(1000)));
        c.minimumBet = vm.envOr("MINIMUM_BET", uint256(0.001 ether));
        c.maximumBet = vm.envOr("MAXIMUM_BET", uint256(0.5 ether));
        c.maximumRoundPool = vm.envOr("MAXIMUM_ROUND_POOL", uint256(2 ether));
        c.oracleVersion = uint64(vm.envOr("ORACLE_VERSION", uint256(1)));
    }

    /// @dev Refuses to deploy against a chain that does not match what was audited.
    function _preflight(Config memory c) internal view {
        console2.log("=== preflight on chain", block.chainid, "===");
        require(c.admin != address(0) && c.operator != address(0), "roles unset");
        require(c.burnSharePonsBps <= 10_000, "burn share out of range");
        if (c.projectToken == address(0) || c.projectPool == address(0)) {
            // Not fatal: the project half accrues until the token and its pool exist.
            // Loud, because launching without it is a decision, not a default.
            console2.log("WARNING: project token/pool unset - its share of the burn will accrue unspent");
            require(
                c.projectToken == address(0) && c.projectPool == address(0),
                "set both PROJECT_TOKEN and PROJECT_POOL, or neither"
            );
        } else {
            require(c.projectToken.code.length > 0, "PROJECT_TOKEN has no code");
            require(c.projectPool.code.length > 0, "PROJECT_POOL has no code");
        }
        require(c.pons.code.length > 0, "PONS has no code");
        require(c.weth.code.length > 0, "WETH has no code");
        require(c.pool.code.length > 0, "pool has no code");

        IUniswapV3PoolMinimal pool = IUniswapV3PoolMinimal(c.pool);
        address t0 = pool.token0();
        address t1 = pool.token1();
        require(
            (t0 == c.weth && t1 == c.pons) || (t0 == c.pons && t1 == c.weth), "pool does not hold the expected pair"
        );
        console2.log("token0", t0);
        console2.log("token1", t1);
        console2.log("PONS is token0:", t0 == c.pons);

        // The pool must be the one the factory registers for this exact triple, so a
        // look-alike pool with the same tokens cannot be substituted.
        require(
            IUniswapV3FactoryMinimal(pool.factory()).getPool(t0, t1, pool.fee()) == c.pool,
            "pool is not the factory's registered pool"
        );

        require(pool.liquidity() > 0, "pool has no in-range liquidity");

        (,,, uint16 cardinality,,,) = pool.slot0();
        require(cardinality > 1, "observation buffer never grown; TWAP unusable");
        console2.log("observationCardinality", cardinality);

        // The TWAP the market will ask for must already be serviceable. Deploying a
        // market whose configured window cannot be computed is exactly the failure the
        // brief calls out, so it is a hard stop rather than a warning.
        uint32[] memory agos = new uint32[](2);
        agos[0] = c.twapWindow + 5;
        agos[1] = 5;
        pool.observe(agos);
        console2.log("TWAP window serviceable:", c.twapWindow);

        require(IERC20Meta(c.pons).decimals() == 18, "unexpected PONS decimals");

        // The admin role can withdraw accrued fees, rotate the keeper and reconfigure
        // future rounds. Behind a single key that is one compromised laptop away from all
        // of it, so a contract (multisig, timelock) is required unless explicitly waived.
        if (!c.allowEoaAdmin) {
            require(_isContract(c.admin), "ADMIN_ADDRESS is not a contract; use a multisig or set ALLOW_EOA_ADMIN=true");
        }

        if (!c.allowSingleSourceOracle) {
            require(c.secondPool != address(0) && c.secondPool.code.length > 0, "second pool has no code");
            require(c.secondPool != c.pool, "second pool must differ from the first");
            IUniswapV3PoolMinimal p2 = IUniswapV3PoolMinimal(c.secondPool);
            address s0 = p2.token0();
            address s1 = p2.token1();
            require(
                (s0 == c.weth && s1 == c.pons) || (s0 == c.pons && s1 == c.weth),
                "second pool does not hold the expected pair"
            );
            require(p2.liquidity() > 0, "second pool has no in-range liquidity");
            (,,, uint16 card2,,,) = p2.slot0();
            require(card2 > 1, "second pool observation buffer never grown");
            // The composite is bounded by its shortest history, so prove the window is
            // serviceable on the second pool too rather than discovering it at settlement.
            uint32[] memory agos2 = new uint32[](2);
            agos2[0] = c.twapWindow + 5;
            agos2[1] = 5;
            p2.observe(agos2);
            console2.log("second pool serviceable, cardinality", card2);
        }
        require(c.burnFeeBps <= 500, "fee above the contract ceiling");
        require(c.twapWindow <= c.interval, "TWAP window longer than the round; close windows would overlap");
    }

    /// @dev Reads the deployed system back and proves it produces a sane live price
    ///      before the addresses are ever written down.
    function _postflight(Config memory c, address oracleAddr, PonsPrediction market) internal view {
        IPredictionOracle oracle = IPredictionOracle(oracleAddr);
        require(address(market.oracle()) == oracleAddr, "market points elsewhere");
        require(market.hasRole(market.DEFAULT_ADMIN_ROLE(), c.admin), "admin role missing");
        require(market.hasRole(market.OPERATOR_ROLE(), c.operator), "operator role missing");

        (uint256 price, uint256 asOf) = oracle.getPrice();
        require(price > 0, "oracle returned no price");
        console2.log("oracle  ", oracle.description());
        console2.log("live PONS price (wei WETH per PONS)", price);
        console2.log("as of", asOf);
        console2.log("oracle  ", oracleAddr);
        console2.log("market  ", address(market));
    }

    function _write(Config memory c, address oracle, address market) internal {
        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "PonsPrediction", market);
        vm.serializeAddress(obj, "PonsOracleAdapter", oracle);
        vm.serializeAddress(obj, "PONSWETHPoolSecond", c.secondPool);
        vm.serializeAddress(obj, "PONS", c.pons);
        vm.serializeAddress(obj, "WETH", c.weth);
        vm.serializeAddress(obj, "PONSWETHPool", c.pool);
        vm.serializeUint(obj, "roundInterval", c.interval);
        vm.serializeUint(obj, "twapWindow", c.twapWindow);
        vm.serializeUint(obj, "bufferSeconds", c.bufferSeconds);
        vm.serializeUint(obj, "burnFeeBps", c.burnFeeBps);
        vm.serializeAddress(obj, "PonsBuybackBurner", c.burner);
        vm.serializeAddress(obj, "projectToken", c.projectToken);
        vm.serializeAddress(obj, "projectPool", c.projectPool);
        vm.serializeUint(obj, "burnSharePonsBps", c.burnSharePonsBps);
        vm.serializeUint(obj, "deployedAtBlock", block.number);
        string memory out = vm.serializeUint(obj, "deployedAt", block.timestamp);

        string memory path = string.concat("../../deployments/", vm.toString(block.chainid), ".json");

        // Only write when the transactions are actually being broadcast. A simulation
        // deploys into an in-memory state and produces perfectly plausible addresses that
        // exist nowhere — writing those leaves a deployment file pointing at nothing, and
        // every service that reads it (keeper, indexer, API, the frontend build) would
        // silently target a contract that was never created.
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            console2.log("dry run: NOT writing", path);
            console2.log("  re-run with --broadcast to deploy and record the addresses");
            return;
        }

        vm.writeJson(out, path);
        console2.log("wrote", path);
    }
}
