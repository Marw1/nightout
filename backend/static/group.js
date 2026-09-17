/* Night Out Together group room, without an external map service. */
(function () {
  'use strict';

  var state = JSON.parse(document.getElementById('bootstrap').textContent);
  var code = state.group.code;
  var api = '/api/g/' + code;
  var canViewLocations = Boolean(state.can_view_locations);
  var radius = state.radius_miles;
  var draft = null;
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

  function initials(name) {
    return String(name).trim().split(/\s+/).slice(0, 2).map(function (part) {
      return part.charAt(0);
    }).join('').toUpperCase() || '?';
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
  }

  function locate(callback) {
    if (!navigator.geolocation) {
      toast('Location is unavailable in this browser.', true);
      return;
    }
    toast('Requesting your location...');
    navigator.geolocation.getCurrentPosition(function (position) {
      callback(position.coords.latitude, position.coords.longitude);
    }, function () {
      toast('Location was not shared. Check browser permissions or enter a place name.', true);
    }, {enableHighAccuracy: true, timeout: 10000, maximumAge: 60000});
  }

  function updateLocationSummary() {
    var center = state.center;
    var locations = state.members.filter(function (member) { return member.lat != null; }).length;
    if (canViewLocations && center && center.lat != null) {
      $('locationSummaryText').textContent = locations + ' location' + (locations === 1 ? '' : 's') +
        ' shared. All suggestions must stay within ' + radius + ' miles of the crew centre.';
    } else {
      var admin = state.members.some(function (member) { return member.is_admin && member.lat != null; });
      $('locationSummaryText').textContent = admin
        ? 'The admin location is shared. Other member locations remain private.'
        : 'The admin has not shared a location yet.';
    }
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

  function voteButton(venue, value, label) {
    return '<button data-vote="' + venue.id + '" data-value="' + value + '"' +
      (venue.my_vote === value ? ' class="on"' : '') + '>' + label + '</button>';
  }

  function venueHtml(venue) {
    var range = !canViewLocations ? 'Location details are visible to the group admin only' :
      (venue.in_radius ? 'Inside the ' + radius + ' mile window' : 'Outside the radius');
    return '<article class="venue' + (venue.decided ? ' won' : '') + '">' +
      '<div class="venue-top"><div><span class="kind-tag">' + escapeHtml(venue.kind) + '</span>' +
      '<h3>' + escapeHtml(venue.name) + '</h3><div class="meta">Suggested by ' +
      escapeHtml(venue.proposer) + ' | ' + range + '</div></div><div class="score">' + venue.score + '</div></div>' +
      (venue.note ? '<p class="note">' + escapeHtml(venue.note) + '</p>' : '') +
      '<div class="votes">' + voteButton(venue, 1, 'In') + voteButton(venue, 0, 'Maybe') + voteButton(venue, -1, 'Nah') + '</div>' +
      '<div class="venue-actions">' +
      (venue.decided ? '' : '<button class="linky" data-lock="' + venue.id + '">lock this in</button>') +
      (venue.mine ? '<button class="linky" data-delete="' + venue.id + '">remove</button>' : '') + '</div></article>';
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
      var detail = member.is_admin ? (member.place ? escapeHtml(member.place) : 'admin location shared') :
        (member.place ? escapeHtml(member.place) : 'location private');
      var canShow = member.lat != null && (state.me.is_admin || member.is_admin);
      return '<li><span class="avatar">' + escapeHtml(initials(member.name)) + '</span><span><span class="who">' +
        escapeHtml(member.name) + (member.is_admin ? ' (admin)' : '') + (member.is_me ? ' (you)' : '') +
        '</span><span class="sub">' + detail + '</span>' + (canShow ? '<button class="linky location-button" data-show-member="' + member.id + '">Show location</button>' : '') +
        '</span><span class="tag ' + escapeHtml(member.status) + '">' +
        escapeHtml(member.status) + '</span></li>';
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
    $('myLocLabel').textContent = state.me.lat == null ? 'No pin yet.' : 'Your location is shared.';
    if (!canViewLocations) $('locationNote').textContent = 'Admin location shown. Other member locations stay private.';

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
    document.querySelectorAll('[data-show-member]').forEach(function (button) {
      button.onclick = function () {
        var member = state.members.find(function (item) { return item.id === Number(button.dataset.showMember); });
        if (!member || member.lat == null) return;
        $('locationSummaryText').textContent = member.name + ': approximate location ' +
          Number(member.lat).toFixed(2) + ', ' + Number(member.lng).toFixed(2) + '. Within the ' + radius + '-mile planning window.';
      };
    });
    renderMessages();
    updateLocationSummary();
    $('inviteLink').value = location.origin + '/g/' + code;
  }

  $('newSpotBtn').onclick = function () { $('spotForm').hidden = false; showTab('spots'); $('spotName').focus(); };
  $('showAdminLocationBtn').onclick = function () {
    var admin = state.members.find(function (member) { return member.is_admin && member.lat != null; });
    if (!admin) { toast('The admin has not shared a location yet.', true); return; }
    $('locationSummaryText').textContent = 'Admin approximate location: ' + Number(admin.lat).toFixed(2) + ', ' +
      Number(admin.lng).toFixed(2) + '. The admin location is shared with the crew.';
  };
  $('spotCancel').onclick = function () { $('spotForm').hidden = true; draft = null; updatePinState(); };
  $('spotHereBtn').onclick = function () {
    locate(function (lat, lng) { draft = {lat: lat, lng: lng}; updatePinState(); });
  };
  function updatePinState() {
    var element = $('spotPinState');
    if (!draft) { element.className = 'pin-state'; element.textContent = 'Use your location to check the ' + radius + ' mile rule.'; return; }
    var center = state.center;
    if (!center || center.lat == null) { element.className = 'pin-state ok'; element.textContent = 'Location captured. It will establish the crew centre.'; return; }
    var distance = milesBetween(center.lat, center.lng, draft.lat, draft.lng);
    element.className = distance <= radius ? 'pin-state ok' : 'pin-state bad';
    element.textContent = distance <= radius ? 'Location captured, ' + distance.toFixed(1) + ' miles from the crew centre.' :
      'That location is ' + distance.toFixed(1) + ' miles outside the ' + radius + '-mile window.';
  }
  $('spotForm').onsubmit = function (event) {
    event.preventDefault();
    if (!draft) { toast('Use your location before adding a spot.', true); return; }
    request('/venue', {name: $('spotName').value.trim(), note: $('spotNote').value.trim(), kind: $('spotKind').value, lat: draft.lat, lng: draft.lng})
      .then(function () { $('spotName').value = ''; $('spotNote').value = ''; $('spotForm').hidden = true; draft = null; updatePinState(); });
  };
  $('myLocBtn').onclick = function () { locate(function (lat, lng) { request('/me', {lat: lat, lng: lng}); }); };
  $('adminAddressBtn').onclick = function () {
    var button = $('adminAddressBtn');
    button.disabled = true;
    fetch(api + '/admin-location', {headers: {Accept: 'application/json'}}).then(function (response) {
      return response.json().then(function (data) {
        if (!response.ok) throw new Error(data.error || 'Address lookup failed.');
        return data;
      });
    }).then(function (data) {
      $('adminAddress').hidden = false;
      $('adminAddress').textContent = data.address + ' | Approximate planning window: ' + data.radius_miles + ' miles.';
    }).catch(function (error) { toast(error.message, true); }).finally(function () { button.disabled = false; });
  };
  document.querySelectorAll('.status-picker button').forEach(function (button) { button.onclick = function () { request('/me', {status: button.dataset.status}); }; });
  $('planSave').onclick = function () { request('/plan', {when: $('planWhen').value.trim(), start_date: $('startDate').value, end_date: $('endDate').value}); };
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
    fetch(api, {method: 'DELETE', headers: {Accept: 'application/json'}}).then(function (response) {
      if (!response.ok) return response.json().then(function (data) { throw new Error(data.error || 'Could not delete the group.'); });
      location.href = '/';
    }).catch(function (error) { toast(error.message, true); });
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
  render();
  updatePinState();
}());
