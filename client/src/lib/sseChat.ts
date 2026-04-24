/**
 * Read server-issued SSE (`data: {json}\n\n`) and invoke callback per parsed object.
 */
export async function readSseDataJson(
  body: ReadableStream<Uint8Array> | null,
  onEvent: (ev: Record<string, unknown>) => void
): Promise<void> {
  if (!body) {
    return;
  }
  const reader = body.getReader();
  const dec = new TextDecoder();
  let carry = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      if (carry.trim()) {
        const blocks = carry.split("\n\n");
        for (const bl of blocks) {
          for (const line of bl.split("\n")) {
            if (line.startsWith("data: ")) {
              const raw = line.slice(6).trim();
              if (raw) {
                try {
                  onEvent(JSON.parse(raw) as Record<string, unknown>);
                } catch {
                  /* ignore */
                }
              }
            }
          }
        }
      }
      return;
    }
    carry += dec.decode(value, { stream: true });
    const doubleNl = carry.split("\n\n");
    carry = doubleNl.pop() ?? "";
    for (const bl of doubleNl) {
      for (const line of bl.split("\n")) {
        if (line.startsWith("data: ")) {
          const raw = line.slice(6).trim();
          if (raw) {
            try {
              onEvent(JSON.parse(raw) as Record<string, unknown>);
            } catch {
              /* ignore */
            }
          }
        }
      }
    }
  }
}
