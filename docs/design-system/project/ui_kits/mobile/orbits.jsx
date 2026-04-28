// Orbit selector bottom sheet.

const OrbitItem = ({ icon, name, members, active, onClick }) => (
  <button className="orbit-item" onClick={onClick}>
    <span className="orbit-ico">{icon}</span>
    <span className="orbit-iname">{name}</span>
    <span className="orbit-mc">{members} 👥</span>
    {active && <span className="orbit-check">✓</span>}
  </button>
);

const OrbitSelectorSheet = ({ open, onClose, current, onSelect }) => (
  <BottomSheet open={open} onClose={onClose}>
    <div className="bsheet-section">─── Your Orbits ───</div>
    <OrbitItem icon="🪐" name="Family Orbit"     members={12} active={current === 'Family Orbit'}     onClick={() => onSelect('Family Orbit')} />
    <OrbitItem icon="🌍" name="College Friends"  members={8}  active={current === 'College Friends'}  onClick={() => onSelect('College Friends')} />
    <OrbitItem icon="🏠" name="Roommates"        members={4}  active={current === 'Roommates'}        onClick={() => onSelect('Roommates')} />

    <div className="bsheet-sep">·  ·  ·  ✦  ·  ·  ·</div>

    <div className="bsheet-actions">
      <button className="btn btn-secondary">+ Create Orbit</button>
      <button className="btn btn-outline">🔗 Join with Code</button>
    </div>
  </BottomSheet>
);

window.OrbitSelectorSheet = OrbitSelectorSheet;
