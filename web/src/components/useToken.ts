"use client";

import { erc20Abi, paymentRequestAbi, TUSD8_ADDRESS } from "@aevum-kit/aevum";
import type { Address } from "viem";
import { useReadContract, useReadContracts } from "wagmi";
import { useNetwork } from "@/lib/network";

/**
 * The payment token. Read from PaymentRequest.token() when a PaymentRequest is configured
 * (works for the local MockUSD8 too); otherwise tUSD8 on Aevum.
 */
export function useToken() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const checkoutAddress = net.checkout;
  const fromContract = useReadContract({
    address: checkoutAddress,
    abi: paymentRequestAbi,
    functionName: "token",
    chainId: appChain.id,
    query: { enabled: Boolean(checkoutAddress) },
  });
  const address: Address | undefined = fromContract.data ?? (net.key === "local" ? undefined : TUSD8_ADDRESS);
  const meta = useReadContracts({
    contracts: address
      ? [
          { address, abi: erc20Abi, functionName: "decimals", chainId: appChain.id },
          { address, abi: erc20Abi, functionName: "symbol", chainId: appChain.id },
        ]
      : [],
    query: { enabled: Boolean(address) },

  });
  const decimals = (meta.data?.[0]?.result as number | undefined) ?? 6;
  const symbol = (meta.data?.[1]?.result as string | undefined) ?? "tUSD8";
  return { address, decimals, symbol, isLoading: fromContract.isLoading || meta.isLoading };
}
