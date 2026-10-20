/** Input broker: consume only replies to our outstanding terminal probes. */

import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const OSC_PREFIXES = ["\x1b]11;rgb:", "\x1b]1337;ReportCellSize=", "\x1b]1337;Capabilities="];
const STRING_PREFIXES = ["\x1b_Gi=314159;", "\x1bP>|", ...OSC_PREFIXES];
const REPLY =
  /^(?:\x1b_Gi=314159;[^\x1b]*\x1b\\|\x1bP>\|[^\x1b]*\x1b\\|\x1b\[\?[\d;]+c|\x1b\[6;\d+;\d+t|\x1b\](?:11;rgb:|1337;(?:ReportCellSize=|Capabilities=))[^\x1b\x07]*(?:\x07|\x1b\\))/;
const PREFIXES = [...STRING_PREFIXES, "\x1b[?", "\x1b[6;"];
export function createTerminalReplyFilter() {
  let pending = "";
  return {
    push(input: string, active: boolean): { input: string; replies: string[] } {
      if (!active) {
        const value = pending + input;
        pending = "";
        return { input: value, replies: [] };
      }
      pending += input;
      let output = "";
      const replies: string[] = [];
      while (pending) {
        const match = REPLY.exec(pending)?.[0];
        if (match) {
          replies.push(match);
          pending = pending.slice(match.length);
          continue;
        }
        if (
          pending.length < 512 &&
          (PREFIXES.some((prefix) => prefix.startsWith(pending)) ||
            /^\x1b\[(?:\?|6;)[\d;]*$/.test(pending) ||
            STRING_PREFIXES.some((prefix) => pending.startsWith(prefix)))
        )
          break;
        output += pending[0];
        pending = pending.slice(1);
      }
      return { input: output, replies };
    },
    hasPending() {
      return pending.length > 0;
    },
    isReplyPrefix() {
      return (
        /^\x1b\[(?:\?|6;)[\d;]+$/.test(pending) ||
        STRING_PREFIXES.some((prefix) => pending.startsWith(prefix))
      );
    },
    flush() {
      const value = pending;
      pending = "";
      return value;
    },
  };
}

export function createTerminalQueryInput(
  source: NodeJS.ReadStream,
  write: (data: string) => unknown,
) {
  const stream = new PassThrough() as PassThrough &
    Pick<NodeJS.ReadStream, "isTTY" | "setRawMode" | "ref" | "unref" | "isRaw">;
  Object.defineProperties(stream, {
    isTTY: { get: () => source.isTTY },
    isRaw: { get: () => source.isRaw },
  });
  let deferredQuery: (() => void) | undefined;
  stream.setRawMode = (enabled) => {
    source.setRawMode(enabled);
    if (enabled) source.resume();
    else source.pause();
    if (enabled) {
      deferredQuery?.();
      deferredQuery = undefined;
    }
    return stream as unknown as NodeJS.ReadStream;
  };
  stream.ref = () => {
    source.ref();
    return stream as unknown as NodeJS.ReadStream;
  };
  stream.unref = () => {
    source.unref();
    return stream as unknown as NodeJS.ReadStream;
  };
  const filter = createTerminalReplyFilter();
  const decoder = new StringDecoder("utf8");
  let queried = false;
  let reply: ((value: string) => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  const input = (data: Buffer | string) => {
    const result = filter.push(typeof data === "string" ? data : decoder.write(data), queried);
    if (result.input) stream.write(result.input);
    for (const value of result.replies) reply?.(value);
    clearTimeout(flushTimer);
    if (filter.hasPending())
      flushTimer = setTimeout(
        () => {
          const isReply = filter.isReplyPrefix();
          const text = filter.flush();
          if (text && !isReply) stream.write(text);
        },
        filter.isReplyPrefix() ? 250 : 40,
      );
  };
  source.on("data", input);
  return {
    stream,
    query(data: string, onReply: (value: string) => void) {
      const send = () => {
        queried = true;
        reply = onReply;
        write(data);
        clearTimeout(timer);
        timer = setTimeout(() => {
          reply = undefined;
          const isReply = filter.isReplyPrefix();
          const text = filter.flush();
          if (text && !isReply) stream.write(text);
        }, 750);
      };
      if (source.isRaw) send();
      else deferredQuery = send;
    },
    dispose() {
      clearTimeout(timer);
      clearTimeout(flushTimer);
      reply = undefined;
      deferredQuery = undefined;
      source.off("data", input);
      stream.destroy();
    },
  };
}
