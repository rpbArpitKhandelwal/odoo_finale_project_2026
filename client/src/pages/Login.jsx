import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { LogoMark, Wordmark } from '../components/Logo';

const DEMO = [
  ['Sales Rep', 'rep@dealflow.io', 'Rep@123'],
  ['Sales Manager', 'manager@dealflow.io', 'Manager@123'],
  ['Finance', 'finance@dealflow.io', 'Finance@123'],
  ['Admin', 'admin@dealflow.io', 'Admin@123'],
];

export default function Login() {
  const { login, signup } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      if (mode === 'login') await login(email, password);
      else await signup(name, email, password);
      nav('/');
    } catch (ex) { setErr(ex.message); }
    setBusy(false);
  };

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="logo-big"><LogoMark size={64} variant="dark" /></div>
        <h1><Wordmark size={26} accent="#017E84" /></h1>
        <div className="tag">Intelligent, Self-Governing Sales Operations</div>
        <form onSubmit={submit}>
          {mode === 'signup' && (
            <div className="field">
              <label className="f">Full name</label>
              <input className="f" value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" required />
            </div>
          )}
          <div className="field">
            <label className="f">Email</label>
            <input className="f" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@dealflow.io" required />
          </div>
          <div className="field">
            <label className="f">Password</label>
            <input className="f" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />
          </div>
          {err && <div style={{ color: '#CD3D63', fontSize: 12.5, margin: '4px 0 8px' }}>{err}</div>}
          <button className="btn-new" style={{ width: '100%', justifyContent: 'center', padding: '10px' }} disabled={busy}>
            {busy ? 'Signing in…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        <div style={{ textAlign: 'center', marginTop: 12, fontSize: 12.5 }}>
          {mode === 'login' ? <>New rep? <a onClick={() => { setMode('signup'); setErr(''); }}>Create an account</a></> : <>Have an account? <a onClick={() => { setMode('login'); setErr(''); }}>Sign in</a></>}
        </div>
        <div className="demo-creds">
          <b>Demo accounts</b> (click to fill):
          {DEMO.map(([label, em, pw]) => (
            <div key={em} style={{ display: 'flex', justifyContent: 'space-between', margin: '4px 0' }}>
              <span>{label}</span>
              <code onClick={() => { setEmail(em); setPassword(pw); setMode('login'); }}>{em}</code>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
