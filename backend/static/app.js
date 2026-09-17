// Landing and join pages: one button that fills the hidden lat/lng fields.
(function () {
  var btn = document.getElementById('locBtn');
  if (!btn) return;
  var form = btn.form;
  var status = document.getElementById('locStatus');
  var lat = document.getElementById(btn.dataset.lat);
  var lng = document.getElementById(btn.dataset.lng);

  function locate(done) {
    if (!navigator.geolocation) {
      status.textContent = 'Location permission is required. Enable location in your browser and try again.';
      done(false);
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
        status.textContent = 'Location set. You are inside the crew planning window.';
        done(true);
      },
      function () {
        btn.textContent = 'ðŸ“ Use my current location';
        btn.disabled = false;
        status.textContent = 'Location permission is required. Allow it in your browser and try again.';
        done(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  btn.addEventListener('click', function () { locate(function () {}); });
  form.addEventListener('submit', function (event) {
    if (lat.value && lng.value || form.dataset.locationAsked) return;
    event.preventDefault();
    form.dataset.locationAsked = 'true';
    locate(function (locationGranted) {
      if (locationGranted) form.requestSubmit();
      else delete form.dataset.locationAsked;
    });
  });
})();
