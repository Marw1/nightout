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
      status.textContent = 'This browser will not share a location. You can pin yourself on the map once you are in.';
      done();
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
        done();
      },
      function () {
        btn.textContent = 'ðŸ“ Use my current location';
        btn.disabled = false;
        status.textContent = 'No location this time. Carry on, you can drop your pin on the map afterwards.';
        done();
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  }

  btn.addEventListener('click', function () { locate(function () {}); });
  form.addEventListener('submit', function (event) {
    if (lat.value && lng.value || form.dataset.locationAsked) return;
    event.preventDefault();
    form.dataset.locationAsked = 'true';
    locate(function () { form.requestSubmit(); });
  });
})();
