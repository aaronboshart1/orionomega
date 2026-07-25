# Memory System Architecture (superseded)

> **This document has been replaced by
> [memory-architecture-v2.md](memory-architecture-v2.md).**

The memory system was rebuilt on **self-hosted Redis**. Records are written
through the backend-neutral `MemoryStore` interface
(`packages/core/src/memory/store.ts`), implemented by `RedisMemoryStore`, and
ranked in process by a lexical index. Context is rebuilt every turn within an
explicit token budget by `ContextAssembler`, and the agent reaches the rest of
its history through the `memory_search`, `memory_read`, and `memory_pin` tools.

The design that used to live in this file described an earlier architecture that
no longer exists. Rather than patch it, it was rewritten from scratch. See
[memory-architecture-v2.md](memory-architecture-v2.md) for the current design —
including a record of what was removed and why.
