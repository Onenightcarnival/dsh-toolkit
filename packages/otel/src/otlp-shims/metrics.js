/** Keep-alive-off shim for @opentelemetry/exporter-metrics-otlp-proto; see trace.js. */
export * from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPMetricExporter as RealOTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";

export class OTLPMetricExporter extends RealOTLPMetricExporter {
  constructor(config = {}) {
    super({ keepAlive: false, ...config });
  }
}
