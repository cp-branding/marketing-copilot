// Profil-Zusammenfassung (LLM-generiert, in Supabase gecached).
// GET  /api/profile-summary  → { summary: {...}|null, stale: bool }
//                               (stale=true heißt: Profil hat sich geändert, neu generieren)
// POST /api/profile-summary  → triggert (Re-)Generierung, liefert frische Summary
//
// Gecached wird in Tabelle copilot_profile_summaries. Key: user_email.
// Invalidierung via SHA-Hash des profile_text.
//
// SQL-Schema siehe: supabase/copilot_profile_summaries.sql

import crypto from 'crypto';

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 3000;

function getAuthedEmail(req) {
  const cookie = req.headers.cookie || '';
  const sessionMatch = cookie.match(/(?:^|; )mk_session=([^;]+)/);
  if (!sessionMatch || sessionMatch[1] !== process.env.SESSION_SECRET) return null;
  const userMatch = cookie.match(/(?:^|; )mk_user=([^;]+)/);
  if (!userMatch) return null;
  try { return decodeURIComponent(userMatch[1]); } catch { return null; }
}

function hashProfile(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

const SUMMARY_SYSTEM = `Du produzierst eine strukturierte Zusammenfassung eines Marketing-Profils.

STRICT OUTPUT: NUR gültiges JSON. Nichts davor, nichts danach. Keine Markdown-Code-Blöcke. Direkt { bis }.

SCHEMA:
{
  "specs": [ "string", ... ],
  "summary": "string",
  "key_findings": [ { "title": "string", "text": "string" }, ... ],
  "daily_inspirations": [ "string", ... ]
}

STIL: direkt, warm, intelligent. Trockener Humor erlaubt. Kein Corporate-Bla, keine Motivationssprache. Keine Füllwörter. Englische Begriffe nur wo präziser. Deutsch.

specs — 5-6 wichtigste Fakten fürs Dashboard. Format "Label: Wert", je max. 60 Zeichen. Nimm: Branche/Angebot, Zielgruppe, Teamgröße, aktive Kanäle (kurz), Budget, Zeit. Wenn ein Feld "unklar" ist, zeig das auch so ("Budget: unklar").

summary — 3-4 Sätze, ein Absatz. Wie würde ein smarter Berater diesen Menschen in einem Call einordnen? Pointiert, keine Lobhudelei. Benennt auch Spannungen/Lücken.

key_findings — 3-5 Einträge. Mix aus:
  • Stärken (was im Profil auffällt und nutzbar ist)
  • Blinde Flecken (was fehlt und warum relevant)
  • Risiken / Widersprüche im Profil
title = 2-4 Wörter. text = 1-2 Sätze, spezifisch, nicht generisch.

daily_inspirations — GENAU 30 Einträge. Jeder ein heute-umsetzbarer Mini-Impuls, max. 140 Zeichen. Auf Budget + Zeit des Users zugeschnitten (kein "10k in Ads", wenn Budget klein ist). Keine Plattitüden ("Poste mehr auf LinkedIn!"). Konkret: "Schreib 3 deiner lautesten Kunden eine persönliche Frage mit Bezug auf ihren letzten Post — heute Nachmittag."

Niemals dreimal dieselbe Idee in verschiedenen Worten. Variation über Kanäle, Zeitrahmen, Aufwand.`;

function parseJson(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

export default async function handler(req, res) {
  const email = getAuthedEmail(req);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  const sbHeaders = {
    'apikey': process.env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  const encodedEmail = encodeURIComponent(email);

  async function fetchProfileText() {
    const r = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/copilot_profiles?user_email=eq.${encodedEmail}&select=profile_text`,
      { headers: sbHeaders }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0]?.profile_text || null;
  }

  async function fetchCached() {
    const r = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/copilot_profile_summaries?user_email=eq.${encodedEmail}&select=*`,
      { headers: sbHeaders }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] || null;
  }

  if (req.method === 'GET') {
    const cached = await fetchCached();
    if (!cached) return res.status(200).json({ summary: null, stale: false });

    const profileText = await fetchProfileText();
    const currentHash = profileText ? hashProfile(profileText) : null;
    const stale = !!currentHash && currentHash !== cached.profile_hash;

    return res.status(200).json({
      summary: {
        specs: cached.specs,
        summary: cached.summary,
        key_findings: cached.key_findings,
        daily_inspirations: cached.daily_inspirations,
        updated_at: cached.updated_at,
      },
      stale,
    });
  }

  if (req.method === 'POST') {
    const profileText = await fetchProfileText();
    if (!profileText) return res.status(400).json({ error: 'kein_profil' });

    let anthropicRes;
    try {
      anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: SUMMARY_SYSTEM,
          messages: [{ role: 'user', content: `PROFIL:\n\n${profileText}` }],
        }),
      });
    } catch (err) {
      return res.status(502).json({ error: 'anthropic_unreachable', detail: err.message });
    }

    const data = await anthropicRes.json();
    if (!anthropicRes.ok) {
      return res.status(502).json({ error: 'anthropic_error', detail: data });
    }

    const text = data.content?.[0]?.text || '';
    const parsed = parseJson(text);
    if (!parsed || !Array.isArray(parsed.specs) || !Array.isArray(parsed.daily_inspirations)) {
      return res.status(500).json({ error: 'parse_failed', raw: text.slice(0, 500) });
    }

    const payload = {
      user_email: email,
      profile_hash: hashProfile(profileText),
      specs: parsed.specs,
      summary: parsed.summary || '',
      key_findings: parsed.key_findings || [],
      daily_inspirations: parsed.daily_inspirations,
      model: MODEL,
      updated_at: new Date().toISOString(),
    };

    const upsert = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/copilot_profile_summaries?on_conflict=user_email`,
      {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(payload),
      }
    );
    if (!upsert.ok) {
      const detail = await upsert.text().catch(() => '');
      return res.status(500).json({ error: 'db_error', detail });
    }

    return res.status(200).json({
      summary: {
        specs: payload.specs,
        summary: payload.summary,
        key_findings: payload.key_findings,
        daily_inspirations: payload.daily_inspirations,
        updated_at: payload.updated_at,
      },
      stale: false,
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
