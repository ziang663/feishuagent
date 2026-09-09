import { createServer, type Server } from "node:http";

export interface HealthState {
  ready: boolean;
  startedAt: string;
}

export function startHealthServer(port: number, state: HealthState): Server {
  const server = createServer((request, response) => {
    if (request.url !== "/healthz" && request.url !== "/readyz") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    const ready = request.url === "/healthz" || state.ready;
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: ready, ready: state.ready, started_at: state.startedAt }));
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[health] listening on 0.0.0.0:${port}`);
  });
  return server;
}
