// Chat-Session Persistierung: pro User + Mode eine Zeile in copilot_sessions
// GET  /api/session               → { quick: {...}, holistic: {...}, roast: {...}, onboarding: {...} }
// POST /api/session               → body: { mode, msgs, answerCount }
// DELETE /api/session?mode=<mode> → löscht die Session für einen Mode

const MAX_PAYLOAD_BYTES = 500_000;

function getAuthedEmail(req) {
  const cookie = req.headers.cookie || '';
  const sessionMatch = cookie.match(/(?:^|; )mk_session=([^;]+)/);
  if (!sessionMatch || sessionMatch[1] !== process.env.SESSION_SECRET) return null;
  const userMatch = cookie.match(/(?:^|; )mk_user=([^;]+)/);
  if (!userMatch) return null;
  try { return decodeURIComponent(userMatch[1]); } catch { return null; }
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

  if (req.method === 'GET') {
    const r = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/copilot_sessions?user_email=eq.${encodedEmail}&select=mode,messages,answer_count,updated_at`,
      { headers: sbHeaders }
    );
    if (!r.ok) return res.status(500).json({ error: 'DB error' });
    const rows = await r.json();
    const out = {};
    for (const row of rows) {
      out[row.mode] = {
        msgs: row.messages || [],
        answerCount: row.answer_count || 0,
        updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : Date.now(),
      };
    }
    return res.status(200).json(out);
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const mode = typeof body.mode === 'string' ? body.mode : '';
    const msgs = Array.isArray(body.msgs) ? body.msgs : null;
    const answerCount = Number.isFinite(body.answerCount) ? body.answerCount : 0;

    if (!mode || !msgs) return res.status(400).json({ error: 'mode und msgs erforderlich' });
    if (mode.length > 32) return res.status(400).json({ error: 'mode zu lang' });

    const payload = {
      user_email: email,
      mode,
      messages: msgs,
      answer_count: answerCount,
      updated_at: new Date().toISOString(),
    };
    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      return res.status(413).json({ error: 'Session zu groß' });
    }

    const r = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/copilot_sessions?on_conflict=user_email,mode`,
      {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
        body: serialized,
      }
    );
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(500).json({ error: 'DB error', detail });
    }
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const mode = typeof req.query?.mode === 'string' ? req.query.mode : '';
    if (!mode) return res.status(400).json({ error: 'mode erforderlich' });

    const r = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/copilot_sessions?user_email=eq.${encodedEmail}&mode=eq.${encodeURIComponent(mode)}`,
      { method: 'DELETE', headers: sbHeaders }
    );
    if (!r.ok) return res.status(500).json({ error: 'DB error' });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
