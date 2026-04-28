// PhoneFrame — iPhone 14 (390x844 pt) bezel + Dynamic Island + home indicator.
// Renders children inside a fixed 390x844 viewport and clips to the bezel radius.

const PhoneFrame = ({ children, theme = 'light' }) => (
  <div className="phone" data-theme={theme}>
    <div className="phone-bezel">
      <div className="phone-screen">
        <StatusBar theme={theme} />
        <div className="phone-content">{children}</div>
      </div>
      <div className="phone-island" />
    </div>
  </div>
);

const StatusBar = ({ theme }) => (
  <div className="status-bar">
    <div className="sb-time">9:41</div>
    <div className="sb-right">
      <span>􀙇</span>
      <span>􀙨</span>
      <span style={{ marginLeft: 4 }}>􀛨</span>
    </div>
  </div>
);

// 3-tab bottom navigation. Uses OpenMoji glyphs at 24px.
const TabBar = ({ active, onSelect }) => {
  const tabs = [
    { id: 'threads',  label: 'Threads',  cp: '1F4AC' },
    { id: 'chats',    label: 'Chats',    cp: '1F4E8' },
    { id: 'settings', label: 'Settings', cp: '2699'  },
  ];
  return (
    <div className="tab-bar">
      {tabs.map(t => (
        <button key={t.id} className={`tab ${active === t.id ? 'is-active' : ''}`} onClick={() => onSelect(t.id)}>
          <img className="tab-ico" src={`https://cdn.jsdelivr.net/npm/openmoji@15.1.0/color/svg/${t.cp}.svg`} alt="" />
          <div className="tab-lbl">{t.label}</div>
        </button>
      ))}
      <div className="home-indicator" />
    </div>
  );
};

Object.assign(window, { PhoneFrame, StatusBar, TabBar });
