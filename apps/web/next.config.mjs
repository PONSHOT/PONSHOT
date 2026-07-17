/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The workspace packages ship TypeScript source rather than build output, so Next has
  // to compile them itself.
  transpilePackages: ["@pons/sdk", "@pons/config"],
  eslint: {ignoreDuringBuilds: false},

  /**
   * Same-origin proxies for the read API and the JSON-RPC endpoint.
   *
   * Without these the browser would be told to call `localhost:8789` and
   * `127.0.0.1:8545` — which resolve to *the visitor's* machine, not the server's, so the
   * site would work only when opened on the host itself. Proxying keeps everything on the
   * page's own origin, so the app works from any address without baking in an IP.
   */
  async rewrites() {
    const api = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8789";
    const rpc = process.env.RPC_PROXY_TARGET ?? "http://127.0.0.1:8545";
    // `/rpc` is deliberately NOT here. Rewrites are baked into the routes manifest at
    // build time, so one pointing at a runtime-supplied RPC URL silently keeps whatever
    // was set during the build. It is served by src/app/rpc/route.ts instead, which reads
    // the target per request.
    void rpc;
    return [{source: "/api/:path*", destination: `${api}/:path*`}];
  },

  webpack: (config, {webpack}) => {
    // The shared packages are also consumed by the Node services (keeper, indexer, API),
    // where ESM requires explicit `.js` extensions on relative imports. Those specifiers
    // point at TypeScript sources, which the bundler has to be told about. Aliasing here
    // keeps the Node side spec-correct instead of loosening it to suit the bundler.
    // `wagmi/connectors` is a barrel: importing any connector pulls in Coinbase's Base
    // Account SDK, which declares optional dependencies that are not installed and are
    // never reached by the connectors this app actually registers. Resolving them to
    // `false` keeps the build honest — nothing is silently shimmed, the modules simply
    // do not exist in the bundle, and the code paths that would need them are unused.
    config.resolve.alias = {...config.resolve.alias};
    for (const mod of ["@x402/evm", "@x402/svm", "@x402/core"]) {
      config.resolve.alias[mod] = false;
    }
    // Subpath imports (`@x402/svm/exact/client`) need a pattern, not an exact key.
    config.plugins.push(
      new webpack.IgnorePlugin({resourceRegExp: /^@x402\//})
    );

    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};
export default nextConfig;
