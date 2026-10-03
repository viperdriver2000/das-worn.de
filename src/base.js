// Deployment-Kontext für das Node-Deployment.
//
// Standard ist die Domain-Wurzel (https://das-worn.de) – dort sind BASE_PATH und
// die daraus gebauten Links leer bzw. unverändert. Für einen Betrieb unter einem
// Unterpfad (z. B. hinter einem Apache-Proxy unter https://host/das-worn) wird
// BASE_PATH=/das-worn gesetzt; alle internen Links, Asset-URLs und Sitemap-Einträge
// bekommen dann dieses Präfix. Der Proxy strippt es vor dem Weiterleiten an die App.
//
// Auf Cloudflare Workers existiert kein `process` – dort bleibt alles wie bisher.
const env = typeof process !== "undefined" && process.env ? process.env : {};

export const BASE_PATH = (env.BASE_PATH || "").replace(/\/+$/, "");

export const SITE_URL = (env.SITE_URL || "https://das-worn.de").replace(/\/+$/, "");

/** Interner Pfad -> URL inkl. Unterpfad-Präfix. */
export const u = (path) => `${BASE_PATH}${path}`;

/** Absolute URL (Canonical, og:url, Sitemap) inkl. Unterpfad. */
export const abs = (path = "/") => `${SITE_URL}${BASE_PATH}${path}`;
