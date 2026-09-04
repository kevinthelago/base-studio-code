# Captured from the live monitor Pi, 2026-09-04

Verbatim `/proc/net/*` from the sensor — Raspberry Pi 5, Debian 13, aarch64 —
and the `ss -ltun` output taken from the same host at the same moment, which is
what `against_the_real_monitor_pi.rs` checks the verdict against.

`ss` parses these tables with a completely separate implementation, so agreement
between it and our parser is evidence. Agreement between our parser and fixtures
we wrote ourselves is not.

```
tcp 0.0.0.0:22
tcp [::]:22
udp 0.0.0.0:42607
udp 0.0.0.0:5353
udp *:39727
udp *:5353
```

Six listening sockets, every one a wildcard bind — so the honest verdict for the
sensor as it stands today is EXPOSED. That is the starting point for the
emit-only work, not a defect in the checker.

The `tcp` capture also contains the SSH session it was taken over
(`10.99.5.10:22` ← `10.99.2.118`, state `01`), which is why the
established-connection nuance can be tested for real rather than hypothetically.

Re-capture with:

    for t in tcp tcp6 udp udp6; do ssh lan@10.99.5.10 "cat /proc/net/$t" > $t; done
    ssh lan@10.99.5.10 'ss -ltun'
