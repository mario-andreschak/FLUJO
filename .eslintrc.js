module.exports = {
  "overrides": [
    {
      "files": ["electron/**/*.js"],
      "parser": "espree",
      "parserOptions": {
        "ecmaVersion": 2020,
        "sourceType": "module",
        "project": null,
        "requireConfigFile": false
      },
      "env": {
        "node": true
      },
      "rules": {
        "@typescript-eslint/no-require-imports": "off",
        "@typescript-eslint/no-unused-expressions": "off"
      }
    }
  ]
} 