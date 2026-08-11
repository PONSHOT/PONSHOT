// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @title PonsAddresses
/// @notice Verified Robinhood Chain (4663) production addresses.
/// @dev Every value here was read back from chain 4663 before it was written down —
///      see docs/PONS_MARKET.md for the audit transcript. Nothing in this file is
///      taken on faith from a spec document. Solidity-side mirror of
///      `packages/config/src/robinhood.ts`; `test/fork/ConfigParity.t.sol` fails if
///      the two ever drift apart.
library PonsAddresses {
    uint256 internal constant CHAIN_ID = 4663;

    /// @dev ERC-20, 18 decimals, fixed supply 1e27. Launch restrictions long expired.
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;

    /// @dev Canonical wrapped native asset, 18 decimals.
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    /// @dev Uniswap V3 1% pool. token0 = WETH, token1 = PONS. Confirmed canonical by
    ///      the factory *and* by PONS's own `liquidityPool()`.
    address internal constant PONS_WETH_POOL_10000 = 0x10CC6BD38112cAc182db90B6a71d8Bb5939526bA;

    /// @dev The other live PONS/WETH pool (0.3%). Shallower and with a far smaller
    ///      observation buffer; recorded because it matters to the manipulation model,
    ///      not because it is used as a price source.
    address internal constant PONS_WETH_POOL_3000 = 0xEd50bDeeA8aDC232f159486192a4157281D722ff;

    address internal constant UNISWAP_V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant POSITION_MANAGER = 0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3;

    uint24 internal constant POOL_FEE = 10_000;
    int24 internal constant POOL_TICK_SPACING = 200;
    uint8 internal constant PONS_DECIMALS = 18;
    uint8 internal constant WETH_DECIMALS = 18;
}
