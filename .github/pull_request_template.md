<!-- Thanks for contributing! Please keep changes focused and match the conventions in CONTRIBUTING.md. -->

## What & why
Briefly describe the change and the problem it solves. Link any related issue (`Closes #123`).

## Checklist
- [ ] `node --test` passes
- [ ] `node src/cli.mjs selftest --lint` and `--boundary` pass
- [ ] New behavior has tests (and a never-throws case for new discovery/analysis code)
- [ ] `src/analysis/**` stays pure (no I/O); writes stay dry-run-by-default + reversible
- [ ] Conventional Commit messages; no secrets or personal paths in the diff
- [ ] (If `tui/` touched) `cd tui && go build ./... && go vet ./... && go test ./...` passes
