import { isRecord } from "../shared/values.js";

/** Transport framing only. Provider adapters own the meaning of each JSON record. */
export function createJsonLines(
  onRecord: (record: Record<string, unknown>) => void,
  onDiagnostic: (line: string) => void = () => undefined,
  maxRecordChars = 8 * 1024 * 1024,
) {
  let pending = "";
  let error: string | undefined;
  let records = 0;
  const line = (value: string) => {
    const text = value.trim();
    if (!text || error) return;
    if (text.length > maxRecordChars) {
      error = "Provider protocol record exceeded the 8 MiB limit.";
      return;
    }
    if (!text.startsWith("{")) {
      onDiagnostic(text);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      error = "Provider emitted malformed JSON output.";
      return;
    }
    if (isRecord(parsed)) {
      records++;
      onRecord(parsed);
    }
  };
  return {
    get error() {
      return error;
    },
    get records() {
      return records;
    },
    push(chunk: string) {
      if (error) return;
      let offset = 0;
      let end: number;
      while ((end = chunk.indexOf("\n", offset)) !== -1) {
        line(pending + chunk.slice(offset, end));
        pending = "";
        if (error) return;
        offset = end + 1;
      }
      pending += chunk.slice(offset);
      if (pending.length > maxRecordChars) {
        error = "Provider protocol record exceeded the 8 MiB limit.";
        pending = "";
      }
    },
    flush() {
      line(pending);
      pending = "";
    },
  };
}
