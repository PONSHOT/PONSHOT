// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsPrediction} from "../src/PonsPrediction.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockUniswapV3Pool} from "../src/mocks/MockUniswapV3Pool.sol";
import {CompositePonsOracle} from "../src/oracle/CompositePonsOracle.sol";
import {Script, console2} from "forge-std/Script.sol";

/// @notice Stands up the whole system on a local Anvil: mock PONS and WETH, a mock pool
///         with genuine Uniswap oracle semantics, the real oracle adapter, and the market.
/// @dev The mock pool deliberately keeps the live ordering (WETH as token0, PONS as
///      token1). Developing against the easy ordering and deploying against the real one
///      is how a sign error reaches production.
contract DeployLocal is Script {
    function run() external {
        uint256 pk = vm.envOr(
            "DEPLOYER_PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
        );
        address deployer = vm.addr(pk);
        address operator = vm.envOr("OPERATOR_ADDRESS", deployer);

        vm.startBroadcast(pk);

        MockERC20 weth = new MockERC20("Wrapped Ether", "WETH", 18);
        MockERC20 pons = new MockERC20("Pons", "PONS", 18);
        int24 startTick = 84_400; // approximately the live PONS/WETH tick
        // Two pools, mirroring production: the market settles on a composite that requires
        // them to agree, so the local stack must exercise that path rather than a simpler
        // one which would hide the divergence gate entirely.
        MockUniswapV3Pool pool = new MockUniswapV3Pool(address(weth), address(pons), 10_000, startTick);
        MockUniswapV3Pool poolB = new MockUniswapV3Pool(address(weth), address(pons), 3000, startTick);
        // Growing the ring buffer costs a cold SSTORE per slot (~20k gas each), so 4096
        // slots would not fit in one block. 512 is far more than a local demo needs and
        // still leaves room for hours of simulated history.
        pool.increaseObservationCardinalityNext(512);
        poolB.increaseObservationCardinalityNext(512);

        address[] memory pools = new address[](2);
        pools[0] = address(pool);
        pools[1] = address(poolB);
        CompositePonsOracle oracle = new CompositePonsOracle(pools, address(pons), address(weth), 18, 60, 100, 1);

        PonsPrediction market = new PonsPrediction(
            PonsPrediction.InitParams({
                admin: deployer,
                operator: operator,
                treasury: deployer,
                oracle: address(oracle),
                interval: uint32(vm.envOr("ROUND_INTERVAL", uint256(300))),
                twapWindow: 60,
                bufferSeconds: 900,
                treasuryFeeBps: 300,
                minimumBet: 0.001 ether,
                maximumBet: 100 ether,
                maximumRoundPool: 1000 ether
            })
        );

        vm.stopBroadcast();

        console2.log("WETH   ", address(weth));
        console2.log("PONS   ", address(pons));
        console2.log("pool   ", address(pool));
        console2.log("poolB  ", address(poolB));
        console2.log("oracle ", address(oracle));
        console2.log("market ", address(market));

        string memory obj = "local";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "PonsPrediction", address(market));
        vm.serializeAddress(obj, "PonsOracleAdapter", address(oracle));
        vm.serializeAddress(obj, "PONS", address(pons));
        vm.serializeAddress(obj, "WETH", address(weth));
        vm.serializeAddress(obj, "PONSWETHPool", address(pool));
        vm.serializeAddress(obj, "PONSWETHPoolSecond", address(poolB));
        vm.serializeUint(obj, "twapWindow", 60);
        vm.serializeUint(obj, "bufferSeconds", 900);
        vm.serializeUint(obj, "treasuryFeeBps", 300);
        vm.serializeUint(obj, "deployedAtBlock", block.number);
        string memory out = vm.serializeUint(obj, "roundInterval", vm.envOr("ROUND_INTERVAL", uint256(300)));
        vm.writeJson(out, string.concat("../../deployments/", vm.toString(block.chainid), ".json"));
        console2.log("wrote deployments/", vm.toString(block.chainid));
    }
}
