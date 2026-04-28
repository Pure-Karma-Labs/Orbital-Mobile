// Inbox screen — orbit selector header, search, day-grouped thread list.

const ThreadItem = ({ title, author, time, replies, hasMedia, state = 'read', unread, onClick }) => (
  <button className={`thread-item is-${state}`} onClick={onClick}>
    <div className="ti-main">
      <div className="ti-title">{title}</div>
      <div className="ti-meta">
        {author} · {time} · {replies} 💬{hasMedia ? ' 📷' : ''}
      </div>
    </div>
    {unread > 0 && <span className="o-badge">{unread}</span>}
  </button>
);

const InboxScreen = ({ orbit, onOpenOrbits, onOpenThread, onCompose }) => (
  <div className="inbox">
    <div className="orbit-bar" onClick={onOpenOrbits}>
      <span className="orbit-name">{orbit} ▾</span>
      <button className="hdr-action" onClick={(e) => { e.stopPropagation(); onCompose(); }}>+</button>
    </div>

    <div className="search-bar">
      <span className="search-ico">🔍</span>
      <span className="search-ph">Search threads...</span>
    </div>

    <div className="inbox-scroll">
      <AsciiDay label="Today" />
      <ThreadItem state="active" title="Farmer's market on Saturday?" author="Mom" time="2:45 PM" replies={3} onClick={() => onOpenThread('market')} />
      <ThreadItem state="unread" title="New family photos from the trip" author="Sarah" time="1:20 PM" replies={7} hasMedia unread={3} onClick={() => onOpenThread('photos')} />
      <ThreadItem state="read"   title="Quick reminder about Sunday dinner" author="Dad" time="12:10 PM" replies={1} onClick={() => onOpenThread('dinner')} />

      <AsciiDay label="Yesterday" />
      <ThreadItem state="read" title="Mom's birthday plans — ideas?" author="Alex" time="11:00 AM" replies={12} onClick={() => onOpenThread('bday')} />
      <ThreadItem state="read" title="Recipe: Grandma's apple pie" author="Sarah" time="9:15 AM" replies={5} hasMedia onClick={() => onOpenThread('pie')} />

      <AsciiSection />

      <AsciiDay label="Apr 24" />
      <ThreadItem state="read" title="House paint colors — vote!" author="Dad" time="6:40 PM" replies={9} hasMedia onClick={() => onOpenThread('paint')} />
    </div>
  </div>
);

Object.assign(window, { InboxScreen, ThreadItem });
