import type { CanonicalTaskEvent, WorkerAssignmentEvent } from "./types";

export interface ParsedSseEvent {
  event: string;
  data: string;
}

export async function* parseSse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<ParsedSseEvent> {
  if (!response.body) {
    throw new Error("SSE response has no body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (signal?.aborted) {
      break;
    }

    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let delimiter = indexOfFrameDelimiter(buffer);
    while (delimiter >= 0) {
      const frame = buffer.slice(0, delimiter);
      const separatorLength = buffer.startsWith("\r\n\r\n", delimiter) ? 4 : 2;
      buffer = buffer.slice(delimiter + separatorLength);
      delimiter = indexOfFrameDelimiter(buffer);

      const parsed = parseSseFrame(frame);
      if (parsed) {
        yield parsed;
      }
    }
  }
}

function indexOfFrameDelimiter(buffer: string): number {
  const unix = buffer.indexOf("\n\n");
  const windows = buffer.indexOf("\r\n\r\n");
  if (unix === -1) return windows;
  if (windows === -1) return unix;
  return Math.min(unix, windows);
}

function parseSseFrame(frame: string): ParsedSseEvent | null {
  if (!frame.trim()) return null;

  let event = "message";
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trim());
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export async function* streamCanonicalTaskEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<CanonicalTaskEvent> {
  for await (const frame of parseSse(response, signal)) {
    try {
      const parsed = JSON.parse(frame.data) as CanonicalTaskEvent;
      yield parsed;
    } catch {
      // Ignore malformed frames.
    }
  }
}

export async function* streamWorkerAssignments(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<WorkerAssignmentEvent> {
  for await (const frame of parseSse(response, signal)) {
    try {
      const parsed = JSON.parse(frame.data) as WorkerAssignmentEvent;
      yield parsed;
    } catch {
      // Ignore malformed frames.
    }
  }
}
