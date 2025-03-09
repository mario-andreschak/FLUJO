import type { NextConfig } from "next";
import path from 'path';

const nextConfig: NextConfig = {
  /* config options here */
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
              test: /[\\/]node_modules[\\/]/,
              name: 'vendors',
              priority: -10,
              reuseExistingChunk: true,
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
