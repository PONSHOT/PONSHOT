// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsAddresses} from "../../src/PonsAddresses.sol";
import {Test} from "forge-std/Test.sol";

/// @notice Keeps the Solidity and TypeScript views of chain 4663 from drifting apart.
/// @dev `packages/config/addresses.json` is the canonical source: TypeScript imports it
///      directly, and this test asserts `PonsAddresses.sol` agrees with it. Without this
///      the two mirrors could disagree silently, and a keeper or frontend would end up
///      watching a different pool from the one the contract settles on.
contract ConfigParityTest is Test {
    string internal json;

    function setUp() public {
        json = vm.readFile("../config/addresses.json");
    }

    function test_solidityMirrorMatchesCanonicalJson() public view {
        assertEq(vm.parseJsonUint(json, ".chainId"), PonsAddresses.CHAIN_ID, "chainId");
        assertEq(vm.parseJsonAddress(json, ".PONS"), PonsAddresses.PONS, "PONS");
        assertEq(vm.parseJsonAddress(json, ".WETH"), PonsAddresses.WETH, "WETH");
        assertEq(
            vm.parseJsonAddress(json, ".PONS_WETH_POOL_10000"), PonsAddresses.PONS_WETH_POOL_10000, "settlement pool"
        );
        assertEq(vm.parseJsonAddress(json, ".PONS_WETH_POOL_3000"), PonsAddresses.PONS_WETH_POOL_3000, "0.3% pool");
        assertEq(vm.parseJsonAddress(json, ".UNISWAP_V3_FACTORY"), PonsAddresses.UNISWAP_V3_FACTORY, "factory");
        assertEq(
            vm.parseJsonAddress(json, ".UNISWAP_V3_POSITION_MANAGER"),
            PonsAddresses.POSITION_MANAGER,
            "position manager"
        );
        assertEq(vm.parseJsonUint(json, ".poolFee"), PonsAddresses.POOL_FEE, "fee tier");
        assertEq(vm.parseJsonInt(json, ".poolTickSpacing"), int256(PonsAddresses.POOL_TICK_SPACING), "tick spacing");
        assertEq(vm.parseJsonUint(json, ".ponsDecimals"), PonsAddresses.PONS_DECIMALS, "PONS decimals");
        assertEq(vm.parseJsonUint(json, ".wethDecimals"), PonsAddresses.WETH_DECIMALS, "WETH decimals");
    }

    /// @dev Stated as its own assertion because it is the single fact most likely to be
    ///      assumed the other way, and getting it wrong inverts every round outcome.
    function test_ponsIsNotToken0() public view {
        assertFalse(vm.parseJsonBool(json, ".ponsIsToken0"), "PONS must be token1 in the settlement pool");
        assertTrue(PonsAddresses.PONS > PonsAddresses.WETH, "address ordering implies PONS is token1");
    }
}
