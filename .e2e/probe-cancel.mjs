import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
const hits = [];
const server = createServer((req, res) => {
  hits.push(`${req.method} ${req.url}`);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("{}");
});
await new Promise((r) => server.listen(18191, "127.0.0.1", r));

const mod = await import(pathToFileURL("F:/MinimaxH3/repo/dist-electron/main/backends/rbAdapter.js").href);
const { RbAdapter } = mod;
const adapter = new RbAdapter({ baseUrl: "http://127.0.0.1:18191", cardCode: "t", outputDirectory: "F:/tmp" });
await adapter.cancel("some-job");
await new Promise(r => setTimeout(r, 300));
console.log("hits:", hits.join(" | ") || "(none)");
server.close();
