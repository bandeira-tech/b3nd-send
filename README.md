# @bandeira-tech/b3nd-sink

The **egress layer** for B3nd. Where `b3nd-move` is transport and
`b3nd-save` is persistence, `b3nd-sink` is integrations with external
services that B3nd does not own — LLM providers, messaging gateways,
email APIs, payments, calendars.

**Status:** early exploration. Sinks are being built case by case; no
shared contract has been extracted yet. See [VISION.md](./VISION.md)
for the framing and the open design questions, and
[CLAUDE.md](./CLAUDE.md) for how parallel work is organized.

## Layout

```
src/
  <sink-name>/   # one directory per sink, self-contained
```

Each sink owns its own `mod.ts`, README, and tests. Sinks do not
import from each other.
