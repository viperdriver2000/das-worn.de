// Worker endpoint: POST /api/chat
// Uses Cloudflare Workers AI (bound as env.AI) to answer questions about
// the podcast. No external API key required.

import episodes from "../../data/episodes.json";
import stats from "../../data/stats.json";
import gags from "../../data/gags-resolved.json";

// Llama 3.3 70b fast — solid German support, runs on Workers AI.
// Smaller fallback if the big one is overloaded.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const FALLBACK_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

const HOST_INFO_TXT = `
HOSTS:
- Etienne Gardé (oft "Eddi" / "Eddie"): Schauspieler, Moderator, Synchronsprecher. Mitgründer von Rocket Beans TV.
- Jochen Dominicus: Mann mit USB-Maus, Hund Carlo, ruft öfter mal die Polizei. Co-Host von "Pinkelpause".
- Georg Zaal ("Onkel Barlow"): Der Rätselmeister, stellt fast immer am Folgenende das Rätsel. Herrchen von Hund Poppy (dem heimlichen vierten Host).
`;

// slim=true erzeugt einen deutlich kürzeren Prompt für CPU-Inferenz (Ollama):
// ohne den kompletten ~360-Folgen-Index und nur mit den Top-Running-Gags.
// Der volle Prompt würde auf CPU minutenlange Prefill-Zeit verursachen.
function buildSystemPrompt({ slim = false } = {}) {
  const gagsSorted = Object.values(gags)
    .filter((g) => g && g.name)
    .sort((a, b) => b.episodeCount - a.episodeCount);
  const gagList = (slim ? gagsSorted.slice(0, 12) : gagsSorted)
    .map((g) => `- ${g.name} (${g.episodeCount} Folgen): ${g.description}`)
    .join("\n");

  const w = stats.winners || {};
  const winners = `Stand der Punktetabelle: Jochen ${w.jochen || 0}, Etienne ${w.etienne || 0}, Georg ${w.georg || 0}.`;

  const folgenSection = slim
    ? `FOLGEN: Es gibt ${stats.episodeCount} Folgen. Der vollständige Titel-Index ist hier nicht eingebettet – wenn du eine genaue Folgennummer nicht sicher kennst, verweise auf die Suche unter /folgen.`
    : `FOLGEN-INDEX (Auszug der Titel):\n${episodes.map((e) => `#${e.number} ${e.title}`).join("\n")}`;

  const folgenRule = slim
    ? "- Nenne Folgennummern nur, wenn du dir sicher bist. Erfinde keine Nummern/Titel; im Zweifel auf die Suche unter /folgen verweisen."
    : '- Wenn du eine konkrete Folgennummer/Titel kennst, nenne sie (z.B. "siehe Folge #100 Dreistellig").';

  return `Du bist der freundliche Wiki-Assistent von "das worn" – dem Wiki Ohne Richtigen Namen zum Podcast ohne richtigen Namen mit Etienne Gardé, Jochen Dominicus und Georg Zaal. Antworte auf Deutsch, locker und prägnant.

${HOST_INFO_TXT}

ZAHLEN:
- ${stats.episodeCount} Folgen erfasst, ~${stats.estimatedHours}h Hörzeit, ${stats.totalWords.toLocaleString("de-DE")} Wörter.
- ${winners}

WIEDERKEHRENDE THEMEN:
${gagList}

${folgenSection}

REGELN:
${folgenRule}
- Wenn du etwas nicht sicher weißt, sag es offen. Erfinde keine Rätselauflösungen.
- Halte Antworten kurz: meist 1-3 Sätze, mehr nur auf Nachfrage.
- Pommes-Witze sind erlaubt.`;
}

const SYSTEM = buildSystemPrompt();
const SYSTEM_SLIM = buildSystemPrompt({ slim: true });

async function runModel(env, modelId, messages) {
  return await env.AI.run(modelId, {
    messages: [{ role: "system", content: SYSTEM }, ...messages],
    max_tokens: 500,
    temperature: 0.7,
  });
}

// Self-hosted alternative (node1 migration): talk to an Ollama server instead
// of Workers AI. Activated by the OLLAMA_URL env var. Reads process.env first
// (Node/systemd), falls back to Hono bindings (c.env) — so the same file works
// both on Cloudflare Workers and on the Node deployment.
function getOllama(c) {
  const penv = (typeof process !== "undefined" && process.env) ? process.env : {};
  const url = penv.OLLAMA_URL || c.env?.OLLAMA_URL;
  if (!url) return null;
  return {
    url: url.replace(/\/$/, ""),
    model: penv.OLLAMA_MODEL || c.env?.OLLAMA_MODEL || "llama3.1:8b",
  };
}

async function runOllama(ollama, messages) {
  const r = await fetch(`${ollama.url}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: ollama.model,
      messages: [{ role: "system", content: SYSTEM_SLIM }, ...messages],
      stream: false,
      options: { temperature: 0.7, num_predict: 350 },
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  const j = await r.json();
  return { response: (j?.message?.content || "").trim() };
}

export async function handleChat(c) {
  const env = c.env;
  const ollama = getOllama(c);
  if (!env?.AI && !ollama) {
    return c.json({
      error: "Chat ist gerade deaktiviert – weder Workers AI (env.AI) noch OLLAMA_URL ist gesetzt.",
    }, 503);
  }

  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return c.json({ error: "messages array required" }, 400);
  }
  if (messages.length > 30) {
    return c.json({ error: "Konversation zu lang. Frische sie neu auf." }, 400);
  }
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) {
      return c.json({ error: "Each message needs role user|assistant" }, 400);
    }
    if (typeof m.content !== "string" || m.content.length > 2000) {
      return c.json({ error: "Each message.content must be a string ≤2000 chars" }, 400);
    }
  }

  let result;
  let usedModel;
  if (ollama) {
    usedModel = ollama.model;
    try {
      result = await runOllama(ollama, messages);
    } catch (e) {
      return c.json({ error: "Ollama Fehler", detail: String(e).slice(0, 200) }, 502);
    }
  } else {
    usedModel = MODEL;
    try {
      result = await runModel(env, MODEL, messages);
    } catch (e) {
      try {
        result = await runModel(env, FALLBACK_MODEL, messages);
        usedModel = FALLBACK_MODEL;
      } catch (e2) {
        return c.json({ error: "Workers AI Fehler", detail: String(e2).slice(0, 200) }, 502);
      }
    }
  }

  const text = (result?.response || result?.result?.response || "").trim();
  if (!text) return c.json({ error: "Leere Antwort vom Modell" }, 502);
  return c.json({ reply: text, model: usedModel });
}
