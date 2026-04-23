export default function handler(req, res) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|; )mk_session=([^;]+)/);
  const sessionValid = !!match && match[1] === process.env.SESSION_SECRET;

  if (sessionValid) {
    return res.status(200).json({ authenticated: true });
  } else {
    return res.status(401).json({ authenticated: false });
  }
}
