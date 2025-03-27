module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "react", "react-hooks", "import"],
  extends: [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
    "plugin:import/errors",
    "plugin:import/warnings",
    "plugin:import/typescript",
  ],
  parserOptions: {
    ecmaVersion: 2020,
    sourceType: "module",
    ecmaFeatures: {
      jsx: true,
    },
    project: "./tsconfig.json",
  },
  settings: {
    react: {
      version: "detect",
    },
  },
  rules: {
    // Catch unused variables and imports
    "@typescript-eslint/no-unused-vars": [
      "error",
      {
        vars: "all",
        args: "after-used",
        ignoreRestSiblings: true,
      },
    ],
    "import/no-unused-modules": [1, { unusedExports: true }],
    "no-unused-vars": "off", // Turn off the base rule as it can report incorrect errors

    // Other rules
    "no-console": "warn",
    "@typescript-eslint/explicit-module-boundary-types": "off",
    "@typescript-eslint/no-explicit-any": "warn",
    "react/prop-types": "off",
    "react/react-in-jsx-scope": "off",
  },
  ignorePatterns: [
    "node_modules/**",
    "dist/**",
    "build/**",
    "*.config.js",
    ".eslintrc.js",
  ],
  overrides: [
    {
      files: ["electron/**/*.js"],
      parser: "espree",
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: "module",
        project: null,
        requireConfigFile: false,
      },
      env: {
        node: true,
      },
      rules: {
        "@typescript-eslint/no-require-imports": "off",
        "@typescript-eslint/no-unused-expressions": "off",
      },
    },
  ],
};
