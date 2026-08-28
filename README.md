# Change Order Recovery Audit

A local, read-only Windows Claude Desktop extension that reviews one user-selected construction project folder and returns cited possible change-order exposure for human review.

## Download

Download the versioned release asset from the [v1.0.2 release](https://github.com/rmach816/change-order-recovery-audit/releases/tag/v1.0.2), then install the `.mcpb` in Claude Desktop on Windows.

## Commercial v1.0 boundary

- Runs locally over MCP stdio.
- Reads only the directory selected during extension setup.
- The first completed audit is free. Later audits validate an entitlement before the extension inventories a project folder.
- Sends only bounded entitlement protocol data to the configured licensing service; it never transmits project files, paths, findings, snippets, or plaintext recovery keys.
- Stores activation keys, one-time trial status, a recovery-key fingerprint when used, and a bounded entitlement cache under `%LOCALAPPDATA%\M2AI\ChangeOrderRecoveryAudit\`. Project folders remain read-only.
- Detects five fixed conditions: missing price, missing approval, aging pending, status conflict, and apparently unbilled.
- Does not determine entitlement, approve work, provide legal advice, or guarantee recovery.

## Installation and activation

1. Install the Windows MCPB in Claude Desktop and choose one project folder.
2. Run one complete free audit.
3. Open the activation link returned by the extension, choose the monthly or annual company subscription, then return to Claude and rerun the audit. The purchasing computer activates automatically.
4. Save the optional recovery/company key from the confirmation page only for another computer or support recovery. Use `/manage` on the product site for Stripe billing self-service.

On the purchasing computer, Claude can also open the Stripe billing portal through the `manage_change_order_subscription` tool. It signs a fresh local installation proof and does not read the selected project folder.

The official managed build provides hosted entitlement, automatic updates, and support. The source is Apache-2.0; M2 AI names and branding are not granted by that license.

## Architecture and testing

This package runs as a local MCP stdio server. The audit reads only the configured project folder and returns cited fixed-rule findings for human review. The managed build uses a small hosted entitlement check before later audits, while billing remains in Stripe-hosted Checkout and the customer portal. There is no product database, account system, project upload, telemetry, or background worker.

```powershell
npm install
npm run check
npm run pack
$env:PROJECT_ROOT = "C:\path\to\synthetic-project"
npm start
```

`npm run check` compiles the TypeScript server and runs deterministic audit, entitlement, proof, billing-boundary, and public-package tests. `npm run pack` creates the Windows MCPB. The official manifest contains only the public licensing URL and live/test mode. Stripe secrets, Price IDs, and the signing secret stay in hosted environment configuration, and the functions fail closed until those values are present.

After packaging, run `npm run package:check` to confirm the MCPB contains its local compliance materials and excludes the hosted website files.

## Privacy Policy

Canonical policy: <https://recoveryaudit.m2ai.tech/privacy>

The extension reads the selected project folder locally. It does not send project files, paths, findings, snippets, or plaintext recovery keys to M2 AI. Local application state stores activation keys, trial status, a recovery-key fingerprint when used, and a bounded entitlement cache; it does not store project content or Stripe identifiers. The managed entitlement service receives only bounded activation/proof and recovery protocol data. Stripe processes subscription and billing information, and Vercel hosts the licensing endpoints and receives ordinary request metadata. M2 AI does not operate a product database; Stripe and Vercel retain information under their respective services and policies. For privacy questions or requests, contact <a href="mailto:richard@m2ai.tech">richard@m2ai.tech</a>.

## Refund operator runbook

An approved first-invoice refund must be paired with immediate subscription cancellation in Stripe. The resulting terminal Stripe state ends entitlement at the next validation; no webhook, database, or local override is used.

Installation signatures are purpose- and request-bound and expire after 60 seconds. Because the hosted functions are intentionally stateless, they cannot guarantee server-side single-use replay prevention; the short window, local private key, purpose binding, and Stripe portal idempotency are the compensating controls.

For the first Claude Desktop smoke test, select `fixtures/demo-project/`. Its records are synthetic.
