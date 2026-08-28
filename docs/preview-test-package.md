# Preview test-package override

The official MCPB packages these non-secret values in `manifest.json`:

- `LICENSE_SERVICE_URL=https://recoveryaudit.m2ai.tech`
- `APP_MODE=live`

For a Stripe/Vercel Preview proof, a release operator creates a disposable staging copy of this product directory, changes only those two `mcp_config.env` values to the Preview origin and `test`, then packs that staging copy. This is a test-package build-time override, not a Claude user setting; users never enter the service URL or mode.

Keep Stripe secrets, Price IDs, and the signing secret in Preview Vercel configuration only. Never commit them to the staging copy or this repository.
