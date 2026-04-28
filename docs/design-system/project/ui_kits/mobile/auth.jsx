// Auth screen — login + signup, with ASCII welcome banner.

const AuthScreen = ({ onLogin }) => {
  const [mode, setMode] = React.useState('login');
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [name, setName] = React.useState('');

  return (
    <div className="auth-screen">
      <div className="auth-banner">
        <img className="auth-logo" src="../../assets/orbital-logo-light-lg.svg" alt="Orbital" />
        <div className="ascii-banner">{`╔═══════════════════════════╗
║   Welcome to Orbital!     ║
║   Your orbit awaits...    ║
╚═══════════════════════════╝`}</div>
        <div className="auth-title">Orbital</div>
        <div className="auth-sub">{mode === 'login' ? 'Log in to your orbits.' : 'Create your account.'}</div>
      </div>

      <div className="auth-form">
        {mode === 'signup' && (
          <input className="o-input" placeholder="Display name" value={name} onChange={e => setName(e.target.value)} />
        )}
        <input className="o-input" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
        <input className="o-input" placeholder="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} />
        {mode === 'signup' && <input className="o-input" placeholder="Confirm password" type="password" />}

        <button className="btn btn-primary auth-submit" onClick={onLogin}>
          {mode === 'login' ? 'Log In' : 'Sign Up'}
        </button>

        <div className="auth-switch">
          {mode === 'login' ? (
            <>Don't have an account? <a onClick={() => setMode('signup')}>Sign up</a></>
          ) : (
            <>Already have an account? <a onClick={() => setMode('login')}>Log in</a></>
          )}
        </div>
      </div>
    </div>
  );
};

window.AuthScreen = AuthScreen;
