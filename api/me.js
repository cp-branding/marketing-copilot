// User-Dashboard-Aggregator: alles was der Userbereich braucht in einem Call.
// GET /api/me → { email, profile: string|null, sessions: { quick, holistic, roast } }
//   sessions[mode] = { count, total, updatedAt }

const ENERGY_TOTALS = { quick: 5, holistic: 30, roast: 10 };

function getAuthedEmail(req) {
  const cookie = req.headers.cookie || '';
  const sessionMatch = cookie.match(/(?:^|; )mk_session=([^;]+)/);
  if (!sessionMatch || sessionMatch[1] !== process.env.SESSION_SECRET) return null;
  const userMatch = cookie.match(/(?:^|; )mk_user=([^;]+)/);
  if (!userMatch) return null;
  try { return decodeURIComponent(userMatch[1]); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const email = getAuthedEmail(req);
  if (!email) return res.status(401).json({ error: 'Unauthorized' });

  const sbHeaders = {
    'apikey': process.env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  const encodedEmail = encodeURIComponent(email);

  const [profileRes, sessionsRes] = await Promise.all([
    fetch(
      `${process.env.SUPABASE_URL}/rest/v1/copilot_profiles?user_email=eq.${encodedEmail}&select=profile_text`,
      { headers: sbHeaders }
    ),
    fetch(
      `${process.env.SUPABASE_URL}/rest/v1/copilot_sessions?user_email=eq.${encodedEmail}&select=mode,answer_count,updated_at`,
      { headers: sbHeaders }
    ),
  ]);

  if (!profileRes.ok || !sessionsRes.ok) {
    return res.status(500).json({ error: 'DB error' });
  }

  const profileRows = await profileRes.json();
  const sessionRows = await sessionsRes.json();

  const sessions = {};
  for (const mode of Object.keys(ENERGY_TOTALS)) {
    sessions[mode] = { count: 0, total: ENERGY_TOTALS[mode], updatedAt: null };
  }
  for (const row of sessionRows) {
    if (!sessions[row.mode]) continue;
    sessions[row.mode] = {
      count: row.answer_count || 0,
      total: ENERGY_TOTALS[row.mode],
      updatedAt: row.updated_at || null,
    };
  }

  return res.status(200).json({
    email,
    profile: profileRows[0]?.profile_text || null,
    sessions,
  });
}
