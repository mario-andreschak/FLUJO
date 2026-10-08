# Anonymous daily-active collector contract

FLUJO attempts one `POST` per active installation per UTC day:

```http
POST /v1/telemetry/daily-active
Content-Type: application/json
```

```json
{
  "anonymousDailyId": "11111111-1111-4111-8111-111111111111",
  "date": "2026-07-29",
  "version": "3.31.0",
  "platform": "win32",
  "installMethod": "git"
}
```

The collector should validate the exact allowlist above, accept only a current
or recent UTC date, and insert with a unique constraint on
`(date, anonymous_daily_id)`. The daily-active count is the number of rows for a
date. Respond with any `2xx` status; FLUJO does not consume a response body.

The random ID changes every UTC day. It must not be joined to IP addresses,
user agents, registry accounts, cookies, or other identifiers. Request logs
should omit or promptly discard source IP and user-agent data. The endpoint
should be rate-limited without creating a durable client fingerprint.

The default collector URL is:

```text
https://registry.flujo.com.co/v1/telemetry/daily-active
```

Self-hosted builds can override the complete URL with
`FLUJO_TELEMETRY_URL`. A collector failure is intentionally not retried until
the next UTC day and never blocks FLUJO.

The same endpoint exposes only the aggregate used by **Settings → Privacy &
Usage**:

```http
GET /v1/telemetry/daily-active?date=2026-07-29
```

```json
{ "date": "2026-07-29", "count": 42 }
```
