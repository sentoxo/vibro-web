// DVB1 file source (plan §6.11). Files are parsed once, kept in memory for
// fast burst switching, and large files are parsed in a worker.

import { parseDvb1, type ParsedFile } from "../core/dvb1";
import { FILE_MAX_BYTES, FILE_WORKER_PARSE_THRESHOLD } from "../core/constants";
import type { Burst, Dvb1ParseResponse } from "../core/types";
import type { SourceHandlers } from "./source";

export class FileParseError extends Error {}

async function parseInWorker(file: File): Promise<ParsedFile> {
  const buffer = await file.arrayBuffer();
  const worker = new Worker(new URL("./dvb1.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    return await new Promise<ParsedFile>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<Dvb1ParseResponse>) => {
        const data = event.data;
        if (data.type === "bursts") resolve({ bursts: data.bursts, skipped: 0 });
        else reject(new FileParseError(data.message));
      };
      worker.onerror = () => reject(new FileParseError("Parse worker failed"));
      worker.postMessage({ type: "parse", buffer }, [buffer]);
    });
  } finally {
    worker.terminate();
  }
}

export interface LoadedFile {
  bursts: Burst[];
  skipped: number;
  fileName: string;
}

/**
 * File "source": parses once and exposes bursts for selection; it does not
 * stream, so the store keeps it outside the streaming DataSource lifecycle.
 */
export class FileSource {
  readonly kind = "file" as const;
  readonly file: File;
  private readonly handlers: SourceHandlers;

  constructor(handlers: SourceHandlers, file: File) {
    this.handlers = handlers;
    this.file = file;
  }

  /** Parse the file and report status; returns the burst list. */
  async start(): Promise<LoadedFile> {
    if (this.file.size > FILE_MAX_BYTES) {
      throw new FileParseError(
        `File is too large (${(this.file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 100 MB.`,
      );
    }
    this.handlers.onStatus({
      state: "connecting",
      deviceLabel: this.file.name,
      message: "Parsing file…",
    });

    const parsed =
      this.file.size > FILE_WORKER_PARSE_THRESHOLD
        ? await parseInWorker(this.file)
        : parseDvb1(await this.file.arrayBuffer());

    if (parsed.bursts.length === 0) {
      throw new FileParseError("No bursts found in file");
    }
    this.handlers.onStatus({
      state: "streaming",
      deviceLabel: this.file.name,
      message: `${parsed.bursts.length} burst${parsed.bursts.length === 1 ? "" : "s"} loaded`,
    });
    return { bursts: parsed.bursts, skipped: parsed.skipped, fileName: this.file.name };
  }

  async stop(): Promise<void> {
    // File mode holds data in memory; nothing to stream.
  }
}
