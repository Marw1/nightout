/* Night Out Together group room. */
(function () {
  'use strict';

  var state = JSON.parse(document.getElementById('bootstrap').textContent);
  var code = state.group.code;
  var api = '/api/g/' + code;
  var canViewLocations = Boolean(state.can_view_locations);
  var map = L.map('map', { zoomControl: true, scrollWheelZoom: false });
  var markers = L.layerGroup().addTo(map);
  var draftMarker = null;
  var draft = null;
  var pickMode = null;
  var fitted = false;
  var radius = state.radius_miles;
  var $ = function (id) { return document.getElementById(id); };

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character];
    });
  }

  function toast(message, bad) {
    var element = $('toast');
    element.textContent = message;
    element.className = 'toast' + (bad ? ' bad' : '');
    element.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { element.hidden = true; }, 3800);
  }

  function milesBetween(lat1, lng1, lat2, lng2) {
    var earthRadius = 3958.7613;
    var radians = Math.PI / 180;
    var first = lat1 * radians;
    var second = lat2 * radians;
    var deltaLat = (lat2 - lat1) * radians;
    var deltaLng = (lng2 - lng1) * radians;
    var value = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
      Math.cos(first) * Math.cos(second) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
    return 2 * earthRadius * Math.asin(Math.min(1, Math.sqrt(value)));
  }

  function initials(name) {
    return String(name).trim().split(/\s+/).slice(0, 2).map(function (part) {
      return part.charAt(0);
    }).join('').toUpperCase() || '?';
  }

  function badge(text, className) {
    return L.divIcon({
      className: '',
      html: '<div class="pin-badge ' + (className || '') + '">' + escapeHtml(text) + '</div>',
      iconSize: [26, 26],
      iconAnchor: [13, 13]
    });
  }

  function request(path, body, method) {
    return fetch(api + path, {
      method: method || 'POST',
      headers: {'Content-Type': 'application/json', 'Accept': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.error || 'Something went wrong.');
        return data;
      });
    }).then(function (data) {
      if (data && data.group) { state = data; render(); }
      return data;
    }).catch(function (error) {
      toast(error.message || 'Network error.', true);
      throw error;
    });
  }

  function showTab(name) {
    if (window.innerWidth > 820) return;
    document.querySelectorAll('[data-panel]').forEach(function (panel) {
      panel.classList.toggle('active', panel.dataset.panel === name);
    });
    document.querySelectorAll('#tabbar button').forEach(function (button) {
      button.classList.toggle('active', button.dataset.tab === name);
    });
    if (name === 'map') setTimeout(function () { map.invalidateSize(); }, 60);
  }

  function setPickMode(mode) {
    pickMode = mode;
    $('map').classList.toggle('picking', Boolean(mode));
    $('pickMeBtn').classList.toggle('on', mode === 'me');
    $('spotPickBtn').classList.toggle('on', mode === 'spot');
    if (mode) {
      showTab('map');
      toast(mode === 'me' ? 'Tap the map where you are.' : 'Tap the map on the suggested spot.');
    }
  }

  function drawDraft() {
    if (draftMarker) map.removeLayer(draftMarker);
    draftMarker = null;
    if (draft) {
      draftMarker = L.marker([draft.lat, draft.lng], {icon: badge('*', 'draft picked')})
        .addTo(map).bindPopup('Suggested spot');
    }
  }

  function drawMap() {
    markers.clearLayers();
    if (!canViewLocations && !state.members.some(function (member) { return member.is_admin && member.lat != null; })) return;
    var center = state.center;
    if (center && center.lat != null) {
      var circle = L.circle([center.lat, center.lng], {
        radius: radius * 1609.34, color: '#b47bff', weight: 2,
        fillColor: '#b47bff', fillOpacity: 0.07, dashArray: '6 6'
      }).addTo(markers);
      L.circleMarker([center.lat, center.lng], {
        radius: 5, color: '#fff', weight: 2, fillColor: '#b47bff', fillOpacity: 1
      }).addTo(markers);
      if (!fitted) { map.fitBounds(circle.getBounds().pad(0.08)); fitted = true; }
    }
    state.members.forEach(function (member) {
      if (member.lat == null) return;
      L.marker([member.lat, member.lng], {icon: badge(initials(member.name))}).addTo(markers)
        .bindPopup('<b>' + escapeHtml(member.name) + '</b>' +
          (member.place ? '<br>' + escapeHtml(member.place) : ''));
    });
    if (canViewLocations) {
      state.venues.forEach(function (venue) {
        L.marker([venue.lat, venue.lng], {icon: badge(venue.decided ? '*' : 'V', 'venue')}).addTo(markers)
          .bindPopup('<b>' + escapeHtml(venue.name) + '</b><br>' +
            escapeHtml(venue.note || venue.kind));
      });
    }
    if (draftMarker) draftMarker.bringToFront();
  }

  function voteButton(venue, value, label) {
    return '<button data-vote="' + venue.id + '" data-value="' + value + '"' +
      (venue.my_vote === value ? ' class="on"' : '') + '>' + label + '</button>';
  }

  function venueHtml(venue) {
    var trips = venue.trips.slice(0, 4).map(function (trip) {
      return escapeHtml(trip.name) + ' ' + trip.miles + ' mi';
    }).join(' | ');
    var range = !canViewLocations ? 'Location details are visible to the group admin only' :
      (venue.in_radius ? 'Inside the ' + radius + ' mile circle' : 'Outside the radius');
    return '<article class="venue' + (venue.decided ? ' won' : '') + '">' +
      '<div class="venue-top"><div><span class="kind-tag">' + escapeHtml(venue.kind) + '</span>' +
      '<h3>' + escapeHtml(venue.name) + '</h3><div class="meta">Suggested by ' +
      escapeHtml(venue.proposer) + ' | ' + range + '</div></div><div class="score">' + venue.score + '</div></div>' +
      (venue.note ? '<p class="note">' + escapeHtml(venue.note) + '</p>' : '') +
      '<div class="votes">' + voteButton(venue, 1, 'In') + voteButton(venue, 0, 'Maybe') + voteButton(venue, -1, 'Nah') + '</div>' +
      (trips ? '<div class="voters">Getting there: ' + trips + '</div>' : '') +
      '<div class="venue-actions">' + (canViewLocations ? '<button class="linky" data-show="' + venue.id + '">show on map</button>' : '') +
      (venue.decided ? '' : '<button class="linky" data-lock="' + venue.id + '">lock this in</button>') +
      (venue.mine ? '<button class="linky" data-delete="' + venue.id + '">remove</button>' : '') + '</div></article>';
  }

  function renderMessages() {
    $('messages').innerHTML = state.messages.map(function (message) {
      if (message.system) return '<div class="msg sys">' + escapeHtml(message.body) + '</div>';
      return '<div class="msg' + (message.mine ? ' mine' : '') + '">' +
        (message.mine ? '' : '<span class="who">' + escapeHtml(message.author) + '</span>') +
        escapeHtml(message.body) + '</div>';
    }).join('');
    $('messages').scrollTop = $('messages').scrollHeight;
  }

  function render() {
    var group = state.group;
    var winner = state.venues.find(function (venue) { return venue.decided; });
    var decision = $('decision');
    decision.hidden = !winner;
    decision.innerHTML = winner ? '<span>Locked in:</span> <span class="where">' + escapeHtml(winner.name) +
      '</span><button class="linky" id="reopen">reopen the vote</button>' : '';
    if (winner) $('reopen').onclick = function () { request('/decide', {venue_id: null}); };

    $('crew').innerHTML = state.members.map(function (member) {
      var detail = member.is_admin ? (member.place ? escapeHtml(member.place) : 'admin location shown on map') :
        (member.place ? escapeHtml(member.place) : 'no pin yet');
      return '<li><span class="avatar">' + escapeHtml(initials(member.name)) + '</span><span><span class="who">' +
        escapeHtml(member.name) + (member.is_admin ? ' (admin)' : '') + (member.is_me ? ' (you)' : '') + '</span><span class="sub">' + detail +
        '</span></span><span class="tag ' + escapeHtml(member.status) + '">' + escapeHtml(member.status) + '</span></li>';
    }).join('');
    document.querySelectorAll('.status-picker button').forEach(function (button) {
      button.classList.toggle('on', button.dataset.status === state.me.status);
    });
    if (document.activeElement !== $('planWhen')) $('planWhen').value = group.plan_when || '';
    if (document.activeElement !== $('startDate')) $('startDate').value = group.start_date || '';
    if (document.activeElement !== $('endDate')) $('endDate').value = group.end_date || '';
    $('startDate').disabled = !state.me.is_admin;
    $('endDate').disabled = !state.me.is_admin;
    $('planWhen').disabled = !state.me.is_admin;
    $('planSave').disabled = !state.me.is_admin;
    $('deleteGroupBtn').hidden = !state.me.is_admin;
    $('adminAddressBtn').hidden = !state.me.is_admin;
    $('dateRangeNote').textContent = (group.start_date || 'Open start') + ' to ' + (group.end_date || 'Open end') +
      (state.me.is_admin ? '' : '. Only the admin can change dates.');
    $('myLocLabel').textContent = state.me.lat == null ? 'No pin yet.' : 'Your pin is set' + (state.me.place ? ' (' + state.me.place + ')' : '') + '.';
    if (!canViewLocations) {
      $('mapNote').textContent = 'Admin location shown. Other member locations stay private.';
      $('myLocBtn').hidden = true;
      $('pickMeBtn').hidden = true;
      $('map').setAttribute('aria-hidden', 'true');
    }

    $('venues').innerHTML = state.venues.length ? state.venues.map(venueHtml).join('') : '<div class="empty">No spots yet. Suggest the first one.</div>';
    document.querySelectorAll('[data-vote]').forEach(function (button) {
      button.onclick = function () { request('/vote', {venue_id: Number(button.dataset.vote), value: Number(button.dataset.value)}); };
    });
    document.querySelectorAll('[data-lock]').forEach(function (button) {
      button.onclick = function () { request('/decide', {venue_id: Number(button.dataset.lock)}); };
    });
    document.querySelectorAll('[data-delete]').forEach(function (button) {
      button.onclick = function () { if (confirm('Remove this spot?')) request('/venue/' + button.dataset.delete, undefined, 'DELETE'); };
    });
    document.querySelectorAll('[data-show]').forEach(function (button) {
      button.onclick = function () {
        var venue = state.venues.find(function (item) { return item.id === Number(button.dataset.show); });
        if (venue) { showTab('map'); map.setView([venue.lat, venue.lng], Math.max(map.getZoom(), 14)); }
      };
    });
    renderMessages();
    drawMap();
    $('inviteLink').value = location.origin + '/g/' + code;
  }

  function locate(callback) {
    if (!navigator.geolocation) { toast('Location is unavailable. Pick a point on the map.', true); return; }
    navigator.geolocation.getCurrentPosition(function (position) {
      callback(position.coords.latitude, position.coords.longitude);
    }, function () { toast('Location was not available. Pick a point on the map.', true); },
    {enableHighAccuracy: true, timeout: 10000, maximumAge: 60000});
  }

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
  map.setView([51.5074, -0.1278], 12);
  map.on('click', function (event) {
    if (!pickMode) return;
    if (pickMode === 'me') {
      setPickMode(null);
      request('/me', {lat: event.latlng.lat, lng: event.latlng.lng}).then(function () { toast('Your pin is set.'); });
    } else {
      draft = {lat: event.latlng.lat, lng: event.latlng.lng};
      setPickMode(null); drawDraft(); updatePinState(); showTab('spots');
    }
  });

  function updatePinState() {
    var element = $('spotPinState');
    if (!draft) { element.className = 'pin-state'; element.textContent = 'No pin yet. Pin the spot on the map.'; return; }
    var center = state.center;
    if (!center || center.lat == null) { element.className = 'pin-state ok'; element.textContent = 'Pin set. It will establish the crew centre.'; return; }
    var distance = milesBetween(center.lat, center.lng, draft.lat, draft.lng);
    element.className = distance <= radius ? 'pin-state ok' : 'pin-state bad';
    element.textContent = distance <= radius ? 'Pin set, ' + distance.toFixed(1) + ' miles from the middle.' :
      'That pin is ' + distance.toFixed(1) + ' miles out, beyond the rule.';
  }

  $('newSpotBtn').onclick = function () { $('spotForm').hidden = false; showTab('spots'); $('spotName').focus(); };
  $('spotCancel').onclick = function () { $('spotForm').hidden = true; draft = null; drawDraft(); updatePinState(); setPickMode(null); };
  $('spotPickBtn').onclick = function () { setPickMode(pickMode === 'spot' ? null : 'spot'); };
  $('spotHereBtn').onclick = function () { locate(function (lat, lng) { draft = {lat: lat, lng: lng}; drawDraft(); updatePinState(); }); };
  $('spotForm').onsubmit = function (event) {
    event.preventDefault();
    if (!draft) { toast('Pin the spot on the map first.', true); return; }
    request('/venue', {name: $('spotName').value.trim(), note: $('spotNote').value.trim(), kind: $('spotKind').value, lat: draft.lat, lng: draft.lng})
      .then(function () { $('spotName').value = ''; $('spotNote').value = ''; $('spotForm').hidden = true; draft = null; drawDraft(); updatePinState(); });
  };
  $('myLocBtn').onclick = function () { locate(function (lat, lng) { request('/me', {lat: lat, lng: lng}); }); };
  $('pickMeBtn').onclick = function () { setPickMode(pickMode === 'me' ? null : 'me'); };
  $('adminAddressBtn').onclick = function () {
    var button = $('adminAddressBtn');
    button.disabled = true;
    fetch(api + '/admin-location', {headers: {Accept: 'application/json'}})
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) throw new Error(data.error || 'Address lookup failed.');
          return data;
        });
      })
      .then(function (data) {
        $('adminAddress').hidden = false;
        $('adminAddress').textContent = data.address + ' | Approximate planning window: ' + data.radius_miles + ' miles.';
      })
      .catch(function (error) { toast(error.message, true); })
      .finally(function () { button.disabled = false; });
  };
  document.querySelectorAll('.status-picker button').forEach(function (button) { button.onclick = function () { request('/me', {status: button.dataset.status}); }; });
  $('planSave').onclick = function () {
    request('/plan', {
      when: $('planWhen').value.trim(),
      start_date: $('startDate').value,
      end_date: $('endDate').value
    });
  };
  $('chatForm').onsubmit = function (event) {
    event.preventDefault();
    var input = $('chatInput');
    var message = input.value.trim();
    if (!message) return;
    input.value = '';
    request('/message', {body: message}).catch(function () { input.value = message; });
  };
  function copyInvite() {
    var link = location.origin + '/g/' + code;
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(function () { toast('Invite link copied.'); });
    else prompt('Copy this invite link:', link);
  }
  $('copyLink').onclick = copyInvite;
  $('copyLink2').onclick = copyInvite;
  $('leaveBtn').onclick = function () {
    if (confirm('Leave this crew? Your votes go with you.')) fetch(api + '/leave', {method: 'POST'}).then(function () { location.href = '/'; });
  };
  $('deleteGroupBtn').onclick = function () {
    if (!confirm('Delete this group and all of its activity? This cannot be undone.')) return;
    fetch(api, {method: 'DELETE', headers: {Accept: 'application/json'}})
      .then(function (response) {
        if (!response.ok) return response.json().then(function (data) { throw new Error(data.error || 'Could not delete the group.'); });
        location.href = '/';
      })
      .catch(function (error) { toast(error.message, true); });
  };
  document.querySelectorAll('#tabbar button').forEach(function (button) { button.onclick = function () { showTab(button.dataset.tab); }; });

  var failures = 0;
  function poll() {
    if (document.hidden) return;
    fetch(api + '/state', {headers: {Accept: 'application/json'}}).then(function (response) {
      if (!response.ok) throw new Error('state');
      return response.json();
    }).then(function (data) {
      failures = 0; $('liveDot').textContent = 'live'; state = data; render();
    }).catch(function () {
      failures += 1;
      if (failures > 2) $('liveDot').textContent = 'reconnecting';
    });
  }
  setInterval(poll, 4000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  window.addEventListener('resize', function () { map.invalidateSize(); });
  render();
  updatePinState();
  setTimeout(function () { map.invalidateSize(); }, 200);
}());
