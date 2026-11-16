// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice EIP-3009 (USDC-style) signed transfers. tUSD8 on Aevum implements this.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title PaymentRequest
/// @notice A simple stablecoin payment checkout on Aevum. A merchant creates a payment
///         request (an invoice) with a fixed amount; a customer pays it in tUSD8 and the
///         money settles straight to the merchant. A `Paid` event is the receipt.
///
/// @dev This replaces the starter kit's `Checkout` example and fixes its documented flaw:
///      `Checkout` never decides the price — `pay(orderId, 1)` marks an order paid for
///      0.000001 tUSD8 and can front-run the real buyer. Here the amount lives on-chain
///      in the request itself, `pay` takes no amount parameter, and both payment paths
///      always move exactly the stored amount to the request's merchant.
///
///      Two ways to pay:
///      1. `pay`: the buyer approves this contract, then calls `pay` (two transactions,
///         buyer pays gas).
///      2. `payWithAuthorization`: the buyer signs an EIP-3009 message off-chain and anyone
///         (your backend, a relayer, the merchant) submits it. The buyer needs no native gas.
///      The signed nonce must be `authorizationNonce(requestId)`. That ties the signature to
///      this request, so a relayer can't reuse it for a different request.
contract PaymentRequest {
    using SafeERC20 for IERC20;

    struct Request {
        address merchant;
        uint256 amount;
        string memo;
        uint64 createdAt;
        bool paid;
        address payer;
        uint64 paidAt;
    }

    IERC20 public immutable token;

    mapping(bytes32 requestId => Request) private _requests;

    event RequestCreated(bytes32 indexed requestId, address indexed merchant, uint256 amount, string memo);
    event Paid(bytes32 indexed requestId, address indexed payer, uint256 amount);

    error AlreadyPaid(bytes32 requestId);
    error UnknownRequest(bytes32 requestId);
    error RequestExists(bytes32 requestId);
    error ZeroAmount();
    error ZeroAddress();

    constructor(IERC20 token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    /// @notice Create a payment request. The caller becomes the merchant for this request.
    /// @dev `requestId` must be unguessable (e.g. keccak256(merchant, random)) so nobody can
    ///      front-run the merchant and claim the id. Creating the same id twice reverts.
    function createRequest(bytes32 requestId, uint256 amount, string memory memo) external {
        if (amount == 0) revert ZeroAmount();
        if (_requests[requestId].merchant != address(0)) revert RequestExists(requestId);
        _requests[requestId] = Request({
            merchant: msg.sender,
            amount: amount,
            memo: memo,
            createdAt: uint64(block.timestamp),
            paid: false,
            payer: address(0),
            paidAt: 0
        });
        emit RequestCreated(requestId, msg.sender, amount, memo);
    }

    /// @notice Pay for `requestId` with tokens you have approved to this contract.
    /// @dev Always moves exactly the stored amount to the request's merchant.
    function pay(bytes32 requestId) external {
        Request storage r = _settle(requestId, msg.sender);
        token.safeTransferFrom(msg.sender, r.merchant, r.amount);
    }

    /// @notice Pay for `requestId` with an EIP-3009 `ReceiveWithAuthorization` signed by `from`.
    /// @dev The signed nonce must be `authorizationNonce(requestId)` and the signed value must
    ///      equal the stored amount; `to` in the signed message must be this contract.
    function payWithAuthorization(
        bytes32 requestId,
        address from,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Request storage req = _settle(requestId, from);
        IERC3009(address(token)).receiveWithAuthorization(
            from, address(this), req.amount, validAfter, validBefore, authorizationNonce(requestId), v, r, s
        );
        token.safeTransfer(req.merchant, req.amount);
    }

    /// @notice The EIP-3009 nonce a buyer must sign to pay `requestId` through this contract.
    function authorizationNonce(bytes32 requestId) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), requestId));
    }

    function requestOf(bytes32 requestId) external view returns (Request memory) {
        return _requests[requestId];
    }

    function isPaid(bytes32 requestId) external view returns (bool) {
        return _requests[requestId].paid;
    }

    /// @dev Validates the request and marks it paid. Reverts on unknown id or double payment.
    ///      Runs before any token movement, so a failed transfer reverts the whole call.
    function _settle(bytes32 requestId, address payer) private returns (Request storage r) {
        r = _requests[requestId];
        if (r.merchant == address(0)) revert UnknownRequest(requestId);
        if (r.paid) revert AlreadyPaid(requestId);
        r.paid = true;
        r.payer = payer;
        r.paidAt = uint64(block.timestamp);
        emit Paid(requestId, payer, r.amount);
    }
}
