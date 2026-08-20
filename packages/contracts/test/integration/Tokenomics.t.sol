// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsBuybackBurner} from "../../src/PonsBuybackBurner.sol";
import {PonsPrediction} from "../../src/PonsPrediction.sol";
import {IPonsPredictionTypes} from "../../src/interfaces/IPonsPrediction.sol";
import {MockPredictionOracle} from "../../src/mocks/MockPredictionOracle.sol";
import {MockSwapPool} from "../../src/mocks/MockSwapPool.sol";
import {MockToken, MockWETH} from "../../src/mocks/MockToken.sol";
import {Test} from "forge-std/Test.sol";

/// @notice End-to-end proof of the launch tokenomics: a contested round pays 90% to the
///         winners and routes 10% into two buybacks, half each, which are then burned.
contract TokenomicsTest is Test, IPonsPredictionTypes {
    PonsPrediction internal market;
    PonsBuybackBurner internal burner;
    MockPredictionOracle internal oracle;
    MockWETH internal weth;
    MockToken internal pons;
    MockToken internal project;
    MockSwapPool internal ponsPool;
    MockSwapPool internal projectPool;

    address internal admin = makeAddr("admin");
    address internal operator = makeAddr("operator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    uint32 internal constant FEE_BPS = 1000; // 10%
    uint256 internal constant P0 = 1_400_000_000_000;

    function setUp() public {
        vm.warp(1_700_000_000);
        weth = new MockWETH();
        pons = new MockToken("Pons", "PONS", 18);
        project = new MockToken("Ponshot", "SHOT", 18);
        ponsPool = new MockSwapPool(address(weth), address(pons));
        projectPool = new MockSwapPool(address(weth), address(project));
        pons.mint(address(ponsPool), 1_000_000 ether);
        project.mint(address(projectPool), 1_000_000 ether);

        burner = new PonsBuybackBurner(
            address(weth),
            admin,
            PonsBuybackBurner.Target({
                token: address(pons),
                pool: address(ponsPool),
                wethIsToken0: false,
                shareBps: 5000,
                maxSlippageBps: 500,
                twapWindow: 300
            }),
            PonsBuybackBurner.Target({
                token: address(project),
                pool: address(projectPool),
                wethIsToken0: false,
                shareBps: 5000,
                maxSlippageBps: 500,
                twapWindow: 300
            })
        );

        oracle = new MockPredictionOracle();
        market = new PonsPrediction(
            PonsPrediction.InitParams({
                admin: admin,
                operator: operator,
                burner: address(burner),
                oracle: address(oracle),
                interval: 300,
                twapWindow: 60,
                bufferSeconds: 900,
                burnFeeBps: FEE_BPS,
                minimumBet: 0.001 ether,
                maximumBet: 100 ether,
                maximumRoundPool: 1000 ether
            })
        );
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.prank(operator);
        market.genesisStartRound();
    }

    /// @dev The headline number: winners take 90% of the whole pot, and the 10% that is
    ///      held back becomes burned supply of two tokens rather than protocol revenue.
    function test_contestedRoundPaysNinetyPercentAndBurnsTen() public {
        _bet(alice, true, 3 ether);
        _bet(bob, false, 7 ether);
        _run(P0, P0 + 1e9); // bulls win

        assertEq(market.burnAllocated(), 1 ether, "10% of the 10 ETH pot");

        uint256 before = alice.balance;
        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        vm.prank(alice);
        market.claim(e);
        assertEq(alice.balance - before, 9 ether, "the sole winner takes the other 90%");

        // Anyone may push the allocation to the burner; the keeper does it after settling.
        assertEq(market.sweepToBurner(), 1 ether);
        assertEq(address(burner).balance, 1 ether);
        assertEq(burner.allocated(0), 0.5 ether, "half buys PONS");
        assertEq(burner.allocated(1), 0.5 ether, "half buys the project token");

        burner.buyAndBurn(0, 0, 0);
        burner.buyAndBurn(1, 0, 0);
        assertEq(pons.balanceOf(DEAD), 0.5 ether);
        assertEq(project.balanceOf(DEAD), 0.5 ether);
        assertEq(address(burner).balance, 0, "nothing left behind");
    }

    /// @dev The client's stated rule for the case with no winners: every entry was on
    ///      the losing side, so the entire pot funds the buyback and burn.
    function test_roundWithNoWinnersBurnsTheWholePot() public {
        _bet(alice, true, 4 ether);
        _bet(bob, true, 6 ether); // both bullish
        _run(P0, P0 - 1e9); // price fell: everyone was wrong

        assertTrue(market.getRoundTerms(1).outcome == Outcome.AllLost);
        assertEq(market.burnAllocated(), 10 ether, "100% of the pot, not 10%");
        assertEq(market.claimable(1, alice), 0);
        assertEq(market.claimable(1, bob), 0);

        market.sweepToBurner();
        burner.buyAndBurn(0, 0, 0);
        burner.buyAndBurn(1, 0, 0);
        assertEq(pons.balanceOf(DEAD), 5 ether);
        assertEq(project.balanceOf(DEAD), 5 ether);

        (,, bool solvent) = market.solvency();
        assertTrue(solvent);
    }

    /// @dev The mirror case is unchanged and must stay that way: if nobody took the other
    ///      side, the entrants won nothing, so charging them 10% would be a penalty for
    ///      being right. They are refunded in full.
    function test_uncontestedWinningSideIsRefundedNotCharged() public {
        _bet(alice, true, 5 ether);
        _run(P0, P0 + 1e9); // bulls win, but there were no bears

        assertTrue(market.getRoundTerms(1).outcome == Outcome.NoContest);
        assertEq(market.burnAllocated(), 0, "no rake when nothing was won");
        assertEq(market.claimable(1, alice), 0, "nothing was won, so nothing is winnings");
        assertEq(market.refundable(1, alice), 5 ether, "the stake comes back whole");
    }

    /// @dev Settlement must not depend on the burner working. A burner that reverts on
    ///      receipt can stall its own sweep, never a round.
    function test_aBrokenBurnerCannotStallSettlement() public {
        address broken = address(new RejectsEth());
        vm.prank(admin);
        market.setBurner(broken);

        _bet(alice, true, 3 ether);
        _bet(bob, false, 7 ether);
        _run(P0, P0 + 1e9);

        assertTrue(market.getRoundTerms(1).outcome == Outcome.Bull, "round settled anyway");
        uint256[] memory e = new uint256[](1);
        e[0] = 1;
        uint256 before = alice.balance;
        vm.prank(alice);
        market.claim(e);
        assertEq(alice.balance - before, 9 ether, "winners are paid regardless");

        vm.expectRevert();
        market.sweepToBurner();
        assertEq(market.burnAllocated(), 1 ether, "the allocation is still booked");
    }

    function _bet(address who, bool bull, uint256 amount) private {
        vm.prank(who);
        if (bull) market.betBull{value: amount}(1);
        else market.betBear{value: amount}(1);
    }

    function _run(uint256 lockPrice, uint256 closePrice) private {
        Round memory r = market.getRound(1);
        vm.warp(r.lockTimestamp);
        oracle.setPrice(r.lockTimestamp, lockPrice);
        market.lockRound(1);
        vm.warp(r.closeTimestamp);
        oracle.setPrice(r.closeTimestamp, closePrice);
        market.settleRound(1);
    }

    receive() external payable {}
}

contract RejectsEth {
    receive() external payable {
        revert("no");
    }
}
