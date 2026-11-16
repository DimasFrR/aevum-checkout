# Aevum Testnet Deployment — PaymentRequest

Deployed 2026-11-16 (phase 3). Network: QDay Aevum Testnet, chain ID 44005.

## Deployment

| Item | Value |
|---|---|
| Contract | PaymentRequest |
| Address | 0x1Ba709467e9770ECe772b5296CC141F6c4795AC2 |
| Deploy tx | 0x8830cf59775f81392075e25aaf3fb481728353065f09d899df2dae833a6a44fc |
| Deploy block | 3317813 |
| Token (tUSD8) | 0x456569838f1d43009A91ebA4263147Afd7233483 (6 decimals) |
| Deployer | 0x8CAa665Be7C366B118D2229120636eEBc2C5766F |
| Gas used (deploy) | 725,385 @ 1 gwei |
| Explorer | https://explorer-test.qday.info/address/0x1Ba709467e9770ECe772b5296CC141F6c4795AC2 |

Source commit: template commit `b3ee8af` + local PaymentRequest changes (working copy
`~/workspace/aevum-checkout/`; GitHub repo not created yet).

## Smoke test (all on testnet, 2026-11-16)

Request ID: `0x7dca3d1c05eb8770b31771a93825db9b375c027f7d10dad69916b700cff33956`
(memo "smoke test", amount 0.1 tUSD8 = 100000 raw units; merchant = payer = deployer)

| Step | Tx hash | Block | Result |
|---|---|---|---|
| createRequest | 0xe6a1bd9b6055ae42df202a4a22676dd887a22ec6cd55950b7f36c9785c10b7be | 3317847 | success, RequestCreated emitted |
| approve (0.1 tUSD8) | 0xe38dcd39cc8842ba27da16b8e3cff0b0e1d831f5d1530b13414c061acf45199f | 3317859 | success, Approval emitted |
| pay | 0x873e47c2877effbf457b7148330ed67fb4bd197ad817dc3daa1bfaf17064b20a | 3317865 | success, Paid + Transfer(0.1 tUSD8) emitted |

Verified on-chain after pay: `isPaid` = true; `requestOf` returns
merchant 0x8CAa…66F, amount 100000, memo "smoke test", paid true,
payer 0x8CAa…66F; contract tUSD8 balance = 0 (funds forwarded, nothing stuck);
deployer tUSD8 balance = 5,000,000 (unchanged — self-payment nets to zero).

## Faucet

Discord `/faucet` claim verified on-chain before deploy: 1 tQDAY + 5 tUSD8.
Remaining after deploy + smoke test: ~0.99902 tQDAY, 5 tUSD8.

## Explorer verification

`forge verify-contract` (Blockscout) submitted OK (GUID
`1ba709467e9770ece772b5296cc141f6c4795ac26afaebec`) but the check returned
"Fail - Unable to verify" — the explorer verifier is not working yet, as the
kit README documents. Mitigation: addresses + exact source commit in the
README/submission. Retry verification later in case the explorer is fixed.

## Web smoke test (phase 4, 2026-11-16, local production build)

Production build (`pnpm --filter web build`) green; `next start` on :3100 with the
relayer key passed at runtime only. Deployer self-payments (merchant = payer), 0.05 tUSD8 each.

| Step | Tx hash | Result |
|---|---|---|
| createRequest (standard) | 0x232dce66ca05cc68a8b27ae5211a88196facf239b9f72cda713aea914ec431cb | success |
| approve (0.05 tUSD8) | 0x368a3d589bde853082d9524e38207178628972672c16835f784050d1dbf71fa7 | success |
| pay (standard) | 0x60277993072206deeec359e51fc314a4856c82394a9d0b95365be73c6b80714f | success, request paid |
| createRequest (gasless) | 0xb54525ad20b6d695bcda54812d35948840a0bff76a21519cd69fc2e7ce4dce7e | success |
| payWithAuthorization (via /api/relay) | 0x56ea4aed370a78ab1a900edfb5da86df450801dc2bc208f47a2321a8fe3b9896 | success, block 3318639, request paid |

Request ids: standard `0xbec364be910d9b1e456feb4f35abe79b7894b222509093939229569a3dc31b6a`,
gasless `0xdb311032f56557ef5db0bf5ea81c123037a44bac12b842ad698714077e368f52`.
Relay GET `/api/relay?chainId=44005` → `{"enabled":true,"relayer":"0x8CAa…66F"}`.
Pages `/`, `/checkout`, `/checkout?request=…`, `/receipts/…`, `/activity`, `/docs` all HTTP 200.
Balances after: 0.999 tQDAY, 5 tUSD8 (self-payments net to zero).
