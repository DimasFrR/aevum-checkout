import { encodePacked, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { paymentRequestAbi } from "@aevum-kit/aevum";

/**
 * Payment requests. A request is an invoice a merchant creates on-chain: it stores the
 * merchant, the exact amount and a memo, and the contract enforces all three. The amount
 * is NEVER decided by this file or by the buyer — the app reads it from the contract
 * (requestOf) and the contract moves exactly that amount. There is no demo price here.
 */

export interface PaymentRequest {
  merchant: Address;
  amount: bigint;
  memo: string;
  createdAt: bigint;
  paid: boolean;
  payer: Address;
  paidAt: bigint;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/**
 * A new, unguessable request id: keccak256(merchant, random). Nobody can front-run the
 * merchant and claim the id, and nobody can guess an unpaid request to pay dust on it.
 */
export function newRequestId(merchant: Address): Hex {
  const random = crypto.getRandomValues(new Uint8Array(32));
  return keccak256(encodePacked(["address", "bytes32"], [merchant, toHex(random)]));
}

/** Short, human-friendly label for a bytes32 request id. */
export function requestLabel(requestId: Hex): string {
  return `#${requestId.slice(2, 6).toUpperCase()}-${requestId.slice(-4).toUpperCase()}`;
}

export function short(value: string, head = 6, tail = 4): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

/** The customer-facing link for a request: open it and the Checkout page loads this request. */
export function requestShareUrl(requestId: Hex): string {
  return `/checkout?request=${requestId}`;
}

/** Read a request from the contract. Returns null when no request exists for this id. */
export async function readRequest(
  client: PublicClient,
  contract: Address,
  requestId: Hex,
): Promise<PaymentRequest | null> {
  const r = await client.readContract({
    address: contract,
    abi: paymentRequestAbi,
    functionName: "requestOf",
    args: [requestId],
  });
  if (r.merchant === ZERO_ADDRESS) return null;
  return {
    merchant: r.merchant,
    amount: r.amount,
    memo: r.memo,
    createdAt: r.createdAt,
    paid: r.paid,
    payer: r.payer,
    paidAt: r.paidAt,
  };
}
