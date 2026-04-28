// Settings — profile card + ASCII section headers + list rows + quota bar.

const SettingsRow = ({ icon, label, value, chevron = true, destructive }) => (
  <button className={`setrow ${destructive ? 'is-destructive' : ''}`}>
    <span className="setrow-ico">{icon}</span>
    <span className="setrow-lbl">{label}</span>
    {value && <span className="setrow-val">{value}</span>}
    {!destructive && chevron && <span className="setrow-chev">▸</span>}
  </button>
);

const QuotaBar = ({ used, total }) => {
  const pct = Math.min(100, Math.round((used / total) * 100));
  const color = pct > 90 ? 'var(--color-error)' : pct > 75 ? 'var(--color-warning)' : 'var(--color-blue)';
  return (
    <div className="quota">
      <div className="quota-track">
        <div className="quota-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="quota-lbl">{used}/{total} MB</div>
    </div>
  );
};

const SectionHeader = ({ label }) => (
  <div className="set-section">{`─── ${label} ───`}</div>
);

const ProfileCard = () => (
  <div className="profile-card">
    <Avatar name="Alex" color="#9B87F5" size={48} />
    <div className="profile-info">
      <div className="profile-name">Alex G.</div>
      <div className="profile-handle">alex@orbit.example</div>
    </div>
    <span className="profile-edit">Edit →</span>
  </div>
);

const SettingsScreen = () => (
  <div className="settings-screen">
    <Header title="Settings" />
    <div className="settings-scroll">
      <ProfileCard />

      <SectionHeader label="Appearance" />
      <SettingsRow icon="🌙" label="Theme" value="Light" />

      <SectionHeader label="Notifications" />
      <SettingsRow icon="🔔" label="Push" value="On" />
      <SettingsRow icon="📳" label="Sounds" value="On" />

      <SectionHeader label="Privacy" />
      <SettingsRow icon="🔒" label="Safety Numbers" />
      <SettingsRow icon="👁️" label="Read Receipts" value="On" />

      <SectionHeader label="Storage" />
      <SettingsRow icon="📁" label="File Library" />
      <QuotaBar used={240} total={500} />

      <SectionHeader label="Account" />
      <SettingsRow icon="📤" label="Invite Friends" />
      <SettingsRow icon="🚪" label="Log Out" destructive chevron={false} />
    </div>
  </div>
);

Object.assign(window, { SettingsScreen, SettingsRow, QuotaBar, ProfileCard });
