// Full-screen composer modal (new thread).

const ComposerModal = ({ open, onClose }) => {
  const [title, setTitle] = React.useState('');
  const [body, setBody] = React.useState('');

  if (!open) return null;
  return (
    <div className="modal-root">
      <Header
        left={<button className="back-btn" onClick={onClose}>Cancel</button>}
        title="New Thread"
        right={<button className="hdr-action" disabled={!title.trim() || !body.trim()}>Send</button>}
      />
      <div className="modal-body">
        <input className="o-input thread-title-input" placeholder="Thread title..."
               value={title} onChange={e => setTitle(e.target.value)} />
        <textarea className="o-input thread-body-input" placeholder="Write something..." rows={6}
                  value={body} onChange={e => setBody(e.target.value)} />
        <div className="composer-thumbs">
          <div className="thumb" style={{ background: '#FFD082' }}><span>📷</span><span className="thumb-x">✕</span></div>
          <div className="thumb" style={{ background: '#A8C8FF' }}><span>📷</span><span className="thumb-x">✕</span></div>
        </div>
        <div className="quota-warn">
          <img src="https://cdn.jsdelivr.net/npm/openmoji@15.1.0/color/svg/26A0.svg" alt="" />
          <span>Storage almost full (85% used)</span>
        </div>
      </div>
      <div className="att-bar">
        <button>📷</button>
        <button>🖼️</button>
        <button>😀</button>
      </div>
    </div>
  );
};

window.ComposerModal = ComposerModal;
