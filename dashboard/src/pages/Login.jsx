import { useEffect, useState } from 'react';
import { useWorkspace } from '../hooks/WorkspaceContext';
import { Button } from '../components/ui';
import hr from '../api/hr';

export default function Login() {
  const { signIn } = useWorkspace();
  const [usr, setUsr] = useState('');
  const [pwd, setPwd] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [branding, setBranding] = useState(null);

  // app_branding is guest-accessible, so the login screen carries the real
  // brand rather than a placeholder.
  useEffect(() => {
    let cancelled = false;
    hr.appBranding()
      .then((data) => { if (!cancelled) setBranding(data); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(usr.trim(), pwd);
    } catch (err) {
      setError(err.message || 'Sign in failed.');
      setBusy(false);
    }
  };

  const logo = branding?.login_logo_data || branding?.app_logo_data;
  const name = branding?.name || 'Techsarena HCM';

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <div className="login__brand">
          <span className="login__logo">{logo ? <img src={logo} alt="" /> : name.slice(0, 2).toUpperCase()}</span>
          <div>
            <h1 style={{ fontSize: 17 }}>{name}</h1>
            <p className="small subtle">HR &amp; administration</p>
          </div>
        </div>

        {error && <div className="login__error">{error}</div>}

        <div className="login__fields">
          <div>
            <label htmlFor="usr">Email</label>
            <input
              id="usr"
              type="email"
              autoComplete="username"
              value={usr}
              onChange={(e) => setUsr(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="pwd">Password</label>
            <input
              id="pwd"
              type="password"
              autoComplete="current-password"
              value={pwd}
              onChange={(e) => setPwd(e.target.value)}
              required
            />
          </div>
          <Button variant="indigo" type="submit" disabled={busy || !usr || !pwd} style={{ width: '100%', padding: 9 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </div>

        <p className="small subtle" style={{ marginTop: 'var(--space-5)', textAlign: 'center' }}>
          {branding?.show_dev_credit && branding?.developed_by
            ? `Developed by ${branding.developed_by}`
            : "Signs in against this Frappe site's own session."}
        </p>
      </form>
    </div>
  );
}
