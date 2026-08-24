// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {PonsBuybackBurner} from "../../src/PonsBuybackBurner.sol";
import {MockSwapPool} from "../../src/mocks/MockSwapPool.sol";
import {MockToken, MockWETH} from "../../src/mocks/MockToken.sol";
import {Test} from "forge-std/Test.sol";

contract PonsBuybackBurnerTest is Test {
    PonsBuybackBurner internal burner;
    MockWETH internal weth;
    MockToken internal pons;
    MockToken internal project;
    MockSwapPool internal ponsPool;
    MockSwapPool internal projectPool;

    address internal admin = makeAddr("admin");
    address internal anyone = makeAddr("anyone");
    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        weth = new MockWETH();
        pons = new MockToken("Pons", "PONS", 18);
        project = new MockToken("Ponshot", "SHOT", 18);
        ponsPool = new MockSwapPool(address(weth), address(pons));
        projectPool = new MockSwapPool(address(weth), address(project));

        // Pools need inventory to pay out.
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
        vm.warp(10_000);
    }

    /// @dev The client's split: half of every ETH that arrives buys PONS, half buys the
    ///      project token. Splitting on arrival means the shares in force are the ones
    ///      configured when the money was earned, not whenever it is eventually spent.
    function test_fundingSplitsFiftyFifty() public {
        vm.deal(anyone, 10 ether);
        vm.prank(anyone);
        (bool ok,) = address(burner).call{value: 3 ether}("");
        assertTrue(ok);
        assertEq(burner.allocated(0), 1.5 ether);
        assertEq(burner.allocated(1), 1.5 ether);
    }

    /// @dev An odd wei cannot be split evenly; it must land somewhere rather than
    ///      becoming permanently unspendable dust.
    function test_oddWeiIsNotStranded() public {
        vm.deal(anyone, 1 ether);
        vm.prank(anyone);
        (bool ok,) = address(burner).call{value: 3}("");
        assertTrue(ok);
        assertEq(burner.allocated(0) + burner.allocated(1), 3);
    }

    function test_buyAndBurnSendsEverythingBoughtToTheBurnAddress() public {
        _fund(2 ether);
        uint256 burned = burner.buyAndBurn(0, 0, 0);

        assertEq(burned, 1 ether, "1:1 rate on a 1 ETH allocation");
        assertEq(pons.balanceOf(DEAD), 1 ether, "burned, not held");
        assertEq(pons.balanceOf(address(burner)), 0, "the burner keeps nothing");
        assertEq(burner.allocated(0), 0);
        assertEq(burner.totalBurned(0), 1 ether);
    }

    /// @dev The reason `buyAndBurn` can be left open to anyone: the caller cannot pick
    ///      the price. The floor comes from the pool's own TWAP, so a hostile caller
    ///      routing through a manipulated state simply reverts.
    function test_executionBelowTheTwapFloorReverts() public {
        _fund(2 ether);
        ponsPool.setRate(0.8e18); // 20% below the observed tick; tolerance is 5%

        vm.prank(anyone);
        vm.expectRevert(
            abi.encodeWithSelector(PonsBuybackBurner.BelowFloor.selector, uint256(0.8 ether), uint256(0.95 ether))
        );
        burner.buyAndBurn(0, 0, 0);
    }

    function test_executionWithinToleranceIsAccepted() public {
        _fund(2 ether);
        ponsPool.setRate(0.96e18); // inside the 5% tolerance
        vm.prank(anyone);
        assertEq(burner.buyAndBurn(0, 0, 0), 0.96 ether);
    }

    /// @dev A caller may demand better than the floor, never worse.
    function test_callerMinimumCanOnlyTighten() public {
        _fund(2 ether);
        vm.expectRevert(
            abi.encodeWithSelector(PonsBuybackBurner.BelowFloor.selector, uint256(1 ether), uint256(1.5 ether))
        );
        burner.buyAndBurn(0, 0, 1.5 ether);

        // A slack minimum does not loosen the on-chain floor.
        ponsPool.setRate(0.5e18);
        vm.expectRevert(
            abi.encodeWithSelector(PonsBuybackBurner.BelowFloor.selector, uint256(0.5 ether), uint256(0.95 ether))
        );
        burner.buyAndBurn(0, 0, 1);
    }

    function test_rateLimitCapsSpendPerWindow() public {
        vm.prank(admin);
        burner.setRateLimit(0.5 ether, 1 hours);
        _fund(4 ether);

        vm.expectRevert(
            abi.encodeWithSelector(PonsBuybackBurner.RateLimited.selector, uint256(2 ether), uint256(0.5 ether))
        );
        burner.buyAndBurn(0, 0, 0);

        burner.buyAndBurn(0, 0.5 ether, 0);
        vm.expectRevert(abi.encodeWithSelector(PonsBuybackBurner.RateLimited.selector, uint256(0.1 ether), uint256(0)));
        burner.buyAndBurn(0, 0.1 ether, 0);

        skip(1 hours);
        burner.buyAndBurn(0, 0.5 ether, 0);
        assertEq(burner.totalSpent(0), 1 ether);
    }

    function test_callbackRejectsUnexpectedCaller() public {
        vm.prank(anyone);
        vm.expectRevert(abi.encodeWithSelector(PonsBuybackBurner.UnexpectedCallback.selector, anyone));
        burner.uniswapV3SwapCallback(1, -1, abi.encode(address(ponsPool)));
    }

    /// @dev Until the project token exists its half accrues untouched. It must not
    ///      silently roll into the PONS side: that would change the tokenomics without
    ///      anyone deciding to.
    function test_unconfiguredTargetHoldsItsShareRatherThanRedirectingIt() public {
        PonsBuybackBurner fresh = new PonsBuybackBurner(
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
                token: address(0),
                pool: address(0),
                wethIsToken0: false,
                shareBps: 5000,
                maxSlippageBps: 500,
                twapWindow: 300
            })
        );
        vm.deal(anyone, 4 ether);
        vm.prank(anyone);
        (bool ok,) = address(fresh).call{value: 4 ether}("");
        assertTrue(ok);

        assertEq(fresh.allocated(0), 2 ether);
        assertEq(fresh.allocated(1), 2 ether, "held, not redirected");
        vm.expectRevert(abi.encodeWithSelector(PonsBuybackBurner.TargetNotConfigured.selector, uint8(1)));
        fresh.buyAndBurn(1, 0, 0);

        // Once the token and its pool exist, the accrued half becomes spendable.
        vm.prank(admin);
        fresh.setTarget(1, address(project), address(projectPool), 500, 300);
        assertEq(fresh.buyAndBurn(1, 0, 0), 2 ether);
        assertEq(project.balanceOf(DEAD), 2 ether);
    }

    function test_targetPoolMustActuallyHoldThePair() public {
        MockToken other = new MockToken("Other", "OTH", 18);
        MockSwapPool wrongPool = new MockSwapPool(address(weth), address(other));
        vm.prank(admin);
        vm.expectRevert(PonsBuybackBurner.PoolTokenMismatch.selector);
        burner.setTarget(1, address(project), address(wrongPool), 500, 300);
    }

    function test_configIsRoleGated() public {
        vm.prank(anyone);
        vm.expectRevert();
        burner.setTarget(1, address(project), address(projectPool), 500, 300);
        vm.prank(anyone);
        vm.expectRevert();
        burner.setRateLimit(1 ether, 1 hours);
    }

    function test_slippageToleranceIsBounded() public {
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(PonsBuybackBurner.SlippageTooLoose.selector, uint16(1001)));
        burner.setTarget(0, address(pons), address(ponsPool), 1001, 300);
    }

    function _fund(uint256 amount) private {
        vm.deal(address(this), amount);
        (bool ok,) = address(burner).call{value: amount}("");
        assertTrue(ok);
    }

    receive() external payable {}
}
