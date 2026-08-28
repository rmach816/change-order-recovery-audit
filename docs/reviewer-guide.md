# Reviewer Guide

This Windows-only MCPB reviews only synthetic material for submission review. Do not use customer documents, recovery keys, or production billing credentials.

## Install on Windows

1. Build the supplied package with `npm run pack`.
2. In Claude Desktop for Windows, open the Extensions or Connectors settings and use the local-file install flow to select `claude-change-order-recovery-audit.mcpb`.
3. In the extension settings, select `fixtures/demo-project/` as the project folder.
4. Leave the optional recovery/company key empty for the free-audit path. For paid-path review, use only the separately supplied reviewer entitlement.

Reviewer entitlement placeholder: `CORA_REVIEWER_ENTITLEMENT_TOKEN`

## Claude prompts

1. Free audit: `Use audit_change_order_folder to audit the configured synthetic demo project.`
2. Paid audit: `Use audit_change_order_folder again after the reviewer entitlement is active.`
3. Manage billing: `Use manage_change_order_subscription to open billing management for this purchasing computer.`

## Expected boundaries

- The first completed audit of `fixtures/demo-project/` is free and returns cited findings for human review.
- After that trial, the audit validates entitlement before inventorying the folder; a denied validation reads no project content.
- The managed billing action signs a local installation proof and does not read the project folder.
- Project files, paths, findings, snippets, private keys, and plaintext recovery keys do not leave the computer. The hosted entitlement path receives only bounded protocol data.
