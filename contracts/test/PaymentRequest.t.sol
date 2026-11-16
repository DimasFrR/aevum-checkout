// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PaymentRequest} from "../src/PaymentRequest.sol";
import {MockUSD8} from "../src/mocks/MockUSD8.sol";
import {Signing} from "./Signing.sol";

contract PaymentRequestTest is Test {
    MockUSD8 token;
    PaymentRequest pr;
    address merchant = makeAddr("merchant");
    address buyer;
    uint256 buyerKey;
    address relayer = makeAddr("relayer");

    bytes32 constant REQUEST = keccak256("request-1");
    uint256 constant PRICE = 5e6; // 5 tUSD8

    function setUp() public {
        (buyer, buyerKey) = makeAddrAndKey("buyer");
        token = new MockUSD8();
        pr = new PaymentRequest(IERC20(address(token)));
        token.mint(buyer, 100e6);
    }

    function _create() internal {
        vm.prank(merchant);
        pr.createRequest(REQUEST, PRICE, "Coffee order #1");
    }

    // ---------- createRequest ----------

    function test_createRequest_storesFields() public {
        vm.expectEmit(true, true, false, true, address(pr));
        emit PaymentRequest.RequestCreated(REQUEST, merchant, PRICE, "Coffee order #1");
        _create();

        PaymentRequest.Request memory r = pr.requestOf(REQUEST);
        assertEq(r.merchant, merchant);
        assertEq(r.amount, PRICE);
        assertEq(r.memo, "Coffee order #1");
        assertEq(r.createdAt, block.timestamp);
        assertFalse(r.paid);
        assertEq(r.payer, address(0));
        assertEq(r.paidAt, 0);
        assertFalse(pr.isPaid(REQUEST));
    }

    function test_createRequest_revertsOnZeroAmount() public {
        vm.prank(merchant);
        vm.expectRevert(PaymentRequest.ZeroAmount.selector);
        pr.createRequest(REQUEST, 0, "free");
    }

    function test_createRequest_revertsOnDuplicateId() public {
        _create();
        vm.prank(merchant);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.RequestExists.selector, REQUEST));
        pr.createRequest(REQUEST, PRICE, "again");
    }

    // ---------- pay (approve + call) ----------

    function test_pay_movesExactAmountToMerchant() public {
        _create();
        vm.startPrank(buyer);
        token.approve(address(pr), PRICE);
        vm.expectEmit(true, true, false, true, address(pr));
        emit PaymentRequest.Paid(REQUEST, buyer, PRICE);
        pr.pay(REQUEST);
        vm.stopPrank();

        assertEq(token.balanceOf(merchant), PRICE);
        assertEq(token.balanceOf(address(pr)), 0);
        assertTrue(pr.isPaid(REQUEST));
        PaymentRequest.Request memory r = pr.requestOf(REQUEST);
        assertEq(r.payer, buyer);
        assertEq(r.amount, PRICE);
        assertEq(r.paidAt, block.timestamp);
    }

    function test_pay_revertsOnSecondPayment() public {
        _create();
        vm.startPrank(buyer);
        token.approve(address(pr), 2 * PRICE);
        pr.pay(REQUEST);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.AlreadyPaid.selector, REQUEST));
        pr.pay(REQUEST);
        vm.stopPrank();
    }

    function test_pay_revertsOnUnknownRequest() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.UnknownRequest.selector, REQUEST));
        pr.pay(REQUEST);
    }

    function test_pay_revertsWithoutApproval() public {
        _create();
        vm.prank(buyer);
        vm.expectRevert();
        pr.pay(REQUEST);
        assertFalse(pr.isPaid(REQUEST));
    }

    function test_pay_dustApprovalCannotMarkPaid() public {
        // The kit's Checkout flaw: pay(orderId, 1) marks an order paid for dust.
        // PaymentRequest has no amount parameter, so a 1-wei approval cannot settle it.
        _create();
        vm.startPrank(buyer);
        token.approve(address(pr), 1);
        vm.expectRevert();
        pr.pay(REQUEST);
        vm.stopPrank();
        assertFalse(pr.isPaid(REQUEST));
        assertEq(token.balanceOf(merchant), 0);
    }

    // ---------- payWithAuthorization (EIP-3009, gasless for the buyer) ----------

    function _sign(bytes32 requestId, uint256 value, uint256 validBefore)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        Signing.Auth memory a = Signing.Auth({
            from: buyer,
            to: address(pr),
            value: value,
            validAfter: 0,
            validBefore: validBefore,
            nonce: pr.authorizationNonce(requestId)
        });
        return Signing.signReceive(vm, buyerKey, token.DOMAIN_SEPARATOR(), a);
    }

    function test_payWithAuthorization_relayerSubmits() public {
        _create();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(REQUEST, PRICE, deadline);

        vm.prank(relayer); // the buyer never sends a transaction
        pr.payWithAuthorization(REQUEST, buyer, 0, deadline, v, r, s);

        assertEq(token.balanceOf(merchant), PRICE);
        assertEq(token.balanceOf(buyer), 95e6);
        assertEq(pr.requestOf(REQUEST).payer, buyer);
        assertTrue(pr.isPaid(REQUEST));
    }

    function test_payWithAuthorization_signatureIsBoundToRequest() public {
        _create();
        bytes32 otherRequest = keccak256("request-2");
        vm.prank(merchant);
        pr.createRequest(otherRequest, PRICE, "other");
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(REQUEST, PRICE, deadline);

        // Same signature, different request id: the nonce no longer matches, so it fails.
        vm.prank(relayer);
        vm.expectRevert(MockUSD8.InvalidSignature.selector);
        pr.payWithAuthorization(otherRequest, buyer, 0, deadline, v, r, s);
    }

    function test_payWithAuthorization_cannotChangeAmount() public {
        _create();
        uint256 deadline = block.timestamp + 1 hours;
        // Buyer signs a different value than the stored amount.
        (uint8 v, bytes32 r, bytes32 s) = _sign(REQUEST, PRICE + 1, deadline);

        // The contract always forwards the stored amount, so the signed value mismatches.
        vm.prank(relayer);
        vm.expectRevert(MockUSD8.InvalidSignature.selector);
        pr.payWithAuthorization(REQUEST, buyer, 0, deadline, v, r, s);
    }

    function test_payWithAuthorization_expired() public {
        _create();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(REQUEST, PRICE, deadline);
        vm.warp(deadline);

        vm.expectRevert(MockUSD8.AuthorizationExpired.selector);
        pr.payWithAuthorization(REQUEST, buyer, 0, deadline, v, r, s);
    }

    function test_payWithAuthorization_noReplay() public {
        _create();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(REQUEST, PRICE, deadline);
        pr.payWithAuthorization(REQUEST, buyer, 0, deadline, v, r, s);

        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.AlreadyPaid.selector, REQUEST));
        pr.payWithAuthorization(REQUEST, buyer, 0, deadline, v, r, s);
    }

    function test_payWithAuthorization_revertsOnUnknownRequest() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _sign(REQUEST, PRICE, deadline);

        vm.expectRevert(abi.encodeWithSelector(PaymentRequest.UnknownRequest.selector, REQUEST));
        pr.payWithAuthorization(REQUEST, buyer, 0, deadline, v, r, s);
    }

    function test_constructor_rejectsZeroAddress() public {
        vm.expectRevert(PaymentRequest.ZeroAddress.selector);
        new PaymentRequest(IERC20(address(0)));
    }

    function testFuzz_pay(bytes32 requestId, uint256 amount) public {
        amount = bound(amount, 1, 100e6);
        address fuzzMerchant = makeAddr("fuzzMerchant");

        vm.prank(fuzzMerchant);
        pr.createRequest(requestId, amount, "fuzz");

        vm.startPrank(buyer);
        token.approve(address(pr), amount);
        pr.pay(requestId);
        vm.stopPrank();

        assertEq(token.balanceOf(fuzzMerchant), amount);
        assertEq(pr.requestOf(requestId).amount, amount);
        assertTrue(pr.isPaid(requestId));
    }

    function testFuzz_createRequest(bytes32 requestId, uint256 amount) public {
        vm.assume(requestId != bytes32(0));
        amount = bound(amount, 1, 100e6);
        address fuzzMerchant = makeAddr("fuzzMerchant2");

        vm.prank(fuzzMerchant);
        pr.createRequest(requestId, amount, "fuzz memo");

        PaymentRequest.Request memory r = pr.requestOf(requestId);
        assertEq(r.merchant, fuzzMerchant);
        assertEq(r.amount, amount);
        assertEq(r.memo, "fuzz memo");
        assertFalse(r.paid);
    }
}
