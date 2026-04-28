// Thread Detail — original post + nested replies showing depth color system.

const Message = ({ depth = 0, author, time, body, replyTo, photos = [] }) => {
  const indent = Math.min(depth, 4) * 24;
  const klass = `msg msg-l${Math.min(depth, 4)}`;
  return (
    <div className={klass} style={{ marginLeft: indent }}>
      {replyTo && <div className="msg-ctx">↳ Replying to {replyTo}</div>}
      <div className="msg-head">
        <span className="msg-author">{author}</span>
        <span className="msg-ts">{time}</span>
      </div>
      <div className="msg-body">{body}</div>
      {photos.length > 0 && (
        <div className={`msg-photos g-${Math.min(photos.length, 4)}`}>
          {photos.slice(0, 4).map((p, i) => (
            <div key={i} className="photo-tile" style={{ background: p }}>
              <span className="photo-ico">📷</span>
              {photos.length > 4 && i === 3 && <span className="photo-more">+{photos.length - 3}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const ThreadDetail = ({ onBack, title }) => {
  const [draft, setDraft] = React.useState('');
  return (
    <div className="thread-screen">
      <Header
        left={<BackButton onClick={onBack} />}
        title={<span className="thread-title">{title}</span>}
        right={<span style={{ width: 44 }} />}
      />
      <div className="thread-scroll">
        <Message depth={0} author="Mom" time="10:30 AM"
          body="Has anyone tried the new farmer's market on Oak Street? Thinking of going this Saturday."
        />
        <Message depth={1} author="Sarah" time="10:45 AM" replyTo="Mom"
          body="Yes! The honey vendor is amazing. Get the wildflower variety — total game changer for tea."
        />
        <Message depth={2} author="Mom" time="11:02 AM" replyTo="Sarah"
          body="Good call, I'll add it to the list. How's parking?"
        />
        <Message depth={3} author="Alex" time="11:15 AM" replyTo="Mom"
          body="Street parking on Elm is free on weekends. Get there before 10 — fills up fast."
        />
        <Message depth={2} author="Dad" time="11:30 AM" replyTo="Mom"
          body="They also have fresh bread on Saturdays only — sourdough goes by 11."
          photos={['#FFD082', '#A8C8FF']}
        />
        <Message depth={1} author="Alex" time="12:02 PM" replyTo="Mom"
          body="I'll come with you ✦"
        />
      </div>
      <ReplyComposer value={draft} onChange={setDraft} replyingTo="Mom" />
    </div>
  );
};

const ReplyComposer = ({ value, onChange, replyingTo }) => (
  <div className="rcomp">
    {replyingTo && (
      <div className="rcomp-ctx">
        <span>Replying to <b>{replyingTo}</b></span>
        <span className="rcomp-x">✕</span>
      </div>
    )}
    <div className="rcomp-row">
      <button className="rcomp-attach">📎</button>
      <input className="rcomp-input" placeholder="Type a reply..." value={value} onChange={e => onChange(e.target.value)} />
      <button className={`rcomp-send ${value.trim() ? 'is-active' : ''}`} disabled={!value.trim()}>Send</button>
    </div>
  </div>
);

Object.assign(window, { ThreadDetail, Message, ReplyComposer });
