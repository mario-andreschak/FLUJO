// Plain-JS config on purpose: the npm package (`npx flujo-ai`) runs `next start`
// on end-user machines without TypeScript installed, and a next.config.ts would
// make Next try to npm-install typescript there at runtime (which fails).
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  // Pin the workspace root to this project. Without this, a stray
  // package-lock.json in a parent dir (e.g. the user's home folder) makes
  // Next infer the wrong root and install/resolve deps like typescript in the
  // wrong place, breaking `next build`.
  outputFileTracingRoot: __dirname,
  // CORS for `/api/*` is defense-in-depth secondary to the fail-closed origin
  // guard in `src/middleware.ts` (#142). We do NOT advertise a wildcard
  // `Access-Control-Allow-Origin: *` for the blanket `/api` surface: even if the
  // guard were ever bypassed, a cross-origin page must not be told it may read
  // `/api` responses. The value is narrowed to the local dev origin, consistent
  // with the `/api/env` override (#141). The public OpenAI-compatible `/v1/*`
  // API sets its own permissive CORS in-handler and is not matched here.
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: 'http://localhost:4200' },
          { key: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
          { key: 'Access-Control-Allow-Headers', value: '*' },
          { key: 'Vary', value: 'Origin' },
        ],
      },
      // Defense-in-depth for /api/env (#141): this route can return DECRYPTED
      // secrets (`?includeSecrets=true`). Even though `assertLocalRequest` already
      // rejects cross-origin callers, do NOT advertise a wildcard ACAO here so the
      // response is never cross-origin readable if the guard were ever bypassed.
      // This block is more specific and comes after the wildcard, so its
      // Access-Control-Allow-Origin value overrides the '*' above for /api/env.
      // (In-app calls are same-origin and don't rely on CORS.)
      {
        source: '/api/env',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: 'http://localhost:4200' },
          { key: 'Vary', value: 'Origin' },
        ],
      },
    ];
  },
  typescript: {
    // Ignore all TypeScript errors during build
    ignoreBuildErrors: true,
  },
  eslint: {
    // Ignore all ESLint errors during build
    ignoreDuringBuilds: true,
  },
  transpilePackages: [
    '@mui/material',
    '@mui/icons-material',
    '@mui/system',
    '@mui/utils',
    '@emotion/react',
    '@emotion/styled'
  ],
  // Increase the webpack chunk loading timeout and configure other performance settings
  webpack: (config, { dev, isServer }) => {
    // Only apply these settings in development mode
    if (dev && !isServer) {
      // Increase chunk loading timeout to 60 seconds (60000ms)
      config.output = {
        ...config.output,
        chunkLoadTimeout: 60000,
      };

      // Optimize for development performance
      config.optimization = {
        ...config.optimization,
        runtimeChunk: 'single',
        splitChunks: {
          chunks: 'all',
          cacheGroups: {
            vendors: {
              test: /[\\/]node_modules[\\/](?!.*\.css$)/,  // Exclude CSS files from vendors chunk
              name: 'vendors',
              priority: -10,
              reuseExistingChunk: true,
            },
            styles: {
              name: 'styles',
              test: /\.css$/,
              chunks: 'all',
              enforce: true,
              priority: 20,
            },
          },
        },
      };

      // Configure watchOptions for better file watching
      config.watchOptions = {
        ...config.watchOptions,
        poll: 1000, // Check for changes every second
        aggregateTimeout: 300, // Delay before rebuilding
      };
    }

    // Exclude node binary files from being processed by webpack
    config.externals = [...(config.externals || []),
      {
        sharp: 'commonjs sharp',
        'node-gyp-build': 'commonjs node-gyp-build'
      }
    ];

    // Handle binary modules properly
    config.module = {
      ...config.module,
      rules: [
        ...(config.module?.rules || []),
        {
          test: /\.node$/,
          use: 'node-loader',
        },
      ],
    };

    // Enable WebAssembly
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };

    return config;
  },
};

export default nextConfig;
