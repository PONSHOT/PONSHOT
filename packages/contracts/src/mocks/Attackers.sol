// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

interface IClaimTarget {
    function claim(uint256[] calldata epochs) external;
    function betBull(uint256 epoch) external payable;
    function betBear(uint256 epoch) external payable;
}

/// @notice Tries to re-enter `claim` from its ETH receive hook.
contract ReentrantClaimer {
    IClaimTarget public immutable target;
    uint256 public epoch;
    uint256 public reentryAttempts;
    bool public armed;

    constructor(address target_) {
        target = IClaimTarget(target_);
    }

    function bet(uint256 epoch_, bool bull) external payable {
        epoch = epoch_;
        if (bull) {
            target.betBull{value: msg.value}(epoch_);
        } else {
            target.betBear{value: msg.value}(epoch_);
        }
    }

    function arm() external {
        armed = true;
    }

    function doClaim() external {
        uint256[] memory e = new uint256[](1);
        e[0] = epoch;
        target.claim(e);
    }

    receive() external payable {
        if (!armed) return;
        reentryAttempts++;
        uint256[] memory e = new uint256[](1);
        e[0] = epoch;
        // Expected to fail: the guard plus the claimed flag both stand in the way.
        try target.claim(e) {} catch {}
    }
}

/// @notice Refuses ETH, to prove a hostile participant cannot block anyone else.
contract RejectingReceiver {
    IClaimTarget public immutable target;

    constructor(address target_) {
        target = IClaimTarget(target_);
    }

    function bet(uint256 epoch_, bool bull) external payable {
        if (bull) {
            target.betBull{value: msg.value}(epoch_);
        } else {
            target.betBear{value: msg.value}(epoch_);
        }
    }

    function doClaim(uint256 epoch_) external {
        uint256[] memory e = new uint256[](1);
        e[0] = epoch_;
        target.claim(e);
    }

    receive() external payable {
        revert("NOPE");
    }
}

/// @notice Forces ETH into the market without going through a bet.
contract ForceFeeder {
    constructor(address payable victim) payable {
        selfdestruct(victim);
    }
}
