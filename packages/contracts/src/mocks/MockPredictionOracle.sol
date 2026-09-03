// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IPredictionOracle} from "../interfaces/IPredictionOracle.sol";

/// @notice Programmable oracle used to drive the market's own tests.
/// @dev Lets a test say "the price at instant T is P" or "instant T is unavailable"
///      without building a whole pool history, and can be made to revert or to burn
///      gas so the market's failure handling is exercised directly.
contract MockPredictionOracle is IPredictionOracle {
    mapping(uint256 instant => uint256) public priceAt;
    mapping(uint256 instant => bool) public available;

    uint64 public version = 1;
    bool public revertEverything;
    bool public revertOnCanQuote;
    bool public burnGas;
    uint256 public earliest;

    function setPrice(uint256 instant, uint256 price) external {
        priceAt[instant] = price;
        available[instant] = true;
    }

    function setUnavailable(uint256 instant) external {
        available[instant] = false;
    }

    function setRevertEverything(bool v) external {
        revertEverything = v;
    }

    function setRevertOnCanQuote(bool v) external {
        revertOnCanQuote = v;
    }

    function setBurnGas(bool v) external {
        burnGas = v;
    }

    function setVersion(uint64 v) external {
        version = v;
    }

    function description() external pure returns (string memory) {
        return "mock";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    /// @dev Honours `revertEverything` too. A "broken oracle" that still answered metadata
    ///      calls would under-model the failure and quietly hide any liveness coupling the
    ///      market has on those reads.
    function oracleVersion() external view returns (uint64) {
        if (revertEverything) revert("ORACLE_DOWN");
        return version;
    }

    function earliestAvailableTimestamp() external view returns (uint256) {
        return earliest;
    }

    function getPrice() external view returns (uint256, uint256) {
        return (priceAt[block.timestamp], block.timestamp);
    }

    function getPriceAt(uint256 instant, uint32) external view returns (uint256 price, int24 meanTick) {
        if (revertEverything) revert("ORACLE_DOWN");
        if (burnGas) {
            uint256 x;
            for (uint256 i = 0; i < 1_000_000; i++) {
                x += i;
            }
            price = x;
        }
        if (!available[instant]) revert("NOT_SEALED");
        return (priceAt[instant], int24(0));
    }

    function canQuote(uint256 instant, uint32) external view returns (bool, string memory) {
        if (revertOnCanQuote) revert("ORACLE_DOWN");
        if (revertEverything) revert("ORACLE_DOWN");
        return available[instant] ? (true, "") : (false, "TARGET_NOT_SEALED");
    }
}
