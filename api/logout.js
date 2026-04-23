export default function handler(req, res) {
  res.setHeader('Set-Cookie', [
    'mk_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
    'mk_user=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0'
  ]);
  res.redirect(302, '/login');
}
