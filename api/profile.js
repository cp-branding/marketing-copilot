// User-Profil Persistierung: eine Zeile pro User in copilot_profiles
// GET    /api/profile   → { profile: "..." | null }
// POST   /api/profile   → body: { profile: "..." }   (upsert)
// DELETE /api/profile   → löscht das Profil

const MAX_PROFILE_BYTES = 10_000;

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
      `${process.env.SUPABASE_URL}/rest/v1/copilot_profiles?user_email=eq.${encodedEmail}&select=profile_text`,
      { headers: sbHeaders }
    );
    if (!r.ok) return res.status(500).json({ error: 'DB error' });
    const rows = await r.json();
    return res.status(200).json({ profile: rows[0]?.profile_text || null });
  }

  if (req.method === 'POST') {
    const body = req.body || {};
    const profile = typeof body.profile === 'string' ? body.profile.trim() : '';
    if (!profile) return res.status(400).json({ error: 'profile erforderlich' });
    if (profile.length > MAX_PROFILE_BYTES) {
      return res.status(413).json({ error: 'Profil zu groß' });
    }

    const payload = {
      user_email: email,
      profile_text: profile,
      updated_at: new Date().toISOString(),
    };

    const r = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/copilot_profiles?on_conflict=user_email`,
      {
        method: 'POST',
        headers: { ...sbHeaders, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(payload),
      }
    );
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      return res.status(500).json({ error: 'DB error', detail });
    }
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const r = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/copilot_profiles?user_email=eq.${encodedEmail}`,
      { method: 'DELETE', headers: sbHeaders }
    );
    if (!r.ok) return res.status(500).json({ error: 'DB error' });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
