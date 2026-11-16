"use client";

import { addressUrl, paymentRequestAbi, txUrl } from "@aevum-kit/aevum";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { formatUnits, isHash, isHex, parseEventLogs, type Hex } from "viem";
import { useReadContract, useTransactionReceipt } from "wagmi";
import { useToken } from "@/components/useToken";
import { networkByChainId } from "@/lib/env";
import { useNetwork } from "@/lib/network";
import { requestLabel, short, ZERO_ADDRESS } from "@/lib/requests";

export default function ReceiptPage() {
  const { net: appNet } = useNetwork();
  const params = useParams<{ requestId: string }>();
  const search = useSearchParams();
  // Receipt links carry their chain, so they still work after you switch networks.
  const net = networkByChainId(Number(search.get("chain"))) ?? appNet;
  const appChain = net.chain;
  const contractAddress = net.checkout;
  const hasExplorer = net.hasExplorer;
  const requestId = params.requestId;
  const rawTx = search.get("tx");
  // Anything else in ?tx= is ignored, never shown: a receipt must not display text from the URL.
  const tx = rawTx && isHash(rawTx) ? rawTx : undefined;
  const validRequest = isHex(requestId) && requestId.length === 66;
  const token = useToken();

  const request = useReadContract({
    address: contractAddress,
    abi: paymentRequestAbi,
    functionName: "requestOf",
    args: validRequest ? [requestId as Hex] : undefined,
    chainId: appChain.id,
    query: { enabled: validRequest && Boolean(contractAddress) },
  });
  const receipt = useTransactionReceipt({ hash: tx, chainId: appChain.id, query: { enabled: Boolean(tx) } });

  if (!validRequest) {
    return (
      <main className="shell">
        <h1>Receipt not found</h1>
        <p className="lede">That request id isn&apos;t valid. Request ids are 32-byte hex values (0x + 64 characters).</p>
      </main>
    );
  }

  const r = request.data;
  const exists = Boolean(r && r.merchant !== ZERO_ADDRESS);
  const paid = Boolean(r?.paid);
  // Only show transaction details if that transaction really emitted Paid for this request.
  const paidLog =
    receipt.data && contractAddress
      ? parseEventLogs({ abi: paymentRequestAbi, logs: receipt.data.logs, eventName: "Paid" }).find(
          (l) => l.address.toLowerCase() === contractAddress.toLowerCase() && l.args.requestId.toLowerCase() === requestId.toLowerCase(),
        )
      : undefined;
  const txMatches = Boolean(paidLog);

  return (
    <main className="shell" style={{ maxWidth: 760 }}>
      <div>
        <p className="eyebrow">Receipt · read from {appChain.name}</p>
        <h1>Request {requestLabel(requestId as Hex)}</h1>
      </div>

      <section className="card stack">
        {!contractAddress ? (
          <div className="stack">
            <span className="status-pill warn">Can&apos;t check</span>
            <p style={{ color: "var(--text-muted)" }}>No PaymentRequest is configured for {appChain.name} in this app.</p>
          </div>
        ) : request.isLoading ? (
          <p className="empty">Reading PaymentRequest.requestOf…</p>
        ) : request.isError ? (
          <div className="stack">
            <span className="status-pill warn">Can&apos;t check</span>
            <p style={{ color: "var(--text-muted)" }}>
              Couldn&apos;t read the request from {appChain.name}. The RPC may be busy.{" "}
              <button type="button" className="btn small" onClick={() => request.refetch()}>
                Try again
              </button>
            </p>
          </div>
        ) : !exists ? (
          <div className="stack">
            <span className="status-pill warn">No such request</span>
            <p style={{ color: "var(--text-muted)" }}>
              No request is stored for this id on {appChain.name}. Check the link — request ids are 32-byte hex values.
            </p>
          </div>
        ) : !paid ? (
          <div className="stack">
            <span className="status-pill warn">Not paid</span>
            <p style={{ color: "var(--text-muted)" }}>
              This request is still unpaid on {appChain.name}. Amount: {formatUnits(r!.amount, token.decimals)} {token.symbol}
              {r!.memo ? ` — ${r!.memo}` : ""}. If you just paid, wait a few seconds and refresh.
            </p>
          </div>
        ) : (
          <>
            <div className="check-top" style={{ alignItems: "center" }}>
              <span className="status-pill good">Paid</span>
              <span className="fine">{new Date(Number(r!.paidAt) * 1000).toLocaleString()}</span>
            </div>
            <div className="receipt-amount">
              {formatUnits(r!.amount, token.decimals)} <small style={{ fontSize: "0.4em", color: "var(--text-muted)" }}>{token.symbol}</small>
            </div>
            <dl className="kv">
              <dt>Request id</dt>
              <dd>{requestId}</dd>
              <dt>Memo</dt>
              <dd>{r!.memo || "—"}</dd>
              <dt>Merchant</dt>
              <dd>{hasExplorer ? <a href={addressUrl(r!.merchant)} target="_blank" rel="noreferrer">{r!.merchant}</a> : r!.merchant}</dd>
              <dt>Payer</dt>
              <dd>{hasExplorer ? <a href={addressUrl(r!.payer)} target="_blank" rel="noreferrer">{r!.payer}</a> : r!.payer}</dd>
              <dt>Contract</dt>
              <dd>{contractAddress}</dd>
              {txMatches && receipt.data && (
                <>
                  <dt>Block</dt>
                  <dd>{receipt.data.blockNumber.toString()}</dd>
                  <dt>Gas used</dt>
                  <dd>{receipt.data.gasUsed.toString()}</dd>
                  <dt>Submitted by</dt>
                  <dd>{receipt.data.from}</dd>
                  <dt>Transaction</dt>
                  <dd>{hasExplorer ? <a href={txUrl(tx!)} target="_blank" rel="noreferrer">{tx}</a> : tx}</dd>
                </>
              )}
            </dl>
            {tx && receipt.data && !txMatches && (
              <p className="fine">The transaction in this link isn&apos;t the payment for this request, so it isn&apos;t shown.</p>
            )}
            {txMatches && receipt.data && r && receipt.data.from.toLowerCase() !== r.payer.toLowerCase() && (
              <p className="fine">The payer didn&apos;t send this transaction: a relayer submitted the payer&apos;s signature (gasless mode).</p>
            )}
          </>
        )}
      </section>

      <p className="fine">
        This page trusts nothing but the chain: it calls <code>PaymentRequest.requestOf(requestId)</code>, and the paid flag is
        authoritative — the contract only ever moves the stored amount, so a paid request is always fully paid.{" "}
        <Link href="/checkout">New request</Link>
      </p>
    </main>
  );
}
