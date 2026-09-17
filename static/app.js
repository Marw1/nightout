(function () {
  'use strict';
  var key = 'night-out-together-static-v1';
  var read = function () { try { return JSON.parse(localStorage.getItem(key)) || null; } catch (_) { return null; } };
  var code = function () { return Math.random().toString(36).slice(2, 8).toUpperCase(); };
  function render(crew) {
    var panel = document.getElementById('crewPanel'); if (!crew) { panel.hidden = true; return; }
    panel.hidden = false; document.getElementById('crewTitle').textContent = crew.name; document.getElementById('copyCode').textContent = crew.code + ' · copy code';
    document.getElementById('members').innerHTML = crew.members.map(function (m) { return '<li><span class="avatar">' + m[0].toUpperCase() + '</span>' + m + '</li>'; }).join('');
    document.getElementById('ideas').innerHTML = crew.ideas.map(function (x) { return '<li class="msg">' + x.replace(/[&<>]/g, function (c) { return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]; }) + '</li>'; }).join('') || '<li class="empty">No ideas yet. Add the first one.</li>';
  }
  function save(crew) { localStorage.setItem(key, JSON.stringify(crew)); render(crew); }
  document.getElementById('crewForm').addEventListener('submit', function (e) { e.preventDefault(); save({name: document.getElementById('crewName').value.trim(), code: code(), members: [document.getElementById('yourName').value.trim()], ideas: []}); });
  document.getElementById('joinForm').addEventListener('submit', function (e) { e.preventDefault(); var c = read(), msg = document.getElementById('joinMessage'); if (!c || c.code !== document.getElementById('joinCode').value.trim().toUpperCase()) { msg.textContent = 'That code is not available in this browser demo.'; return; } c.members.push(document.getElementById('joinName').value.trim()); save(c); });
  document.getElementById('ideaForm').addEventListener('submit', function (e) { e.preventDefault(); var c = read(); c.ideas.push(document.getElementById('idea').value.trim()); document.getElementById('idea').value = ''; save(c); });
  document.getElementById('copyCode').addEventListener('click', function () { var c = read(); if (c && navigator.clipboard) navigator.clipboard.writeText(c.code); });
  document.getElementById('resetCrew').addEventListener('click', function () { localStorage.removeItem(key); render(null); });
  render(read());
}());
