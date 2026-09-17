/* Night Out Together â€” crew room. Polls the API, redraws the map, votes. */
(function () {
  'use strict';

  var state = JSON.parse(document.getElementById('bootstrap').textContent);
  var CODE = state.group.code;
  var RADIUS = state.radius_miles;
  var API = '/api/g/'  CODE;

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var initials = function (name) {
    var parts = String(name).trim().split(/\s/).slice(0, 2);
    return parts.map(function (p) { return p[0] || ''; }).join('').toUpperCase() || '?';
  };

  function toast(msg, bad) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast'  (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 3800);
  }

  function milesBetween(a, b, c, d) {
    var R = 3958.7613, r = Math.PI / 180;
    var p1 = a * r, p2 = c * r, dp = (c - a) * r, dl = (d - b) * r;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) 
      Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function send(path, body, method) {
    return fetch(API  path, {
      method: method || 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error((data && data.error) || 'Something went wrong.');
        return data;
      });
    }).then(function (data) {
      if (data && data.group) { state = data; render(); }
      return data;
    }).catch(function (err) {
      toast(err.message || 'Network hiccup.', true);
      throw err;
    });
  }

  /* ------------------------------------------------------------ map */
  var map = L.map('map', { zoomControl: true, scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  map.setView([51.5074, -0.1278], 12);

  var layer = L.layerGroup().addTo(map);
  var draftMarker = null;
  var fitted = false;
  var pickMode = null;      // 'me' | 'spot' | null
  var draft = null;         // {lat,lng} for a new spot

  function badge(text, cls) {
    return L.divIcon({
      className: '',
      html: '<div class="pin-badge '  (cls || '')  '">'  esc(text)  '</div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
  }

  function setPickMode(mode) {
    pickMode = mode;
    $('map').classList.toggle('picking', !!mode);
    $('pickMeBtn').classList.toggle('on', mode === 'me');
    $('spotPickBtn').classList.toggle('on', mode === 'spot');
    if (mode) {
      showTab('map');
      toast(mode === 'me' ? 'Tap the map where you are starting from.' : 'Tap the map on the spot you are suggesting.');
    }
  }

  map.on('click', function (e) {
    if (!pickMode) return;
    var lat = e.latlng.lat, lng = e.latlng.lng;
    if (pickMode === 'me') {
      setPickMode(null);
      send('/me', { lat: lat, lng: lng }).then(function () { toast('Your pin is set.'); });
    } else {
      draft = { lat: lat, lng: lng };
      setPickMode(null);
      drawDraft();
      updatePinState();
      showTab('spots');
    }
  });

  function drawDraft() {
    if (draftMarker) { map.removeLayer(draftMarker); draftMarker = null; }
    if (!draft) return;
    draftMarker = L.marker([draft.lat, draft.lng], { icon: badge('â˜…', 'draft picked') })
      .addTo(map).bindPopup('Your new suggestion goes here');
  }

  function drawMap() {
    layer.clearLayers();
    var c = state.center;
    if (c && c.lat != null) {
      var circle = L.circle([c.lat, c.lng], {
        radius: RADIUS * 1609.34,
        color: '#b47bff', weight: 2, fillColor: '#b47bff', fillOpacity: 0.07, dashArray: '6 6'
      }).addTo(layer);
      L.circleMarker([c.lat, c.lng], {
        radius: 5, color: '#fff', weight: 2, fillColor: '#b47bff', fillOpacity: 1
      }).addTo(layer).bindPopup('Middle of the crew. The circle is '  RADIUS  ' miles wide from here.');
      if (!fitted) { map.fitBounds(circle.getBounds().pad(0.08)); fitted = true; }
    }
    state.members.forEach(function (m) {
      if (m.lat == null) return;
      L.marker([m.lat, m.lng], { icon: badge(initials(m.name)) })
        .addTo(layer)
        .bindPopup('<b>'  esc(m.name)  '</b>'  (m.place ? '<br>'  esc(m.place) : '') 
          (m.miles_from_center != null ? '<br>'  m.miles_from_center  ' mi from the middle' : ''));
    });
    state.venues.forEach(function (v) {
      L.marker([v.lat, v.lng], { icon: badge(v.decided ? 'âœ“' : 'ðŸ¸', 'venue') })
        .addTo(layer)
        .bindPopup('<b>'  esc(v.name)  '</b><br>'  esc(v.note || v.kind) 
          '<br>'  (v.miles_from_center != null ? v.miles_from_center  ' mi from the middle' : '') 
          '<br>ðŸ‘ '  v.yes.length  ' Â· ðŸ¤” '  v.maybe.length  ' Â· ðŸ‘Ž '  v.no.length);
    });
    if (draftMarker) draftMarker.bringToFront();
  }

  /* --------------------------------------------------------- render */
  function render() {
    var g = state.group;

    // decision banner
    var dec = $('decision');
    var won = state.venues.filter(function (v) { return v.decided; })[0];
    if (won) {
      dec.hidden = false;
      dec.innerHTML = '<span>ðŸŽ‰ Locked in:</span> <span class="where">'  esc(won.name)  '</span>' 
        (g.plan_when ? '<span class="muted small">'  esc(g.plan_when)  '</span>' : '') 
        '<button class="linky" id="reopen">reopen the vote</button>';
      $('reopen').onclick = function () { send('/decide', { venue_id: null }); };
    } else {
      dec.hidden = true;
      dec.innerHTML = '';
    }

    // crew
    var crew = $('crew');
    crew.innerHTML = state.members.map(function (m) {
      var sub = [];
      if (m.place) sub.push(esc(m.place));
      if (m.miles_from_center != null) sub.push(m.miles_from_center  ' mi from the middle');
      else sub.push('no pin yet');
      return '<li><span class="avatar">'  esc(initials(m.name))  '</span>' 
        '<span><span class="who">'  esc(m.name)  (m.is_me ? ' (you)' : '')  '</span>' 
        '<span class="sub'  (m.far ? ' warn' : '')  '">'  sub.join(' Â· ') 
        (m.far ? ' âš  outside the circle' : '')  '</span></span>' 
        '<span class="tag '  esc(m.status)  '">'  esc(m.status)  '</span></li>';
    }).join('');

    Array.prototype.forEach.call(document.querySelectorAll('.status-picker button'), function (b) {
      b.classList.toggle('on', b.dataset.status === state.me.status);
    });

    var when = $('planWhen');
    if (document.activeElement !== when) when.value = g.plan_when || '';

    var label = $('myLocLabel');
    label.textContent = state.me.lat == null
      ? 'You have no pin yet.'
      : 'Your pin is set'  (state.me.place ? ' ('  state.me.place  ')' : '')  '.';

    // venues
    var box = $('venues');
    if (!state.venues.length) {
      box.innerHTML = '<div class="empty">Nothing on the list yet. Hit <b>suggest a spot</b> and pin the first bar.</div>';
    } else {
      box.innerHTML = state.venues.map(venueHtml).join('');
      Array.prototype.forEach.call(box.querySelectorAll('.votes button'), function (b) {
        b.onclick = function () {
          send('/vote', { venue_id: Number(b.dataset.id), value: Number(b.dataset.v) });
        };
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-lock]'), function (b) {
        b.onclick = function () { send('/decide', { venue_id: Number(b.dataset.lock) }); };
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function (b) {
        b.onclick = function () {
          if (confirm('Remove this spot from the list?')) send('/venue/'  b.dataset.del, undefined, 'DELETE');
        };
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-show]'), function (b) {
        b.onclick = function () {
          var v = state.venues.filter(function (x) { return x.id === Number(b.dataset.show); })[0];
          if (!v) return;
          showTab('map');
          map.setView([v.lat, v.lng], Math.max(map.getZoom(), 14));
        };
      });
    }

    renderMessages();
    drawMap();
    var link = location.origin  '/g/'  CODE;
    $('inviteLink').value = link;
  }

  function venueHtml(v) {
    var cls = 'venue'  (v.decided ? ' won' : '')  (v.in_radius ? '' : ' out');
    var trips = v.trips.slice(0, 4).map(function (t) {
      return esc(t.name)  ' '  t.miles  ' mi';
    }).join(' Â· ');
    var range = v.in_radius
      ? '<span style="color:var(--good)">inside the '  RADIUS  ' mile circle</span>'
      : '<span style="color:var(--bad)">âš  now '  (v.miles_from_center != null ? v.miles_from_center : '?') 
        ' mi out, past the '  RADIUS  ' mile rule</span>';
    return '<article class="'  cls  '">' 
      '<div class="venue-top"><div>' 
        '<span class="kind-tag">'  esc(v.kind)  '</span>' 
        '<h3>'  esc(v.name)  '</h3>' 
        '<div class="meta">suggested by '  esc(v.proposer) 
          (v.miles_from_center != null ? ' Â· '  v.miles_from_center  ' mi from the middle' : '') 
          (v.furthest_member_miles != null ? ' Â· furthest friend '  v.furthest_member_miles  ' mi' : '') 
        '</div></div>' 
        '<div class="score">'  (v.score > 0 ? '' : '')  v.score  '</div>' 
      '</div>' 
      (v.note ? '<p class="note">'  esc(v.note)  '</p>' : '') 
      '<div class="meta">'  range  '</div>' 
      '<div class="votes">' 
        voteBtn(v, 1, 'ðŸ‘ In')  voteBtn(v, 0, 'ðŸ¤” Maybe')  voteBtn(v, -1, 'ðŸ‘Ž Nah') 
      '</div>' 
      (trips ? '<div class="voters">Getting there: '  trips  (v.trips.length > 4 ? ' â€¦' : '')  '</div>' : '') 
      (v.yes.length ? '<div class="voters"><b>Up for it:</b> '  esc(v.yes.join(', '))  '</div>' : '') 
      (v.no.length ? '<div class="voters"><b>Not keen:</b> '  esc(v.no.join(', '))  '</div>' : '') 
      '<div class="venue-actions">' 
        '<button class="linky" data-show="'  v.id  '">show on map</button>' 
        (v.decided ? '' : '<button class="linky" data-lock="'  v.id  '">lock this in</button>') 
        (v.mine ? '<button class="linky" data-del="'  v.id  '">remove</button>' : '') 
      '</div></article>';
  }

  function voteBtn(v, value, label) {
    return '<button data-id="'  v.id  '" data-v="'  value  '"' 
      (v.my_vote === value ? ' class="on"' : '')  '>'  label  '</button>';
  }

  function renderMessages() {
    var box = $('messages');
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    var last = box.dataset.last || '';
    var newest = state.messages.length ? String(state.messages[state.messages.length - 1].id) : '';
    if (last === newest && box.childNodes.length) return;
    box.dataset.last = newest;
    box.innerHTML = state.messages.map(function (m) {
      if (m.system) return '<div class="msg sys">'  esc(m.body)  '</div>';
      return '<div class="msg'  (m.mine ? ' mine' : '')  '">' 
        (m.mine ? '' : '<span class="who">'  esc(m.author)  '</span>') 
        esc(m.body)  '</div>';
    }).join('');
    if (atBottom || !last) box.scrollTop = box.scrollHeight;
  }

  /* ----------------------------------------------------- spot form */
  function updatePinState() {
    var el = $('spotPinState');
    if (!draft) {
      el.className = 'pin-state';
      el.textContent = 'No pin yet. The spot needs a location so we can check the '  RADIUS  ' mile rule.';
      return;
    }
    var c = state.center;
    if (!c || c.lat == null) {
      el.className = 'pin-state ok';
      el.textContent = 'Pin set. Nobody has shared a location yet, so this one sets the crew centre.';
      return;
    }
    var d = milesBetween(c.lat, c.lng, draft.lat, draft.lng);
    if (d <= RADIUS) {
      el.className = 'pin-state ok';
      el.textContent = 'âœ“ Pin set, '  d.toFixed(1)  ' miles from the middle of the crew. Inside the circle.';
    } else {
      el.className = 'pin-state bad';
      el.textContent = 'âœ— That pin is '  d.toFixed(1)  ' miles out. The rule is '  RADIUS  ' miles, so it will be refused.';
    }
  }

  $('newSpotBtn').onclick = function () {
    var f = $('spotForm');
    f.hidden = !f.hidden;
    if (!f.hidden) { showTab('spots'); $('spotName').focus(); }
  };
  $('spotCancel').onclick = function () {
    $('spotForm').hidden = true;
    draft = null; drawDraft(); updatePinState(); setPickMode(null);
  };
  $('spotPickBtn').onclick = function () { setPickMode(pickMode === 'spot' ? null : 'spot'); };
  $('spotHereBtn').onclick = function () {
    locate(function (lat, lng) { draft = { lat: lat, lng: lng }; drawDraft(); updatePinState(); });
  };

  $('spotForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = $('spotName').value.trim();
    if (!name) { toast('Give the spot a name.', true); return; }
    if (!draft) { toast('Pin the spot on the map first.', true); return; }
    send('/venue', {
      name: name,
      note: $('spotNote').value.trim(),
      kind: $('spotKind').value,
      lat: draft.lat, lng: draft.lng
    }).then(function () {
      $('spotName').value = ''; $('spotNote').value = '';
      draft = null; drawDraft(); updatePinState();
      $('spotForm').hidden = true;
      toast('Added. Now get them to vote.');
    }).catch(function () { });
  });

  /* ------------------------------------------------------ my stuff */
  function locate(cb) {
    if (!navigator.geolocation) { toast('This browser will not share a location. Pick it on the map instead.', true); return; }
    toast('Finding you...');
    navigator.geolocation.getCurrentPosition(
      function (p) { cb(p.coords.latitude, p.coords.longitude); },
      function () { toast('No location from the browser. Tap the map instead.', true); },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  $('myLocBtn').onclick = function () {
    locate(function (lat, lng) {
      send('/me', { lat: lat, lng: lng }).then(function () { toast('Your pin is set.'); });
    });
  };
  $('pickMeBtn').onclick = function () { setPickMode(pickMode === 'me' ? null : 'me'); };

  Array.prototype.forEach.call(document.querySelectorAll('.status-picker button'), function (b) {
    b.onclick = function () { send('/me', { status: b.dataset.status }); };
  });

  $('planSave').onclick = function () { send('/plan', { when: $('planWhen').value.trim() }); };
  $('planWhen').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); $('planSave').click(); }
  });

  $('chatForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('chatInput');
    var body = input.value.trim();
    if (!body) return;
    input.value = '';
    send('/message', { body: body }).catch(function () { input.value = body; });
  });

  function copyLink() {
    var link = location.origin  '/g/'  CODE;
    var done = function () { toast('Invite link copied. Paste it in the group chat.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, function () { prompt('Copy this link:', link); });
    } else {
      prompt('Copy this link:', link);
    }
  }
  $('copyLink').onclick = copyLink;
  $('copyLink2').onclick = copyLink;

  $('leaveBtn').onclick = function () {
    if (!confirm('Leave this crew? Your votes go with you.')) return;
    fetch(API  '/leave', { method: 'POST' }).then(function () { location.href = '/'; });
  };

  /* ----------------------------------------------------------- tabs */
  function showTab(name) {
    if (window.innerWidth > 820) return;
    Array.prototype.forEach.call(document.querySelectorAll('[data-panel]'), function (p) {
      p.classList.toggle('active', p.dataset.panel === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#tabbar button'), function (b) {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    if (name === 'map') setTimeout(function () { map.invalidateSize(); }, 60);
    if (name === 'chat') { var m = $('messages'); m.scrollTop = m.scrollHeight; }
  }
  Array.prototype.forEach.call(document.querySelectorAll('#tabbar button'), function (b) {
    b.onclick = function () { showTab(b.dataset.tab); };
  });

  /* ---------------------------------------------------------- poll */
  var failures = 0;
  function poll() {
    if (document.hidden) return;
    fetch(API  '/state', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('state'); return r.json(); })
      .then(function (data) {
        failures = 0;
        $('liveDot').textContent = 'live';
        if (JSON.stringify(data) !== JSON.stringify(state)) { state = data; render(); }
      })
      .catch(function () {
        failures;
        if (failures > 2) $('liveDot').textContent = 'reconnecting';
      });
  }
  setInterval(poll, 4000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  window.addEventListener('resize', function () {
    if (window.innerWidth > 820) {
      Array.prototype.forEach.call(document.querySelectorAll('[data-panel]'), function (p) {
        p.classList.remove('active');
      });
      document.querySelector('[data-panel="map"]').classList.add('active');
    }
    map.invalidateSize();
  });

  render();
  updatePinState();
  setTimeout(function () { map.invalidateSize(); }, 200);
})();
