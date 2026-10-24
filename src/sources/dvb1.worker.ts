/// <reference lib="webworker" />
// DVB1 parse worker for large files (plan §6.11). Bursts are transferred.

import { parseDvb1 } from "../core/dvb1";
import type { Dvb1ParseRequest, Dvb1ParseResponse } from "../core/types";

self.onmessage = (event: MessageEvent<Dvb1ParseRequest>) => {
  const request = event.data;
  if (request?.type !== "parse") return;
  try {
    const { bursts } = parseDvb1(request.buffer);
    const response: Dvb1ParseResponse = { type: "bursts", bursts };
    const transfers = bursts.map((burst) => burst.samples.buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage(response, transfers);
  } catch (error) {
    const response: Dvb1ParseResponse = {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
