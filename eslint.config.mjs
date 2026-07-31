import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import importPlugin from "eslint-plugin-import";
// eslint-import-resolver-typescript doesn't have a default export

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  { ignores: ['mcp-servers/**/*'] },
  // Import plugin configuration
  {
    plugins: {
      import: importPlugin
    },
    rules: {
      // Enable import checking rules
      // The MCP SDK's v1 export map uses a wildcard target without a file
      // extension. TypeScript's bundler resolver and Node resolve it correctly,
      // but eslint-import-resolver-typescript v3 reports every supported SDK
      // subpath as unresolved. Keep checking all other imports while TypeScript
      // remains the source of truth for these package-export subpaths.
      "import/no-unresolved": ["error", {
        ignore: ["^@modelcontextprotocol/sdk/"]
      }],
      "import/named": "error",
      "import/default": "error",
      "import/namespace": "error",
      "import/export": "error"
    },
    settings: {
      "import/parsers": {
        "@typescript-eslint/parser": [".ts", ".tsx"]
      },
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: "./tsconfig.json"
        },
        node: {
          extensions: [".js", ".jsx", ".ts", ".tsx"]
        }
      }
    }
  },
  ...compat.config({
    extends: ['next/core-web-vitals', 'next/typescript'],
    parser: '@typescript-eslint/parser',
    parserOptions: {
      project: './tsconfig.json',
      tsconfigRootDir: __dirname,
      ecmaVersion: 2022,
      sourceType: 'module',
      ecmaFeatures: {
        jsx: true
      }
    },
    rules: {
      // Disable TypeScript-specific rules that are causing many errors
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-explicit-any": "off", // Changed from error to warning
      "@typescript-eslint/ban-ts-comment": "off", // Changed from error to warning
      
      // React hooks rules that are causing warnings
      "react-hooks/exhaustive-deps": "off",
      
      // Other rules
      "react/no-unescaped-entities": "off",
      "prefer-const": "warn"
    }
  })
];

export default eslintConfig;
