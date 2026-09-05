import type { NextConfig } from "next";

/**
 * Build configuration, most of which exists for one reason: the embedder.
 *
 * `search.ts` embeds the shopper's query at request time, so the 22M-parameter
 * sentence model and its ONNX runtime have to be present in the deployed
 * function. That is a native binary and an 86MB weights file, neither of which
 * a bundler should be asked to inline, so both are handled by file tracing
 * instead — see the three settings below.
 */
const nextConfig: NextConfig = {
  // The floating dev badge overlaps the sidebar's user block.
  devIndicators: false,

  /*
   * Native and large packages are required at runtime, never bundled.
   *
   * `onnxruntime-node` loads a .node binary through `require`, which webpack
   * cannot follow and would rewrite into something broken. Marking it external
   * leaves the require alone and lets file tracing ship the binary.
   */
  serverExternalPackages: ["onnxruntime-node", "@huggingface/transformers"],

  outputFileTracingExcludes: {
    /*
     * `onnxruntime-node` ships a binary for every platform it supports — 210MB
     * of them — and a Linux function needs exactly one. Excluding the rest is
     * the difference between fitting in a serverless function and not.
     */
    "*": [
      // Vercel's Node runtime is Linux x64. Everything else is dead weight.
      "node_modules/onnxruntime-node/bin/napi-v6/win32/**",
      "node_modules/onnxruntime-node/bin/napi-v6/darwin/**",
      "node_modules/onnxruntime-node/bin/napi-v6/linux/arm64/**",
      "node_modules/onnxruntime-web/**",
      "node_modules/@huggingface/transformers/dist/*.mjs.map",
      // sharp ships a libvips per platform; the macOS one is 15MB of nothing.
      "node_modules/@img/sharp-libvips-darwin-**",
      "node_modules/@img/sharp-darwin-**",
      "node_modules/@img/sharp-libvips-win32-**",
      "node_modules/@img/sharp-win32-**",
    ],
  },

  outputFileTracingIncludes: {
    /*
     * The model weights, baked in at build time.
     *
     * `npm run prebuild` warms this cache before `next build` runs, so the
     * deployed function opens with the model already on disk. Without it the
     * first request to a cold container downloads 86MB into /tmp — on every
     * cold start, since /tmp does not survive one.
     *
     * Keyed to the routes that actually embed: the shopping surfaces. Tracing
     * it into every route would multiply 86MB across the whole deployment.
     */
    "/api/agent/**": ["./node_modules/@huggingface/transformers/.cache/**"],
    "/api/mcp": ["./node_modules/@huggingface/transformers/.cache/**"],
    "/shop": ["./node_modules/@huggingface/transformers/.cache/**"],
    "/browse": ["./node_modules/@huggingface/transformers/.cache/**"],
    "/for-you": ["./node_modules/@huggingface/transformers/.cache/**"],
    "/product/[id]": ["./node_modules/@huggingface/transformers/.cache/**"],
  },
};

export default nextConfig;
