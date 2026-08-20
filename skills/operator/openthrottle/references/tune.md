# Tune

Use this path only when the user explicitly asks to run an OpenThrottle tune for
the repository.

1. Resolve the repository root and confirm committed `.openthrottle/config.yml` exists.
2. Use the OPE-145 tune CLI contract with `--json` when available:

   ```bash
   openthrottle tune --json
   ```

3. Respect any CLI-reported policy gate or unsupported-capability response.
   Never bypass a tune gate or edit supervisor state directly.
4. Report the CLI-evidenced ticket/run URL and then use `openthrottle status`
   for progress.
