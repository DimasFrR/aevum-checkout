// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PaymentRequest} from "../../src/PaymentRequest.sol";
import {Signing} from "../Signing.sol";

interface ITUSD8 is IERC20 {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
}

/// @notice Runs PaymentRequest against the REAL tUSD8 on a local fork of Aevum testnet.
///         No funds needed: `deal` writes a balance into the fork only.
///         Run with: make test-fork   (or: forge test --match-path 'test/fork/*' --fork-url aevum --evm-version shanghai)
contract PaymentRequestForkTest is Test {
    ITUSD8 constant TUSD8 = ITUSD8(0x456569838f1d43009A91ebA4263147Afd7233483);

    function test_realTusd8_createAndPay() public {
        address merchant = makeAddr("merchant");
        address buyer = makeAddr("buyer");
        PaymentRequest pr = new PaymentRequest(TUSD8);
        deal(address(TUSD8), buyer, 10e6);

        bytes32 requestId = keccak256("fork-request-1");
        vm.prank(merchant);
        pr.createRequest(requestId, 5e6, "fork invoice");

        vm.startPrank(buyer);
        TUSD8.approve(address(pr), 5e6);
        pr.pay(requestId);
        vm.stopPrank();

        assertEq(TUSD8.balanceOf(merchant), 5e6);
        assertTrue(pr.isPaid(requestId));
        assertEq(pr.requestOf(requestId).payer, buyer);
    }

    function test_realTusd8_payWithAuthorization() public {
        address merchant = makeAddr("merchant");
        (address buyer, uint256 key) = makeAddrAndKey("buyer");
        PaymentRequest pr = new PaymentRequest(TUSD8);
        deal(address(TUSD8), buyer, 10e6);

        bytes32 requestId = keccak256("fork-request-2");
        vm.prank(merchant);
        pr.createRequest(requestId, 5e6, "fork invoice gasless");

        uint256 deadline = block.timestamp + 1 hours;
        Signing.Auth memory a = Signing.Auth({
            from: buyer,
            to: address(pr),
            value: 5e6,
            validAfter: 0,
            validBefore: deadline,
            nonce: pr.authorizationNonce(requestId)
        });
        (uint8 v, bytes32 r, bytes32 s) = Signing.signReceive(vm, key, TUSD8.DOMAIN_SEPARATOR(), a);

        vm.prank(makeAddr("relayer"));
        pr.payWithAuthorization(requestId, buyer, 0, deadline, v, r, s);

        assertEq(TUSD8.balanceOf(merchant), 5e6);
        assertEq(TUSD8.balanceOf(buyer), 5e6);
        assertTrue(TUSD8.authorizationState(buyer, pr.authorizationNonce(requestId)));
    }
}
