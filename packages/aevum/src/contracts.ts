import { parseAbi, type Address } from "viem";

/** tUSD8 on Aevum testnet: a USDC-style token (FiatTokenV2) with 6 decimals, EIP-2612 and EIP-3009. */
export const TUSD8_ADDRESS: Address = "0x456569838f1d43009A91ebA4263147Afd7233483";
export const TUSD8_DECIMALS = 6;

/** EIP-712 domain of tUSD8. MockUSD8 (local) uses the same name and version. */
export function tusd8Domain(chainId: number, verifyingContract: Address) {
  return { name: "tUSD8", version: "2", chainId, verifyingContract } as const;
}

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const eip3009Abi = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);

/** ABI of contracts/src/Checkout.sol (the starter kit's example; kept for the examples/ scripts). */
export const checkoutAbi = parseAbi([
  "function token() view returns (address)",
  "function merchant() view returns (address)",
  "function pay(bytes32 orderId, uint256 amount)",
  "function payWithAuthorization(bytes32 orderId, address from, uint256 amount, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationNonce(bytes32 orderId) view returns (bytes32)",
  "function isPaid(bytes32 orderId) view returns (bool)",
  "function paymentOf(bytes32 orderId) view returns ((address payer, uint64 paidAt, uint256 amount))",
  "event Paid(bytes32 indexed orderId, address indexed payer, uint256 amount)",
  "error AlreadyPaid(bytes32 orderId)",
  "error ZeroAmount()",
  "error ZeroAddress()",
]);

/**
 * ABI of contracts/src/PaymentRequest.sol (this project's contract).
 *
 * Differences from Checkout that matter for the app:
 * - The amount lives on-chain in the request: `pay` takes no amount parameter and always
 *   moves exactly the stored amount to the request's merchant.
 * - `payWithAuthorization` likewise takes no amount; the relayer passes the stored amount.
 * - `requestOf` returns the whole request (merchant, amount, memo, timestamps, paid state).
 */
export const paymentRequestAbi = parseAbi([
  "function token() view returns (address)",
  "function createRequest(bytes32 requestId, uint256 amount, string memo)",
  "function pay(bytes32 requestId)",
  "function payWithAuthorization(bytes32 requestId, address from, uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s)",
  "function authorizationNonce(bytes32 requestId) view returns (bytes32)",
  "function requestOf(bytes32 requestId) view returns ((address merchant, uint256 amount, string memo, uint64 createdAt, bool paid, address payer, uint64 paidAt))",
  "function isPaid(bytes32 requestId) view returns (bool)",
  "event RequestCreated(bytes32 indexed requestId, address indexed merchant, uint256 amount, string memo)",
  "event Paid(bytes32 indexed requestId, address indexed payer, uint256 amount)",
  "error AlreadyPaid(bytes32 requestId)",
  "error UnknownRequest(bytes32 requestId)",
  "error RequestExists(bytes32 requestId)",
  "error ZeroAmount()",
  "error ZeroAddress()",
]);
