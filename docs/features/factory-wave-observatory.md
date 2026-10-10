# FACTORY in the Wave Observatory

The Wave Observatory has a separate **FACTORY** view for the durable swarm
controlled by FACTORY. The existing Playground and Day views continue to show
FLUJO planned executions, flows, and automation relationships. A FLUJO
automation is not treated as a FACTORY worker cell.

Run FACTORY's authenticated presentation server on the same machine as FLUJO,
then set these **server-side** environment variables before starting FLUJO:

```text
FACTORY_OBSERVATORY_URL=http://127.0.0.1:4343/v1/snapshot
FACTORY_OBSERVATORY_ID=<the configured factory ID>
FACTORY_OBSERVATORY_TOKEN=<the presentation viewer token>
```

The URL must be an explicit `127.0.0.1` FACTORY snapshot endpoint. The FLUJO
route works only in localhost exposure mode from a loopback request. It validates
the FACTORY ID and cell hierarchy, then sends a limited read-only projection to
the browser. The bearer is never included in the response. Missing configuration
or an unavailable source appears as an explicit state in the FACTORY view; prior
data is labeled stale when refresh fails. The view does not issue FACTORY commands
or provision workers.
