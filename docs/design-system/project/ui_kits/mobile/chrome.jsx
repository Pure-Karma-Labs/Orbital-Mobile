// Header bar (push-style) + ASCII helpers + bottom sheet.

const Header = ({ left, title, right, border = true }) => (
  <div className={`hdr ${border ? 'hdr-bordered' : ''}`}>
    <div className="hdr-side hdr-left">{left}</div>
    <div className="hdr-title">{title}</div>
    <div className="hdr-side hdr-right">{right}</div>
  </div>
);

const BackButton = ({ onClick, label = 'Back' }) => (
  <button className="back-btn" onClick={onClick}>‹ {label}</button>
);

const PrimaryHeaderBtn = ({ onClick, children, disabled }) => (
  <button className="hdr-action" disabled={disabled} onClick={onClick}>{children}</button>
);

// ASCII separators
const AsciiDay = ({ label }) => <div className="ascii-day">{`─── ${label} ───`}</div>;
const AsciiSection = () => <div className="ascii-section">·  ·  ·  ✦  ·  ·  ·</div>;

// Bottom sheet shell — backdrop + handle + content.
const BottomSheet = ({ open, onClose, children }) => (
  <div className={`bsheet-root ${open ? 'is-open' : ''}`} onClick={onClose}>
    <div className="bsheet" onClick={e => e.stopPropagation()}>
      <div className="bsheet-handle" />
      {children}
    </div>
  </div>
);

const Avatar = ({ name, color = '#5B9FED', size = 36, online }) => {
  const initial = (name || '?').slice(0, 1).toUpperCase();
  return (
    <span className="avatar" style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}>
      {initial}
      {online != null && <span className={`avatar-pres ${online ? 'is-on' : 'is-off'}`} />}
    </span>
  );
};

Object.assign(window, { Header, BackButton, PrimaryHeaderBtn, AsciiDay, AsciiSection, BottomSheet, Avatar });
