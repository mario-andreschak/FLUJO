module.exports = {
  "root": true,
  "parser": "espree",
  "parserOptions": {
    "ecmaVersion": 2020,
    "sourceType": "module"
  },
  "env": {
    "node": true
  },
  "plugins": [],
  "rules": {
    // Disable all TypeScript rules
    "@typescript-eslint/no-require-imports": "off",
    "@typescript-eslint/no-unused-expressions": "off"
  }
} 