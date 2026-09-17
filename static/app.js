(function () {
  'use strict';
  var key = 'night-out-together-static-v2';
  var read = function () {
    try { return JSON.parse(localStorage.getItem(key)) || null; } catch (_) { return null; }
  };
  var makeCode = function () { return Math.random().toString(36).slice(2, 8).toUpperCase(); };
  var escapeHtml = function (value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character];
    });
  };
  function render(crew) {
    var panel = document.getElementById('crewPanel');
    if (!crew) { panel.hidden = true; return; }
    panel.hidden = false;
    document.getElementById('crewTitle').textContent = crew.name;
    document.getElementById('copyCode').textContent = crew.code + ' · copy code';
    document.getElementById('members').innerHTML = crew.members.map(function (member) {
      return '<li><span class="avatar">' + escapeHtml(member.charAt(0).toUpperCase()) + '</span>' + escapeHtml(member) + '</li>';
    }).join('');
    document.getElementById('ideas').innerHTML = crew.ideas.map(function (idea) {
      return '<li class="msg">' + escapeHtml(idea) + '</li>';
    }).join('') || '<li class="empty">No ideas yet. Add the first one.</li>';
  }
  function save(crew) { localStorage.setItem(key, JSON.stringify(crew)); render(crew); }
  document.getElementById('crewForm').addEventListener('submit', function (event) {
    event.preventDefault();
    save({name: document.getElementById('crewName').value.trim(), code: makeCode(), members: [document.getElementById('yourName').value.trim()], ideas: []});
  });
  document.getElementById('ideaForm').addEventListener('submit', function (event) {
    event.preventDefault();
    var crew = read();
    if (!crew) return;
    crew.ideas.push(document.getElementById('idea').value.trim());
    document.getElementById('idea').value = '';
    save(crew);
  });
  document.getElementById('copyCode').addEventListener('click', function () {
    var crew = read();
    if (crew && navigator.clipboard) navigator.clipboard.writeText(crew.code);
  });
  document.getElementById('resetCrew').addEventListener('click', function () {
    localStorage.removeItem(key);
    render(null);
  });
  render(read());
}());
