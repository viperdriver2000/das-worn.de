// Node entry point for the node1 (Proxmox) deployment.
// Wraps the same Hono app that runs on Cloudflare Workers, but:
//   - serves ./public via the filesystem (replaces the CF [assets] binding)
//   - listens on a real TCP port behind Caddy
// The Worker entry (src/index.js, default export) stays unchanged.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import app from "./index.js";

// Registered after the routes in index.js, so declared routes win; only genuine
// files under ./public are served and misses fall through to the 404 handler.
app.use("*", serveStatic({ root: "./public" }));

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`das-worn listening on http://0.0.0.0:${info.port}`);
});
