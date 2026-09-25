/**
 * Same keep-alive-off substitution as trace.js, for the metrics exporter.
 * See trace.js for the rationale.
 */
export * from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPMetricExporter as RealOTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";

export class OTLPMetricExporter extends RealOTLPMetricExporter {
  constructor(config = {}) {
    super({ keepAlive: false, ...config });
  }
}
