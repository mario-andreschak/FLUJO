# Run the npm package

```bash
npx flujo-ai@latest
```

This runs a prebuilt FLUJO with no git clone or local build. Your data lives in
`~/.flujo` by default (override with `FLUJO_DATA_DIR`); the port defaults to 4200
(`--port` / `FLUJO_PORT`), and the browser opens automatically unless you pass
`--no-open`. MCP servers may still need `git`, `python`/`uv`, or Node on your
`PATH`. To update, just rerun with `npx flujo-ai@latest`. (The npm package is
`flujo-ai` — the name `flujo` is blocked by npm's similarity rules — but the
installed command is still `flujo`.)

Embedding launchers can set `FLUJO_BOOTSTRAP_DIR` to an absolute directory before
starting FLUJO. Both the npm entry point and the Next launcher then load dotenv
files and keep runtime environment settings in that directory. An empty or
relative override fails before loading dotenv. Without the override, the npm
entry point uses `~/.flujo`, and the Next launcher uses its working directory
(or `/app/data` in a container). The override selects environment settings only;
set `FLUJO_DATA_DIR` and `FLUJO_LOCAL_INSTANCE_DIR` separately when isolating an
embedded instance's data and discovery records. Supply a clean child environment
as well: this option does not clear already inherited credentials or settings.
Keep data and discovery directories outside the package's `public` and
`.next/static` folders; native launchers reject direct or aliased locations there.

[Back to installation](install.md) · [Start here](README.md)
