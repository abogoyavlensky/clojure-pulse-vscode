# The bundled Linux clj-pulse needs glibc 2.39, so older distros fall back to PATH or fail

**Status: open**

## Problem

The `linux-x64` and `linux-arm64` builds carry the `*-unknown-linux-gnu`
clj-pulse archives (`scripts/fetch-server.sh`). The 0.5.4 x86-64 binary links
against `GLIBC_2.39` (`objdump -T server/clj-pulse | grep GLIBC`), which
ships with Ubuntu 24.04 and Debian 13. On Ubuntu 22.04 (glibc 2.35), Debian 12
(2.36), Amazon Linux 2023 (2.34) and any Alpine (musl, no glibc at all) the
loader refuses the file:

```
clj-pulse: /lib/x86_64-linux-gnu/libc.so.6: version `GLIBC_2.39' not found
```

The extension treats that as a spawn failure of the bundled server: the status
bar shows "the bundled server failed to start (…/server/clj-pulse). Set
"clojurePulse.server.path" to use a different binary." (`src/extension.ts`,
the `.start().catch` handler). Resolution does not fall back to `PATH` on its
own, because the file exists and is executable — `resolveServerPath` in
`src/serverPath.ts` only checks that, not whether the binary can load.

A user on such a host has to install clj-pulse themselves (brew, mise, or a
download) and point `clojurePulse.server.path` at it, which is the pre-bundle
experience plus a confusing error. Remote-SSH and dev-container hosts are
where this bites most: they run older LTS images more often than laptops do.

## Proposed fix

This is a clj-pulse change, not an extension one. Either:

- Build the Linux release archives on an older glibc (a `manylinux`-style
  container, glibc 2.28 or 2.31), which lowers the floor without a new target
  and needs no extension change; or
- Add `*-unknown-linux-musl` release archives (static, no glibc floor, also
  the only option for Alpine), then map `linux-x64`/`linux-arm64` — or new
  `alpine-x64`/`alpine-arm64` vsce targets — to them in
  `scripts/fetch-server.sh` and the release loop in
  `.github/workflows/release.yml`.

Notes for whoever picks this up:

- Once the floor drops, nothing in the extension changes for the first
  option; the second is a one-line mapping change per target in the fetch
  script plus two more iterations of the release loop.
- Worth considering in the extension regardless: when the bundled server
  fails to spawn with a loader error, fall through to `PATH` before giving
  up. That would make the failure message an informational line instead of a
  dead end. It needs the spawn error, which the client only reports after
  `start()` rejects, so it is a restart-with-a-different-candidate, not a
  resolution-time check.

## Origin

`docs/plans/2026-09-18-2010-bundle-clj-pulse-server.md`, task 8, 2026-09-18.
The plan anticipated "no Alpine targets" and a glibc floor; the actual floor
(2.39) measured at execution time is higher than expected and rules out
current LTS distros, not just old ones.
