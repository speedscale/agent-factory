/**
 * otlp-receiver — gRPC server implementing OTLP LogsService/Export.
 *
 * Receives RRPair log records from the Speedscale forwarder's OTEL exporter,
 * parses them via otlp-converter, and pushes them into the OtlpBuffer.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { OtlpBuffer } from "./otlp-buffer.js";
import { extractRecords, type ExportLogsServiceRequest } from "./otlp-converter.js";
import type { OtlpStreamingMetrics } from "./metrics.js";

// @grpc/grpc-js and @grpc/proto-loader are CJS modules; use createRequire
// for stable interop in an ESM project.
const require = createRequire(import.meta.url);
const grpc = require("@grpc/grpc-js") as typeof import("@grpc/grpc-js");
const protoLoader = require("@grpc/proto-loader") as typeof import("@grpc/proto-loader");

export interface OtlpReceiverConfig {
  port: number;
  buffer: OtlpBuffer;
  logger: { info: (msg: string, ctx?: Record<string, unknown>) => void; warn: (msg: string, ctx?: Record<string, unknown>) => void; error: (msg: string, ctx?: Record<string, unknown>) => void };
  metrics: OtlpStreamingMetrics;
}

/**
 * Create and start an OTLP gRPC receiver on the given port.
 * Returns the gRPC Server instance (call .forceShutdown() to stop).
 */
export function createOtlpReceiver(config: OtlpReceiverConfig): InstanceType<typeof grpc.Server> {
  const { port, buffer, logger, metrics } = config;

  // Resolve proto path relative to this source file.
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const protosDir = path.resolve(thisDir, "..", "protos");
  const logsServiceProto = path.join(
    protosDir,
    "opentelemetry/proto/collector/logs/v1/logs_service.proto",
  );

  const packageDef = protoLoader.loadSync(logsServiceProto, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [protosDir],
  });

  const grpcObject = grpc.loadPackageDefinition(packageDef);

  // Navigate the namespace to find the service definition.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const logsService = (grpcObject as any).opentelemetry?.proto?.collector?.logs?.v1?.LogsService;
  if (!logsService?.service) {
    throw new Error("Failed to load LogsService from proto definitions");
  }

  const server = new grpc.Server();

  server.addService(logsService.service, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Export: (call: any, callback: any) => {
      try {
        const request = call.request as ExportLogsServiceRequest;
        metrics.exportRequestsTotal.inc();

        let recordCount = 0;
        let errorCount = 0;

        for (const parsed of extractRecords(request)) {
          try {
            buffer.push(parsed.service, parsed.rrpair);
            metrics.recordsReceived.inc({ service: parsed.service });
            recordCount++;
          } catch {
            errorCount++;
          }
        }

        if (errorCount > 0) {
          metrics.exportErrorsTotal.inc();
          logger.warn("some records failed to buffer", { errorCount, recordCount });
        }

        callback(null, { partial_success: {} });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Export RPC failed", { error: msg });
        metrics.exportErrorsTotal.inc();
        callback(null, { partial_success: { rejected_log_records: 0, error_message: msg } });
      }
    },
  });

  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err) => {
      if (err) {
        logger.error("otlp-receiver failed to bind", { port, error: err.message });
        return;
      }
      logger.info(`otlp-receiver listening on 0.0.0.0:${port}`);
    },
  );

  return server;
}
