import { Config } from "@remotion/cli/config";

// Lossless PNG intermediate frames so the crisp text/logo edges survive into the
// encode (JPEG frames were softening them). Low CRF = high-quality H.264 so the
// white wordmark and pink title stay sharp after compression.
Config.setVideoImageFormat("png");
Config.setOverwriteOutput(true);
Config.setCrf(10); // ~1.1 Mbps, matches the source's crispness (CRF 16 starved the text edges)
