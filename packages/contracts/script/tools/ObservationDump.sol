// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {IUniswapV3PoolMinimal} from "../../src/interfaces/IUniswapV3PoolMinimal.sol";

/// @notice Deployless reader: the constructor returns a slice of the pool's observation
///         ring buffer, so auditing a 20k-slot buffer costs a handful of `eth_call`s
///         instead of 20k of them. Never deployed; used via `cast call --create`.
///         Sliced rather than whole because public RPCs cap `eth_call` gas.
contract ObservationDump {
    constructor(address poolAddr, uint256 start, uint256 count) {
        IUniswapV3PoolMinimal pool = IUniswapV3PoolMinimal(poolAddr);
        (, int24 tick, uint16 index, uint16 cardinality,,,) = pool.slot0();

        if (start + count > cardinality) {
            count = start >= cardinality ? 0 : cardinality - start;
        }

        uint32[] memory ts = new uint32[](count);
        int56[] memory tc = new int56[](count);
        bool[] memory init = new bool[](count);
        for (uint256 i = 0; i < count; i++) {
            (ts[i], tc[i],, init[i]) = pool.observations(start + i);
        }

        bytes memory out = abi.encode(tick, index, cardinality, ts, tc, init);
        assembly {
            return(add(out, 0x20), mload(out))
        }
    }
}
