"use client";

import { authorizationWindow, checkoutTypedData, erc20Abi, paymentRequestAbi, txUrl } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { formatUnits, isHex, parseUnits, type Hash, type Hex } from "viem";
import { useAccount, useConfig, useReadContract } from "wagmi";
import { readContract, signTypedData, simulateContract, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { CheckIcon } from "@/components/Icons";
import { useToken } from "@/components/useToken";
import { useNetwork } from "@/lib/network";
import { explain } from "@/lib/errors";
import { newRequestId, requestLabel, requestShareUrl, short, ZERO_ADDRESS } from "@/lib/requests";

type Tab = "merchant" | "customer";
type Mode = "gasless" | "standard";
type Phase = "idle" | "working" | "done" | "error";

const STEPS: Record<Mode, { title: string; who: string }[]> = {
  gasless: [
    { title: "Sign payment authorization", who: "EIP-3009 · your wallet signs, no gas" },
    { title: "Relayer submits transaction", who: "payWithAuthorization · the relayer pays gas" },
    { title: "Confirmed on Aevum", who: "The Paid event is your receipt" },
  ],
  standard: [
    { title: "Approve tUSD8", who: "approve(PaymentRequest, exact amount) · you pay gas" },
    { title: "Pay request", who: "PaymentRequest.pay(requestId) · you pay gas" },
    { title: "Confirmed on Aevum", who: "The Paid event is your receipt" },
  ],
};

const AMOUNT_RE = /^\d+(\.\d{1,6})?$/;

function CheckoutContent() {
  const { net } = useNetwork();
  const appChain = net.chain;
  const contractAddress = net.checkout;
  const hasExplorer = net.hasExplorer;
  const config = useConfig();
  const { address, isConnected, chainId } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();
  const search = useSearchParams();
  const linkedRequest = search.get("request");

  // ---- tabs ----
  const [tab, setTab] = useState<Tab>(linkedRequest && isHex(linkedRequest) && linkedRequest.length === 66 ? "customer" : "merchant");
  useEffect(() => {
    if (linkedRequest && isHex(linkedRequest) && linkedRequest.length === 66) setTab("customer");
  }, [linkedRequest]);

  // ---- merchant state ----
  const [amountInput, setAmountInput] = useState("1.00");
  const [memoInput, setMemoInput] = useState("");
  const [createdId, setCreatedId] = useState<Hex | null>(null);
  const [createTx, setCreateTx] = useState<Hash | null>(null);
  const [createPhase, setCreatePhase] = useState<Phase>("idle");
  const [createError, setCreateError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ---- customer state ----
  const [requestInput, setRequestInput] = useState(linkedRequest ?? "");
  const [requestId, setRequestId] = useState<Hex | null>(
    linkedRequest && isHex(linkedRequest) && linkedRequest.length === 66 ? (linkedRequest as Hex) : null,
  );
  const [mode, setMode] = useState<Mode>("gasless");
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hash | null>(null);
  const [block, setBlock] = useState<bigint | null>(null);

  const relay = useQuery({
    queryKey: ["relay-status", appChain.id],
    queryFn: async () => (await fetch(`/api/relay?chainId=${appChain.id}`)).json() as Promise<{ enabled: boolean; relayer: string | null }>,
  });
  const gaslessAvailable = relay.data?.enabled ?? false;
  useEffect(() => {
    if (relay.data) setMode(relay.data.enabled ? "gasless" : "standard");
  }, [relay.data]);

  const balance = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: appChain.id,
    query: { enabled: onChain && Boolean(token.address) },
  });

  // The request the customer is looking at. The amount always comes from the contract.
  const request = useReadContract({
    address: contractAddress,
    abi: paymentRequestAbi,
    functionName: "requestOf",
    args: requestId ? [requestId] : undefined,
    chainId: appChain.id,
    query: { enabled: Boolean(requestId && contractAddress) },
  });
  const req = request.data;
  const requestExists = Boolean(req && req.merchant !== ZERO_ADDRESS);
  const amount = req ? req.amount : 0n;
  const enoughBalance = balance.data === undefined || balance.data >= amount;
  const busy = phase === "working";
  const shareHref = useMemo(() => (createdId ? requestShareUrl(createdId) : null), [createdId]);

  // ---- merchant: create a request ----
  async function onCreate() {
    if (!address || !contractAddress || !onChain) return;
    if (!AMOUNT_RE.test(amountInput.trim())) {
      setCreateError("Enter an amount like 1.00 (up to 6 decimals).");
      return;
    }
    const value = parseUnits(amountInput.trim(), token.decimals);
    if (value === 0n) {
      setCreateError("The amount has to be more than zero.");
      return;
    }
    setCreateError(null);
    setCreatePhase("working");
    try {
      const id = newRequestId(address);
      const { request: sim } = await simulateContract(config, {
        account: address,
        address: contractAddress,
        abi: paymentRequestAbi,
        functionName: "createRequest",
        args: [id, value, memoInput.trim()],
        chainId: appChain.id,
      });
      const hash = await writeContract(config, sim);
      await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      setCreatedId(id);
      setCreateTx(hash);
      setCreatePhase("done");
    } catch (e) {
      setCreateError(explain(e));
      setCreatePhase("error");
    }
  }

  function copyShareLink() {
    if (!createdId) return;
    const url = `${window.location.origin}${requestShareUrl(createdId)}`;
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }

  // ---- customer: pay a request ----
  function loadRequest() {
    const v = requestInput.trim();
    if (isHex(v) && v.length === 66) {
      setRequestId(v as Hex);
      setPhase("idle");
      setStep(0);
      setError(null);
      setTxHash(null);
      setBlock(null);
    } else {
      setError("That isn't a request id. Paste the full 0x… id from the merchant's link.");
      setPhase("error");
    }
  }

  function resetPay(nextMode = mode) {
    setMode(nextMode);
    setStep(0);
    setPhase("idle");
    setError(null);
    setTxHash(null);
    setBlock(null);
  }

  /** Stop before any signature or gas is spent if this request was already paid. */
  async function assertUnpaid(id: Hex) {
    if (!contractAddress) return;
    const paid = await readContract(config, { address: contractAddress, abi: paymentRequestAbi, functionName: "isPaid", args: [id], chainId: appChain.id });
    if (paid) throw new Error("This request is already paid.");
  }

  async function payGasless() {
    if (!address || !contractAddress || !token.address || !requestId) return;
    await assertUnpaid(requestId);
    // 1. Sign. The nonce comes from the contract and ties this signature to this request.
    // The value is the amount stored on-chain for this request — never typed by the buyer.
    const nonce = await readContract(config, { address: contractAddress, abi: paymentRequestAbi, functionName: "authorizationNonce", args: [requestId], chainId: appChain.id });
    const { validAfter, validBefore } = authorizationWindow(600);
    const signature = await signTypedData(config, {
      account: address,
      ...checkoutTypedData(appChain.id, token.address, { from: address, to: contractAddress, value: amount, validAfter, validBefore, nonce }),
    });
    setStep(1);
    // 2. Hand it to the relayer (web/src/app/api/relay/route.ts). The amount is not sent:
    // the relayer reads it from the contract, so a tampered amount can't change the payment.
    const res = await fetch("/api/relay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chainId: appChain.id,
        requestId,
        from: address,
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        signature,
      }),
    });
    const data = (await res.json()) as { hash?: Hash; error?: string };
    if (!res.ok || !data.hash) throw new Error(data.error ?? "The relayer didn't accept the payment.");
    setTxHash(data.hash);
    setStep(2);
    return data.hash;
  }

  async function payStandard() {
    if (!address || !contractAddress || !token.address || !requestId) return;
    await assertUnpaid(requestId);
    // 1. Approve exactly the stored amount, never an unlimited amount.
    const allowance = await readContract(config, { address: token.address, abi: erc20Abi, functionName: "allowance", args: [address, contractAddress], chainId: appChain.id });
    if (allowance < amount) {
      const approveHash = await writeContract(config, { address: token.address, abi: erc20Abi, functionName: "approve", args: [contractAddress, amount], chainId: appChain.id });
      await waitForTransactionReceipt(config, { hash: approveHash, chainId: appChain.id });
    }
    setStep(1);
    // 2. Pay. The contract moves exactly the stored amount to the merchant.
    // Simulate first: a revert shows up here with its reason, before the wallet asks for gas.
    const { request: sim } = await simulateContract(config, { account: address, address: contractAddress, abi: paymentRequestAbi, functionName: "pay", args: [requestId], chainId: appChain.id });
    const hash = await writeContract(config, sim);
    setTxHash(hash);
    setStep(2);
    return hash;
  }

  async function onPay() {
    if (phase === "done") {
      resetPay();
      return;
    }
    setError(null);
    setPhase("working");
    setStep(0);
    try {
      const hash = mode === "gasless" ? await payGasless() : await payStandard();
      if (!hash) throw new Error("Connect your wallet first.");
      const receipt = await waitForTransactionReceipt(config, { hash, chainId: appChain.id });
      if (receipt.status !== "success") throw new Error("The transaction reverted on chain. Nothing was charged.");
      setBlock(receipt.blockNumber);
      setStep(3);
      setPhase("done");
      balance.refetch();
      request.refetch();
    } catch (e) {
      setError(explain(e));
      setPhase("error");
    }
  }

  const payCta = (() => {
    if (!isConnected) return "Connect a wallet to pay";
    if (!onChain) return "Switch network to pay";
    if (!contractAddress) return "Deploy PaymentRequest first";
    if (!requestExists) return "Load a request first";
    if (req?.paid) return "Already paid";
    if (phase === "done") return "Pay another request";
    if (phase === "error") return mode === "gasless" ? "Sign again" : "Try again";
    if (busy) return ["Check your wallet…", mode === "gasless" ? "Waiting for relayer…" : "Check your wallet…", "Confirming…"][step] ?? "Working…";
    return mode === "gasless"
      ? `Sign & pay ${formatUnits(amount, token.decimals)} ${token.symbol}`
      : `Approve & pay ${formatUnits(amount, token.decimals)} ${token.symbol}`;
  })();
  const payDisabled = !onChain || !contractAddress || !requestExists || req?.paid || busy || (!enoughBalance && phase !== "done");
  const createDisabled = !onChain || !contractAddress || createPhase === "working";

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <p className="eyebrow">Aevum Checkout · PaymentRequest</p>
          <h1>Pay with tUSD8</h1>
          <p className="lede">
            A merchant creates a payment request with a fixed amount; a customer pays it and the contract settles it straight to the
            merchant. The amount is stored on-chain, so nobody can pay dust on a request.
          </p>
        </div>
      </div>

      <div className="modes" role="tablist" aria-label="Checkout role" style={{ marginBottom: 20 }}>
        {(
          [
            { id: "merchant", title: "Merchant", tag: "create a request", desc: "Set an amount and a memo, get a shareable payment link." },
            { id: "customer", title: "Customer", tag: "pay a request", desc: "Open a merchant's link and pay the exact amount, standard or gasless." },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="mode"
            aria-selected={tab === t.id}
            aria-checked={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            <span className="mode-top">
              {t.title}
              <span className="tag">{t.tag}</span>
            </span>
            <span className="mode-desc">{t.desc}</span>
          </button>
        ))}
      </div>

      {tab === "merchant" ? (
        <div className="row">
          <section className="card stack" aria-label="Create a payment request" style={{ flex: "1 1 340px" }}>
            <div className="check-top" style={{ alignItems: "baseline" }}>
              <h2>New payment request</h2>
              <span className="mono" style={{ color: "var(--text-muted)" }}>{address ? short(address) : "not connected"}</span>
            </div>
            <div className="stack" style={{ gap: 12 }}>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
                <span style={{ color: "var(--text-muted)" }}>Amount ({token.symbol})</span>
                <input
                  className="field"
                  inputMode="decimal"
                  placeholder="1.00"
                  value={amountInput}
                  disabled={createPhase === "working"}
                  onChange={(e) => setAmountInput(e.target.value)}
                />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 14 }}>
                <span style={{ color: "var(--text-muted)" }}>Memo (what is this for?)</span>
                <input
                  className="field"
                  placeholder="e.g. Invoice #42 — logo design"
                  value={memoInput}
                  disabled={createPhase === "working"}
                  onChange={(e) => setMemoInput(e.target.value)}
                />
              </label>
            </div>
            <dl className="kv" style={{ fontSize: 13 }}>
              <dt>Contract</dt>
              <dd>{contractAddress ? short(contractAddress) : "not deployed"}</dd>
              <dt>Request id</dt>
              <dd>Generated on-chain, unguessable</dd>
            </dl>
            {createError && (
              <div className="notice bad" role="alert">
                <strong>Couldn't create the request</strong>
                <span>{createError}</span>
              </div>
            )}
            {createPhase === "done" && createdId && (
              <div className="notice good" role="status">
                <strong>Request created</strong>
                <span className="mono" style={{ overflowWrap: "anywhere" }}>{createdId}</span>
                {shareHref && (
                  <span style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                    <button type="button" className="btn small" onClick={copyShareLink}>
                      {copied ? "Copied!" : "Copy payment link"}
                    </button>
                    <Link href={shareHref}>Open as customer</Link>
                    {createTx && hasExplorer && (
                      <a href={txUrl(createTx)} target="_blank" rel="noreferrer">
                        Explorer
                      </a>
                    )}
                  </span>
                )}
                <span className="fine">Send the link to your customer. They pay the exact amount — nothing more, nothing less.</span>
              </div>
            )}
            <button type="button" className="btn big block" disabled={createDisabled} onClick={onCreate}>
              {!isConnected
                ? "Connect a wallet to create"
                : !onChain
                  ? "Switch network to create"
                  : !contractAddress
                    ? "Deploy PaymentRequest first"
                    : createPhase === "working"
                      ? "Check your wallet…"
                      : createPhase === "done"
                        ? "Create another request"
                        : `Create request · ${amountInput || "0"} ${token.symbol}`}
            </button>
            <p className="fine">
              Creating a request costs gas in tQDAY. The request id is random, so only someone with your link can pay it.
            </p>
          </section>

          <section className="card stack" aria-label="How it works" style={{ flex: "1.3 1 420px" }}>
            <h2>How it works</h2>
            <ol className="steps">
              <li className="step done">
                <div className="step-dot"><CheckIcon /></div>
                <div className="step-body">
                  <div className="step-top"><span className="step-title">Merchant creates a request</span></div>
                  <p className="step-who">createRequest(amount, memo) — the amount is locked on-chain.</p>
                </div>
              </li>
              <li className="step">
                <div className="step-dot">2</div>
                <div className="step-body">
                  <div className="step-top"><span className="step-title">Customer opens the link</span></div>
                  <p className="step-who">The app reads the amount from the contract, never from the link.</p>
                </div>
              </li>
              <li className="step">
                <div className="step-dot">3</div>
                <div className="step-body">
                  <div className="step-top"><span className="step-title">Customer pays, merchant gets paid</span></div>
                  <p className="step-who">pay() or gasless payWithAuthorization() — the exact amount, straight to the merchant. The Paid event is the receipt.</p>
                </div>
              </li>
            </ol>
            <p className="fine">
              This fixes the starter kit example&apos;s flaw: there, anyone could mark an order paid with 0.000001 tUSD8. Here the amount
              lives in the request and pay() takes no amount at all.
            </p>
          </section>
        </div>
      ) : (
        <div className="row">
          <section className="card stack" aria-label="Request" style={{ flex: "1 1 340px" }}>
            <div className="check-top" style={{ alignItems: "baseline" }}>
              <h2>Request</h2>
              <span className="mono" style={{ color: "var(--text-muted)" }}>{requestId ? requestLabel(requestId) : "…"}</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                className="field"
                placeholder="0x… request id"
                value={requestInput}
                disabled={busy}
                onChange={(e) => setRequestInput(e.target.value)}
              />
              <button type="button" className="btn secondary" disabled={busy || !requestInput.trim()} onClick={loadRequest}>
                Load
              </button>
            </div>
            {!requestId ? (
              <p style={{ color: "var(--text-muted)", fontSize: 14 }}>Paste a request id, or open a merchant&apos;s payment link.</p>
            ) : request.isLoading ? (
              <p className="empty">Reading the request from {appChain.name}…</p>
            ) : request.isError || !requestExists ? (
              <div className="notice warn" role="status">
                <strong>No such request</strong>
                <span>Nothing is stored for this id on {appChain.name}. Check the link — request ids are 32-byte hex values.</span>
              </div>
            ) : (
              <>
                <div className="lines">
                  <div className="line">
                    <span>Memo</span>
                    <span>{req!.memo || "—"}</span>
                  </div>
                  <div className="rule" />
                  <div className="line" style={{ alignItems: "baseline" }}>
                    <span style={{ fontWeight: 600 }}>Amount</span>
                    <span className="total">
                      {formatUnits(amount, token.decimals)} <small>{token.symbol}</small>
                    </span>
                  </div>
                </div>
                <dl className="kv" style={{ fontSize: 13 }}>
                  <dt>Merchant</dt>
                  <dd>{short(req!.merchant)}</dd>
                  <dt>Status</dt>
                  <dd>{req!.paid ? `Paid by ${short(req!.payer)}` : "Unpaid"}</dd>
                  <dt>Contract</dt>
                  <dd>{contractAddress ? short(contractAddress) : "not deployed"}</dd>
                  <dt>Your balance</dt>
                  <dd>{balance.data !== undefined ? `${formatUnits(balance.data, token.decimals)} ${token.symbol}` : "—"}</dd>
                </dl>
              </>
            )}
          </section>

          <section className="card stack" aria-label="Payment" style={{ flex: "1.3 1 420px" }}>
            <div className="modes" role="radiogroup" aria-label="Payment mode">
              {(
                [
                  { id: "gasless", title: "Gasless", tag: "EIP-3009", desc: gaslessAvailable ? "Sign once. A relayer submits it. You need no tQDAY." : "Off: set RELAYER_PRIVATE_KEY in web/.env.local to enable." },
                  { id: "standard", title: "Standard", tag: "approve + pay", desc: "Two wallet transactions. You pay gas in tQDAY." },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  className="mode"
                  aria-checked={mode === m.id}
                  disabled={busy || (m.id === "gasless" && !gaslessAvailable)}
                  onClick={() => resetPay(m.id)}
                >
                  <span className="mode-top">
                    {m.title}
                    <span className="tag">{m.tag}</span>
                  </span>
                  <span className="mode-desc">{m.desc}</span>
                </button>
              ))}
            </div>

            <ol className="steps">
              {STEPS[mode].map((s, i) => {
                const done = step > i;
                const active = busy && step === i;
                return (
                  <li key={s.title} className={`step ${done ? "done" : active ? "active" : ""}`}>
                    <div className="step-dot">{done ? <CheckIcon /> : i + 1}</div>
                    <div className="step-body">
                      <div className="step-top">
                        <span className="step-title">{s.title}</span>
                        <span className="step-state">{done ? "Done" : active ? "In progress…" : "Waiting"}</span>
                      </div>
                      <p className="step-who">{s.who}</p>
                    </div>
                  </li>
                );
              })}
            </ol>

            {!enoughBalance && phase !== "done" && requestExists && !req?.paid && (
              <div className="notice warn" role="status">
                <strong>Not enough {token.symbol}</strong>
                <span>
                  This request needs {formatUnits(amount, token.decimals)} {token.symbol}. See the <Link href="/">Setup</Link> page for how to get test tokens.
                </span>
              </div>
            )}

            {error && (
              <div className="notice bad" role="alert">
                <strong>Payment didn't go through</strong>
                <span>{error}</span>
              </div>
            )}

            {phase === "done" && requestId && txHash && (
              <div className="notice good" role="status">
                <div className="row-between">
                  <strong>
                    Paid {formatUnits(amount, token.decimals)} {token.symbol}
                    {block !== null ? ` · confirmed in block ${block.toLocaleString("en-US")}` : ""}
                  </strong>
                  <span style={{ display: "flex", gap: 16 }}>
                    {hasExplorer && (
                      <a href={txUrl(txHash)} target="_blank" rel="noreferrer">
                        Explorer
                      </a>
                    )}
                    <Link href={`/receipts/${requestId}?tx=${txHash}&chain=${appChain.id}`}>View receipt</Link>
                  </span>
                </div>
              </div>
            )}

            <button type="button" className="btn big block" disabled={payDisabled} onClick={onPay}>
              {payCta}
            </button>
            <p className="fine">
              {mode === "gasless"
                ? "The signature is valid for 10 minutes, for this exact amount, and only for this request."
                : "The approval is for the exact request amount, never unlimited."}
            </p>
          </section>
        </div>
      )}
    </main>
  );
}

export default function CheckoutPage() {
  return (
    <Suspense
      fallback={
        <main className="shell">
          <p className="empty">Loading checkout…</p>
        </main>
      }
    >
      <CheckoutContent />
    </Suspense>
  );
}
