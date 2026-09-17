// Landing and join pages: one button that fills the hidden lat/lng fields.
(function () {
  var btn = document.getElementById('locBtn');
  if (!btn) return;
  var status = document.getElementById('locStatus');
  var lat = document.getElementById(btn.dataset.lat);
  var lng = document.getElementById(btn.dataset.lng);

  btn.addEventListener('click', function () {
    if (!navigator.geolocation) {
      status.textContent = 'This browser will not share a location. You can pin yourself on the map once you are in.';
      return;
    }
    btn.textContent = 'Finding you...';
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      function (pos) {
        lat.value = pos.coords.latitude.toFixed(6);
        lng.value = pos.coords.longitude.toFixed(6);
        btn.textContent = 'âœ“ Location set';
        btn.classList.add('done');
        btn.disabled = false;
        status.textContent = 'Got it. You are on the crew map.';
      },
      function () {
        btn.textContent = 'ðŸ“ Use my current location';
        btn.disabled = false;
        status.textContent = 'No location this time. Carry on, you can drop your pin on the map afterwards.';
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
})();
